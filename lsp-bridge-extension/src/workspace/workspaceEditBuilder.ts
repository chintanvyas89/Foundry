import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceOperation } from '../execution/ir';
import { resolveSymbol } from './symbolResolver';

// Turn one IR workspace operation into a vscode.WorkspaceEdit, resolving symbols
// against the CURRENT buffer (never precomputed). The WorkspaceExecutor applies
// each returned edit, saves, then builds the next op's edit — so anchored ops see
// the file as left by earlier ops in the same step.

export class OperationError extends Error {
  constructor(
    public readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

export interface BuiltEdit {
  edit: vscode.WorkspaceEdit;
  files: string[]; // absolute fsPaths this edit touches, for progress + Keep/Undo
  note: string; // short human description for progress/diff
}

export async function buildEditForOperation(
  op: WorkspaceOperation,
  workspaceRoot: string,
): Promise<BuiltEdit> {
  const abs = (p: string): string => (path.isAbsolute(p) ? p : path.join(workspaceRoot, p));
  const uriOf = (p: string): vscode.Uri => vscode.Uri.file(abs(p));
  const edit = new vscode.WorkspaceEdit();

  switch (op.operation) {
    case 'replace_function':
    case 'replace_method':
    case 'replace_block': {
      const r = await resolveSymbol(op.target);
      edit.replace(r.document.uri, r.fullRange, op.replacement);
      return { edit, files: [abs(op.target.file)], note: `replace ${op.target.symbol}` };
    }

    case 'replace_lines': {
      const doc = await open(uriOf(op.target.file));
      const range = lineRange(doc, op.startLine, op.endLine);
      edit.replace(doc.uri, range, op.replacement);
      return {
        edit,
        files: [abs(op.target.file)],
        note: `replace lines ${op.startLine}-${op.endLine}`,
      };
    }

    case 'insert_before':
    case 'insert_after': {
      const r = await resolveSymbol(op.target);
      if (op.operation === 'insert_before') {
        const pos = new vscode.Position(r.fullRange.start.line, 0);
        edit.insert(r.document.uri, pos, op.code.endsWith('\n') ? op.code : op.code + '\n');
      } else {
        const endLine = r.fullRange.end.line;
        const pos = new vscode.Position(endLine, r.document.lineAt(endLine).text.length);
        edit.insert(r.document.uri, pos, op.code.startsWith('\n') ? op.code : '\n' + op.code);
      }
      return {
        edit,
        files: [abs(op.target.file)],
        note: `${op.operation} ${op.target.symbol}`,
      };
    }

    case 'replace_text': {
      const doc = await open(uriOf(op.target.file));
      const text = doc.getText();
      const ranges = findRanges(doc, text, op.find, op.all === true);
      if (ranges.length === 0) {
        throw new OperationError(
          'text_not_found',
          `replace_text: "${truncate(op.find)}" not found in ${op.target.file}`,
        );
      }
      for (const range of ranges) edit.replace(doc.uri, range, op.replace);
      return { edit, files: [abs(op.target.file)], note: `replace text in ${op.target.file}` };
    }

    case 'append':
    case 'prepend': {
      const doc = await open(uriOf(op.target.file));
      if (op.operation === 'prepend') {
        edit.insert(doc.uri, new vscode.Position(0, 0), op.code.endsWith('\n') ? op.code : op.code + '\n');
      } else {
        const last = Math.max(doc.lineCount - 1, 0);
        const pos = new vscode.Position(last, doc.lineAt(last).text.length);
        const needsNl = doc.lineAt(last).text.length > 0;
        edit.insert(doc.uri, pos, (needsNl ? '\n' : '') + op.code);
      }
      return { edit, files: [abs(op.target.file)], note: `${op.operation} ${op.target.file}` };
    }

    case 'create_file': {
      const uri = uriOf(op.file);
      edit.createFile(uri, { overwrite: op.overwrite === true, ignoreIfExists: op.overwrite !== true });
      if (op.contents) edit.insert(uri, new vscode.Position(0, 0), op.contents);
      return { edit, files: [abs(op.file)], note: `create ${op.file}` };
    }

    case 'delete_file': {
      edit.deleteFile(uriOf(op.file), { ignoreIfNotExists: true });
      return { edit, files: [abs(op.file)], note: `delete ${op.file}` };
    }

    case 'move_file': {
      edit.renameFile(uriOf(op.from), uriOf(op.to), { overwrite: false });
      return { edit, files: [abs(op.from), abs(op.to)], note: `move ${op.from} → ${op.to}` };
    }

    case 'rename_symbol': {
      const r = await resolveSymbol(op.target);
      const renameEdit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
        'vscode.executeDocumentRenameProvider',
        r.document.uri,
        r.selectionRange.start,
        op.newName,
      );
      if (!renameEdit || renameEdit.size === 0) {
        throw new OperationError(
          'rename_failed',
          `rename_symbol: provider produced no edits for "${op.target.symbol}" in ${op.target.file}`,
        );
      }
      const files = renameEdit.entries().map(([u]) => u.fsPath);
      return { edit: renameEdit, files, note: `rename ${op.target.symbol} → ${op.newName}` };
    }

    case 'add_import': {
      const doc = await open(uriOf(op.target.file));
      const line = importInsertLine(doc);
      const stmt = op.statement.endsWith('\n') ? op.statement : op.statement + '\n';
      edit.insert(doc.uri, new vscode.Position(line, 0), stmt);
      return { edit, files: [abs(op.target.file)], note: `add import to ${op.target.file}` };
    }

    case 'remove_import': {
      const doc = await open(uriOf(op.target.file));
      for (let i = 0; i < doc.lineCount; i++) {
        if (doc.lineAt(i).text.includes(op.statement)) {
          edit.delete(doc.uri, doc.lineAt(i).rangeIncludingLineBreak);
          break;
        }
      }
      // Removing an import that isn't there is a no-op, not a failure.
      return { edit, files: [abs(op.target.file)], note: `remove import from ${op.target.file}` };
    }

    default: {
      // Exhaustiveness guard — a new op type must be handled here.
      const _never: never = op;
      throw new OperationError('unsupported_operation', `Unsupported operation: ${JSON.stringify(_never)}`);
    }
  }
}

async function open(uri: vscode.Uri): Promise<vscode.TextDocument> {
  try {
    return await vscode.workspace.openTextDocument(uri);
  } catch {
    throw new OperationError('file_not_found', `Cannot open ${uri.fsPath}`);
  }
}

function lineRange(doc: vscode.TextDocument, startLine1: number, endLine1: number): vscode.Range {
  const start = Math.min(Math.max(startLine1 - 1, 0), Math.max(doc.lineCount - 1, 0));
  const end = Math.min(Math.max(endLine1 - 1, 0), Math.max(doc.lineCount - 1, 0));
  return new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
}

function findRanges(
  doc: vscode.TextDocument,
  text: string,
  needle: string,
  all: boolean,
): vscode.Range[] {
  const out: vscode.Range[] = [];
  if (!needle) return out;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) break;
    out.push(new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + needle.length)));
    if (!all) break;
    from = idx + needle.length;
  }
  return out;
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

function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
