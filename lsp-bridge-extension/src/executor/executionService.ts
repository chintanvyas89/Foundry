import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceCheckpoint } from '../execution/checkpoint';
import { formatDocument } from '../workspace/formatter';

// The headless execution backend (execution-v2.md / chat-only plan). It is the
// SOLE owner of editing + undo; it has no UI and does no reasoning. The chat
// participant's LLM brain streams structured changes here via apply(); the result
// (ok / reason / diagnostics) flows back to the model, which adapts. Every change
// is validated before it touches disk, and originals are checkpointed so any step
// — or the whole run — can be reverted.

export type EditChange =
  | { op: 'edit_file'; path: string; find: string; replace: string; all?: boolean }
  | { op: 'create_file'; path: string; contents: string; overwrite?: boolean }
  | { op: 'delete_file'; path: string };

export interface DiagnosticInfo {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  line: number; // 1-based
}

export interface ApplyResult {
  ok: boolean;
  reason?: string; // present when ok === false — fed back to the LLM verbatim
  file?: string; // repo-relative path that changed
  diagnostics?: DiagnosticInfo[]; // best-effort, for self-check
}

export class ExecutionService {
  private checkpoint = new WorkspaceCheckpoint();
  private readonly changed = new Set<string>(); // absolute paths changed this run
  // Per-segment layer: a file's bytes as they were at the START of the current
  // segment (the work between two user decisions), so "Undo this checkpoint" can
  // revert just this segment without losing earlier, already-continued work.
  private segmentLayer: Map<string, Uint8Array | null> | undefined;

  constructor(private readonly workspaceRoot: string) {}

  // Segment boundaries (called by the chat driver around each checkpoint segment).
  // Idempotent: if a segment is already open, keep it (so a Retry that continues a
  // partially-applied segment folds into the same layer).
  beginSegment(): void {
    if (!this.segmentLayer) this.segmentLayer = new Map();
  }
  commitSegment(): void {
    this.segmentLayer = undefined; // keep changes; run-level checkpoint still backs Undo-all
  }
  async revertSegment(): Promise<void> {
    if (!this.segmentLayer) return;
    for (const [abs, bytes] of this.segmentLayer) {
      const uri = vscode.Uri.file(abs);
      try {
        if (bytes === null) await vscode.workspace.fs.delete(uri).then(undefined, () => undefined);
        else await vscode.workspace.fs.writeFile(uri, bytes);
      } catch {
        /* best effort */
      }
    }
    this.segmentLayer = undefined;
  }

  // Capture a file's originals into both the run checkpoint (before-run, for
  // Undo-all) and the current segment layer (before-this-segment, for Undo-checkpoint).
  private async snapshot(absPath: string): Promise<void> {
    await this.checkpoint.capture([absPath]);
    if (this.segmentLayer && !this.segmentLayer.has(absPath)) {
      try {
        this.segmentLayer.set(absPath, await vscode.workspace.fs.readFile(vscode.Uri.file(absPath)));
      } catch {
        this.segmentLayer.set(absPath, null);
      }
    }
  }

  get changedFiles(): string[] {
    return [...this.changed];
  }
  // Files touched during the CURRENT segment (keys of the segment layer). Valid
  // until commitSegment/revertSegment clears it.
  get currentSegmentFiles(): string[] {
    return this.segmentLayer ? [...this.segmentLayer.keys()] : [];
  }
  get changeCount(): number {
    return this.changed.size;
  }
  // For the diff provider: original (pre-run) bytes of a changed file.
  originalOf(absPath: string): Uint8Array | null | undefined {
    return this.checkpoint.getOriginal(absPath);
  }

  private abs(p: string): string {
    return path.isAbsolute(p) ? p : path.join(this.workspaceRoot, p);
  }

  async apply(change: EditChange): Promise<ApplyResult> {
    try {
      switch (change.op) {
        case 'edit_file':
          return await this.editFile(change);
        case 'create_file':
          return await this.createFile(change);
        case 'delete_file':
          return await this.deleteFile(change);
        default:
          return { ok: false, reason: `unknown op ${(change as { op: string }).op}` };
      }
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  private async editFile(c: { path: string; find: string; replace: string; all?: boolean }): Promise<ApplyResult> {
    const absPath = this.abs(c.path);
    const uri = vscode.Uri.file(absPath);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return { ok: false, reason: `file not found: ${c.path}` };
    }
    if (!c.find) return { ok: false, reason: 'edit_file needs a non-empty "find"' };

    const text = doc.getText();
    const occurrences = countOccurrences(text, c.find);
    if (occurrences === 0) {
      return { ok: false, reason: `"find" text not found in ${c.path} — read the current file and use exact text` };
    }
    if (occurrences > 1 && c.all !== true) {
      return {
        ok: false,
        reason: `"find" matches ${occurrences} places in ${c.path}; make it unique (add surrounding context) or pass all=true`,
      };
    }

    await this.snapshot(absPath);
    const edit = new vscode.WorkspaceEdit();
    let from = 0;
    for (;;) {
      const idx = text.indexOf(c.find, from);
      if (idx === -1) break;
      edit.replace(uri, new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + c.find.length)), c.replace);
      if (c.all !== true) break;
      from = idx + c.find.length;
    }
    return this.commit(edit, absPath, c.path);
  }

  private async createFile(c: { path: string; contents: string; overwrite?: boolean }): Promise<ApplyResult> {
    const absPath = this.abs(c.path);
    const uri = vscode.Uri.file(absPath);
    let exists = false;
    try {
      await vscode.workspace.fs.stat(uri);
      exists = true;
    } catch {
      /* doesn't exist — good */
    }
    if (exists && c.overwrite !== true) {
      return { ok: false, reason: `${c.path} already exists — use edit_file, or pass overwrite=true` };
    }
    await this.snapshot(absPath);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: c.overwrite === true, ignoreIfExists: false });
    if (c.contents) edit.insert(uri, new vscode.Position(0, 0), c.contents);
    return this.commit(edit, absPath, c.path);
  }

  private async deleteFile(c: { path: string }): Promise<ApplyResult> {
    const absPath = this.abs(c.path);
    const uri = vscode.Uri.file(absPath);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      return { ok: false, reason: `cannot delete — ${c.path} does not exist` };
    }
    await this.snapshot(absPath);
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(uri, { ignoreIfNotExists: true });
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) return { ok: false, reason: `VS Code rejected deleting ${c.path}` };
    this.changed.add(absPath);
    return { ok: true, file: vscode.workspace.asRelativePath(absPath) };
  }

  private async commit(edit: vscode.WorkspaceEdit, absPath: string, relForMsg: string): Promise<ApplyResult> {
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) return { ok: false, reason: `VS Code rejected the edit to ${relForMsg}` };
    this.changed.add(absPath);
    // Formatting and saving are two separate risks — a formatter throwing (no
    // formatter registered, a formatter error, etc.) must NEVER prevent the save.
    // Previously both were in one try/catch: if formatDocument() threw, doc.save()
    // never ran, silently leaving the edit unsaved (dirty) in the editor. Undo/
    // checkpoint restore then writes the ORIGINAL bytes straight to disk, but a
    // still-dirty open editor doesn't reliably pick that up — from the outside
    // this looked exactly like "Undo all" missing some files.
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
      try {
        await formatDocument(doc);
      } catch {
        /* formatting is best-effort — never block saving the actual edit */
      }
      if (doc.isDirty) await doc.save();
    } catch {
      /* file may have been deleted/moved — ignore */
    }
    return {
      ok: true,
      file: vscode.workspace.asRelativePath(absPath),
      diagnostics: await this.readDiagnostics(absPath),
    };
  }

  // Best-effort — diagnostics may not have recomputed yet; the LLM can also call
  // read_diagnostics later. Give the language server a brief moment first.
  async readDiagnostics(absPath: string): Promise<DiagnosticInfo[]> {
    await new Promise((r) => setTimeout(r, 250));
    const diags = vscode.languages.getDiagnostics(vscode.Uri.file(absPath));
    return diags.slice(0, 20).map((d) => ({
      severity: severityName(d.severity),
      message: d.message,
      line: d.range.start.line + 1,
    }));
  }

  async undoAll(): Promise<{ restored: number; failed: number }> {
    const res = await this.checkpoint.restore();
    this.reset();
    return res;
  }
  keep(): void {
    this.reset();
  }
  private reset(): void {
    this.checkpoint = new WorkspaceCheckpoint();
    this.changed.clear();
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + needle.length;
  }
  return count;
}

function severityName(s: vscode.DiagnosticSeverity): DiagnosticInfo['severity'] {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    default:
      return 'hint';
  }
}
