import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceCheckpoint } from '../execution/checkpoint';
import { formatDocument } from '../workspace/formatter';
import { resolveSymbol, SymbolTarget } from '../workspace/symbolResolver';

// The headless execution backend. It is the SOLE owner of editing + undo; it has
// no UI and does no reasoning. The chat participant's LLM brain streams
// structured changes here via apply(); the result (ok / reason / diagnostics)
// flows back to the model, which adapts. Every change is validated before it
// touches disk, and originals are checkpointed so the whole run can be reverted.
//
// No mid-run checkpoints: there is one run-level checkpoint, not a per-segment
// layer — the model runs autonomously to completion (or blocked), and the only
// undo point is "revert everything this run touched."

export type EditChange =
  | { op: 'edit_file'; path: string; find: string; replace: string; all?: boolean }
  | { op: 'create_file'; path: string; contents: string; overwrite?: boolean }
  | { op: 'delete_file'; path: string }
  | { op: 'replace_symbol'; target: SymbolTarget; replacement: string }
  | { op: 'insert_near_symbol'; target: SymbolTarget; code: string; position: 'before' | 'after' }
  | { op: 'rename_symbol'; target: SymbolTarget; newName: string }
  | { op: 'add_import'; path: string; statement: string }
  | { op: 'remove_import'; path: string; statement: string }
  | { op: 'move_file'; from: string; to: string };

export interface DiagnosticInfo {
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  line: number; // 1-based
}

export interface ApplyResult {
  ok: boolean;
  reason?: string; // present when ok === false — fed back to the LLM verbatim
  file?: string; // repo-relative path that changed (the primary one)
  files?: string[]; // ALL repo-relative paths changed, when more than one (rename/move)
  diagnostics?: DiagnosticInfo[]; // best-effort, for self-check
}

export class ExecutionService {
  private checkpoint = new WorkspaceCheckpoint();
  private readonly changed = new Set<string>(); // absolute paths changed this run

  constructor(private readonly workspaceRoot: string) {}

  private async snapshot(absPath: string): Promise<void> {
    await this.checkpoint.capture([absPath]);
  }

  get changedFiles(): string[] {
    return [...this.changed];
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
        case 'replace_symbol':
          return await this.replaceSymbol(change);
        case 'insert_near_symbol':
          return await this.insertNearSymbol(change);
        case 'rename_symbol':
          return await this.renameSymbolOp(change);
        case 'add_import':
          return await this.addImport(change);
        case 'remove_import':
          return await this.removeImport(change);
        case 'move_file':
          return await this.moveFile(change);
        default: {
          const _never: never = change;
          return { ok: false, reason: `unknown op ${(_never as { op: string }).op}` };
        }
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

    const edit = new vscode.WorkspaceEdit();
    let from = 0;
    for (;;) {
      const idx = text.indexOf(c.find, from);
      if (idx === -1) break;
      edit.replace(uri, new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + c.find.length)), c.replace);
      if (c.all !== true) break;
      from = idx + c.find.length;
    }
    return this.commit(edit, [absPath], c.path);
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
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: c.overwrite === true, ignoreIfExists: false });
    if (c.contents) edit.insert(uri, new vscode.Position(0, 0), c.contents);
    return this.commit(edit, [absPath], c.path);
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

  // Replace a resolved symbol's FULL declaration (signature + body) — more
  // robust than apply_edit for a whole-function/method/class rewrite, since it
  // doesn't require reproducing the current text exactly.
  private async replaceSymbol(c: { target: SymbolTarget; replacement: string }): Promise<ApplyResult> {
    const r = await resolveSymbol(c.target, this.workspaceRoot);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(r.document.uri, r.fullRange, c.replacement);
    return this.commit(edit, [this.abs(c.target.file)], c.target.file);
  }

  private async insertNearSymbol(c: {
    target: SymbolTarget;
    code: string;
    position: 'before' | 'after';
  }): Promise<ApplyResult> {
    const r = await resolveSymbol(c.target, this.workspaceRoot);
    const edit = new vscode.WorkspaceEdit();
    if (c.position === 'before') {
      const pos = new vscode.Position(r.fullRange.start.line, 0);
      edit.insert(r.document.uri, pos, c.code.endsWith('\n') ? c.code : c.code + '\n');
    } else {
      const endLine = r.fullRange.end.line;
      const pos = new vscode.Position(endLine, r.document.lineAt(endLine).text.length);
      edit.insert(r.document.uri, pos, c.code.startsWith('\n') ? c.code : '\n' + c.code);
    }
    return this.commit(edit, [this.abs(c.target.file)], c.target.file);
  }

  // Rename a symbol EVERYWHERE it's referenced, via the language server's own
  // rename provider — not a text search, so it's safe across files.
  private async renameSymbolOp(c: { target: SymbolTarget; newName: string }): Promise<ApplyResult> {
    const r = await resolveSymbol(c.target, this.workspaceRoot);
    const renameEdit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
      'vscode.executeDocumentRenameProvider',
      r.document.uri,
      r.selectionRange.start,
      c.newName,
    );
    if (!renameEdit || renameEdit.size === 0) {
      return {
        ok: false,
        reason: `rename provider produced no edits for "${c.target.symbol}" in ${c.target.file} — the language server may not support rename here`,
      };
    }
    const files = renameEdit.entries().map(([u]) => u.fsPath);
    return this.commit(renameEdit, files, c.target.file);
  }

  private async addImport(c: { path: string; statement: string }): Promise<ApplyResult> {
    const absPath = this.abs(c.path);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    } catch {
      return { ok: false, reason: `file not found: ${c.path}` };
    }
    const line = importInsertLine(doc);
    const edit = new vscode.WorkspaceEdit();
    const stmt = c.statement.endsWith('\n') ? c.statement : c.statement + '\n';
    edit.insert(doc.uri, new vscode.Position(line, 0), stmt);
    return this.commit(edit, [absPath], c.path);
  }

  private async removeImport(c: { path: string; statement: string }): Promise<ApplyResult> {
    const absPath = this.abs(c.path);
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
    } catch {
      return { ok: false, reason: `file not found: ${c.path}` };
    }
    const edit = new vscode.WorkspaceEdit();
    let found = false;
    for (let i = 0; i < doc.lineCount; i++) {
      if (doc.lineAt(i).text.includes(c.statement)) {
        edit.delete(doc.uri, doc.lineAt(i).rangeIncludingLineBreak);
        found = true;
        break;
      }
    }
    // Unlike a no-op-tolerant search, report not-found as an error — consistent
    // with how apply_edit treats a non-matching `find`: a clear signal the model
    // should react to (re-check the exact import text) rather than a silent no-op.
    if (!found) return { ok: false, reason: `import statement "${c.statement}" not found in ${c.path}` };
    return this.commit(edit, [absPath], c.path);
  }

  private async moveFile(c: { from: string; to: string }): Promise<ApplyResult> {
    const fromAbs = this.abs(c.from);
    const toAbs = this.abs(c.to);
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(vscode.Uri.file(fromAbs), vscode.Uri.file(toAbs), { overwrite: false });
    return this.commit(edit, [fromAbs, toAbs], c.from);
  }

  // Apply an edit that may touch one or more files: snapshot every path's
  // pre-edit bytes (for Undo-all) BEFORE applying, then format+save+diagnose
  // each afterward. A single-file op just passes a 1-element array.
  private async commit(edit: vscode.WorkspaceEdit, absPaths: string[], relForMsg: string): Promise<ApplyResult> {
    for (const p of absPaths) await this.snapshot(p);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) return { ok: false, reason: `VS Code rejected the edit to ${relForMsg}` };
    for (const p of absPaths) this.changed.add(p);

    // Formatting and saving are two separate risks — a formatter throwing (no
    // formatter registered, a formatter error, etc.) must never prevent the
    // save, which is what actually gets a change to disk (and thus visible to
    // Undo-all's checkpoint restore).
    for (const p of absPaths) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
        try {
          await formatDocument(doc);
        } catch {
          /* formatting is best-effort — never block saving the actual edit */
        }
        if (doc.isDirty) await doc.save();
      } catch {
        /* file may have been deleted/moved — ignore */
      }
    }

    const primary = absPaths[0];
    return {
      ok: true,
      file: vscode.workspace.asRelativePath(primary),
      files: absPaths.length > 1 ? absPaths.map((p) => vscode.workspace.asRelativePath(p)) : undefined,
      diagnostics: await this.readDiagnostics(primary),
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

// Insert new imports right after the last existing import-ish line, else at the top.
function importInsertLine(doc: vscode.TextDocument): number {
  const IMPORT_RE = /^\s*(import|from|#include|using|use\s|require|@import|package\s|namespace\s)/;
  let last = -1;
  const scan = Math.min(doc.lineCount, 200); // imports live near the top
  for (let i = 0; i < scan; i++) {
    if (IMPORT_RE.test(doc.lineAt(i).text)) last = i;
  }
  return last === -1 ? 0 : last + 1;
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
