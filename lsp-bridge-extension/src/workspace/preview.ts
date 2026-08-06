import * as vscode from 'vscode';
import * as path from 'path';
import { WorkflowStep, WorkspaceOperation } from '../execution/ir';
import { resolveSymbol } from './symbolResolver';

// Computes what a step WOULD do, without mutating anything — so the Foundry
// Execution view can open a native diff (current file vs. proposed content) for
// review before the step is applied. Reuses resolveSymbol for symbol ranges and
// the same offset math the editor uses, so the proposed text matches what the
// WorkspaceExecutor will actually produce.

const WORKSPACE_OPS = new Set([
  'replace_function',
  'replace_method',
  'replace_block',
  'replace_lines',
  'insert_before',
  'insert_after',
  'replace_text',
  'append',
  'prepend',
  'create_file',
  'delete_file',
  'rename_symbol',
  'add_import',
  'remove_import',
  'move_file',
]);

export type FileChangeKind = 'edit' | 'create' | 'delete' | 'structural';

export interface StepFileChange {
  absPath: string;
  relPath: string;
  kind: FileChangeKind;
  // A note for structural changes (rename/move) that have no single-file diff.
  note?: string;
}

function abs(p: string, root: string): string {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

function workspaceOps(step: WorkflowStep): WorkspaceOperation[] {
  return step.script.filter((o): o is WorkspaceOperation => WORKSPACE_OPS.has(o.operation));
}

// The distinct files a step touches, each tagged with how (so the view can pick
// the right diff sides / show a note for structural ops).
export function stepFileChanges(step: WorkflowStep, workspaceRoot: string): StepFileChange[] {
  const out = new Map<string, StepFileChange>();
  const add = (file: string, kind: FileChangeKind, note?: string) => {
    const absPath = abs(file, workspaceRoot);
    // Once a file is a create/delete/structural, keep that (don't downgrade to edit).
    const existing = out.get(absPath);
    if (existing && existing.kind !== 'edit') return;
    out.set(absPath, {
      absPath,
      relPath: vscode.workspace.asRelativePath(absPath),
      kind,
      note: note ?? existing?.note,
    });
  };
  for (const op of workspaceOps(step)) {
    switch (op.operation) {
      case 'create_file':
        add(op.file, 'create');
        break;
      case 'delete_file':
        add(op.file, 'delete');
        break;
      case 'move_file':
        add(op.from, 'structural', `move → ${op.to}`);
        add(op.to, 'create');
        break;
      case 'rename_symbol':
        add(op.target.file, 'structural', `rename ${op.target.symbol} → ${op.newName} (+ references)`);
        break;
      default:
        add((op as { target: { file: string } }).target.file, 'edit');
        break;
    }
  }
  return [...out.values()];
}

// The full proposed content of one file after a step's ops are applied. Returns
// null when the change isn't a single-file text edit (structural rename/move) —
// the caller shows a note instead of a diff. For create_file → the new contents;
// for delete_file → empty.
export async function proposedFileContent(
  absFile: string,
  step: WorkflowStep,
  workspaceRoot: string,
): Promise<string | null> {
  const ops = workspaceOps(step).filter((op) => opTouchesFile(op, absFile, workspaceRoot));

  const createOp = ops.find((o) => o.operation === 'create_file');
  if (createOp && createOp.operation === 'create_file') return createOp.contents ?? '';
  if (ops.some((o) => o.operation === 'delete_file')) return '';
  // A rename/move on this file has no in-file text diff.
  if (ops.every((o) => o.operation === 'rename_symbol' || o.operation === 'move_file')) return null;

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absFile));
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const op of ops) {
    for (const e of await editsForOp(op, doc, workspaceRoot)) edits.push(e);
  }
  // Apply high offsets first so earlier splices don't invalidate later offsets.
  edits.sort((a, b) => b.start - a.start);
  let text = doc.getText();
  for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
  return text;
}

function opTouchesFile(op: WorkspaceOperation, absFile: string, root: string): boolean {
  const files =
    op.operation === 'create_file' || op.operation === 'delete_file'
      ? [op.file]
      : op.operation === 'move_file'
        ? [op.from, op.to]
        : [(op as { target: { file: string } }).target.file];
  return files.some((f) => abs(f, root) === absFile);
}

// One op → zero or more {start,end,text} offset edits against `doc`'s current text.
async function editsForOp(
  op: WorkspaceOperation,
  doc: vscode.TextDocument,
  root: string,
): Promise<Array<{ start: number; end: number; text: string }>> {
  const at = (range: vscode.Range) => ({ start: doc.offsetAt(range.start), end: doc.offsetAt(range.end) });
  switch (op.operation) {
    case 'replace_function':
    case 'replace_method':
    case 'replace_block': {
      const r = await resolveSymbol(op.target, root);
      return [{ ...at(r.fullRange), text: op.replacement }];
    }
    case 'replace_lines': {
      const start = clampLine(doc, op.startLine - 1);
      const end = clampLine(doc, op.endLine - 1);
      const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
      return [{ ...at(range), text: op.replacement }];
    }
    case 'insert_before': {
      const r = await resolveSymbol(op.target, root);
      const off = doc.offsetAt(new vscode.Position(r.fullRange.start.line, 0));
      return [{ start: off, end: off, text: op.code.endsWith('\n') ? op.code : op.code + '\n' }];
    }
    case 'insert_after': {
      const r = await resolveSymbol(op.target, root);
      const line = r.fullRange.end.line;
      const off = doc.offsetAt(new vscode.Position(line, doc.lineAt(line).text.length));
      return [{ start: off, end: off, text: op.code.startsWith('\n') ? op.code : '\n' + op.code }];
    }
    case 'replace_text': {
      const text = doc.getText();
      const out: Array<{ start: number; end: number; text: string }> = [];
      let from = 0;
      for (;;) {
        const idx = text.indexOf(op.find, from);
        if (idx === -1) break;
        out.push({ start: idx, end: idx + op.find.length, text: op.replace });
        if (op.all !== true) break;
        from = idx + op.find.length;
      }
      return out;
    }
    case 'append': {
      const off = doc.getText().length;
      const needsNl = off > 0 && !doc.getText().endsWith('\n');
      return [{ start: off, end: off, text: (needsNl ? '\n' : '') + op.code }];
    }
    case 'prepend':
      return [{ start: 0, end: 0, text: op.code.endsWith('\n') ? op.code : op.code + '\n' }];
    case 'add_import': {
      const line = importInsertLine(doc);
      const off = doc.offsetAt(new vscode.Position(line, 0));
      const stmt = op.statement.endsWith('\n') ? op.statement : op.statement + '\n';
      return [{ start: off, end: off, text: stmt }];
    }
    case 'remove_import': {
      for (let i = 0; i < doc.lineCount; i++) {
        if (doc.lineAt(i).text.includes(op.statement)) {
          const range = doc.lineAt(i).rangeIncludingLineBreak;
          return [{ ...at(range), text: '' }];
        }
      }
      return [];
    }
    default:
      return [];
  }
}

function clampLine(doc: vscode.TextDocument, line: number): number {
  return Math.min(Math.max(line, 0), Math.max(doc.lineCount - 1, 0));
}

function importInsertLine(doc: vscode.TextDocument): number {
  const IMPORT_RE = /^\s*(import|from|#include|using|use\s|require|@import|package\s|namespace\s)/;
  let last = -1;
  const scan = Math.min(doc.lineCount, 200);
  for (let i = 0; i < scan; i++) {
    if (IMPORT_RE.test(doc.lineAt(i).text)) last = i;
  }
  return last === -1 ? 0 : last + 1;
}

// A short human label for an operation, for the step's child rows in the tree.
export function opLabel(op: WorkspaceOperation | { operation: string }): string {
  const o = op as WorkspaceOperation;
  switch (o.operation) {
    case 'create_file':
      return `create ${o.file}`;
    case 'delete_file':
      return `delete ${o.file}`;
    case 'move_file':
      return `move ${o.from} → ${o.to}`;
    case 'rename_symbol':
      return `rename ${o.target.symbol} → ${o.newName}`;
    case 'replace_function':
    case 'replace_method':
    case 'replace_block':
    case 'insert_before':
    case 'insert_after':
      return `${o.operation} ${o.target.symbol}`;
    case 'replace_lines':
      return `replace lines ${o.startLine}-${o.endLine}`;
    case 'replace_text':
      return `replace text in ${(o.target as { file: string }).file}`;
    case 'append':
    case 'prepend':
    case 'add_import':
    case 'remove_import':
      return `${o.operation} ${(o.target as { file: string }).file}`;
    default:
      return (op as { operation: string }).operation;
  }
}
