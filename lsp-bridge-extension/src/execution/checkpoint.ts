import * as vscode from 'vscode';

// Backs the workflow-level Keep vs Undo (execution-v2.md §7). Before any op edits a
// file, the engine records that file's ORIGINAL bytes here (once). "Undo all" then
// restores every recorded file to its pre-run content — or deletes it if it did not
// exist before the run. This reverts only the files the run actually touched, so it
// is safe in a dirty tree and never clobbers unrelated edits. Uses vscode.workspace.fs
// so it works the same locally and over Remote/WSL, with no git dependency.
//
// (We prefer this over a `git stash` snapshot: it needs no clean tree, no git
// subprocess, and captures cross-file edits — e.g. a rename provider touching many
// files — because capture is driven by exactly the files each op declares it will edit.)
export class WorkspaceCheckpoint {
  // path → original bytes, or null when the file did not exist before the run.
  private readonly originals = new Map<string, Uint8Array | null>();

  get size(): number {
    return this.originals.size;
  }

  // Record the pre-edit content of any not-yet-seen file. Call this immediately
  // before applying an edit that touches `files`.
  async capture(files: string[]): Promise<void> {
    for (const fsPath of files) {
      if (this.originals.has(fsPath)) continue;
      const uri = vscode.Uri.file(fsPath);
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        this.originals.set(fsPath, bytes);
      } catch {
        this.originals.set(fsPath, null); // did not exist yet
      }
    }
  }

  // Restore every captured file to its pre-run state. Best-effort per file so one
  // failure doesn't strand the rest.
  async restore(): Promise<{ restored: number; failed: number }> {
    let restored = 0;
    let failed = 0;
    for (const [fsPath, bytes] of this.originals) {
      const uri = vscode.Uri.file(fsPath);
      try {
        if (bytes === null) {
          await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
        } else {
          await vscode.workspace.fs.writeFile(uri, bytes);
        }
        restored++;
      } catch {
        failed++;
      }
    }
    return { restored, failed };
  }
}
