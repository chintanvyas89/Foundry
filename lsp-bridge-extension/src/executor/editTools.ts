import * as vscode from 'vscode';
import { ExecutionService, ApplyResult } from './executionService';
import { SymbolTarget } from '../workspace/symbolResolver';

// The edit channel: the ONLY mutating tools the agent may call. They are
// defined here (not contributed globally) so they exist solely inside the
// agent loop — @codebase's lookup-only tools never get edit power outside it.
// Each tool forwards to ExecutionService.apply and returns a short text result
// the LLM reads to decide its next move (fix + retry, or move on).
//
// Two families: `apply_edit` (exact-text find/replace — best for a small, known
// snippet) and the SYMBOL-ANCHORED ops (resolved by name via the language
// server, not text matching — best for a whole function/method/class rewrite,
// inserting next to a symbol, or a true cross-file rename).

const SYMBOL_TARGET_PROPS = {
  path: { type: 'string', description: 'workspace-relative file path' },
  symbol: {
    type: 'string',
    description: 'symbol name, dotted path ok for a nested member (e.g. "Widget.render")',
  },
  container: { type: 'string', description: 'enclosing symbol name, only if the plain name is ambiguous' },
  index: { type: 'number', description: 'pick the Nth match (0-based), only if still ambiguous' },
  signature: { type: 'string', description: 'substring of the declaration line, only if still ambiguous' },
} as const;

export const EDIT_TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: 'apply_edit',
    description:
      'Replace an exact snippet in an existing file. `find` MUST appear exactly once — include ' +
      'enough surrounding lines to make it unique. Read the real current file first; never guess. ' +
      'If it does not match, you get an error and should re-read and retry. For rewriting a WHOLE ' +
      'function/method/class, prefer replace_symbol instead — more robust than reproducing its ' +
      'exact current text.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'workspace-relative file path' },
        find: { type: 'string', description: 'exact text to replace (unique in the file)' },
        replace: { type: 'string', description: 'replacement text' },
        all: { type: 'boolean', description: 'replace every occurrence (default false)' },
      },
      required: ['path', 'find', 'replace'],
    },
  },
  {
    name: 'create_file',
    description: 'Create a new file with the given contents. Fails if it already exists (use apply_edit instead).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        contents: { type: 'string' },
      },
      required: ['path', 'contents'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'replace_symbol',
    description:
      'Replace a function/method/class\'s FULL declaration (signature + body), resolved by NAME via ' +
      'the language server — not text matching. More robust than apply_edit for a whole-symbol ' +
      'rewrite: you don\'t need to reproduce its exact current text. If the name is ambiguous ' +
      '(overloads, nested members with the same name), you get an error listing every match — retry ' +
      'with container/index/signature.',
    inputSchema: {
      type: 'object',
      properties: { ...SYMBOL_TARGET_PROPS, replacement: { type: 'string', description: 'the full new declaration' } },
      required: ['path', 'symbol', 'replacement'],
    },
  },
  {
    name: 'insert_near_symbol',
    description: 'Insert new code immediately before or after a symbol\'s full declaration, resolved by name.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SYMBOL_TARGET_PROPS,
        code: { type: 'string' },
        position: { type: 'string', enum: ['before', 'after'] },
      },
      required: ['path', 'symbol', 'code', 'position'],
    },
  },
  {
    name: 'rename_symbol',
    description:
      'Rename a symbol EVERYWHERE it is referenced, via the language server\'s own rename provider — ' +
      'safe across files, not a text search. Use this for a true rename; to change just one ' +
      'declaration\'s text without touching references, use apply_edit or replace_symbol instead.',
    inputSchema: {
      type: 'object',
      properties: { ...SYMBOL_TARGET_PROPS, newName: { type: 'string' } },
      required: ['path', 'symbol', 'newName'],
    },
  },
  {
    name: 'add_import',
    description: 'Add an import/require/use statement to a file (inserted after the last existing one, or at the top).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, statement: { type: 'string', description: 'the exact import line' } },
      required: ['path', 'statement'],
    },
  },
  {
    name: 'remove_import',
    description: 'Remove an import/require/use statement from a file (matched by substring).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, statement: { type: 'string', description: 'substring of the import line to remove' } },
      required: ['path', 'statement'],
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file.',
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
  },
  {
    name: 'read_diagnostics',
    description: 'Read current compiler/linter diagnostics for a file to verify your change did not break it.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
];

export const EDIT_TOOL_NAMES = new Set(EDIT_TOOLS.map((t) => t.name));

function symbolTarget(input: Record<string, unknown>): SymbolTarget {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const num = (k: string) => (typeof input[k] === 'number' ? (input[k] as number) : undefined);
  return {
    file: str('path') ?? '',
    symbol: str('symbol') ?? '',
    container: str('container'),
    index: num('index'),
    signature: str('signature'),
  };
}

// Dispatch one edit-tool call. Returns the text result fed back to the model.
export async function runEditTool(
  name: string,
  input: Record<string, unknown>,
  service: ExecutionService,
  workspaceRoot: string,
): Promise<string> {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'apply_edit':
      return describe(
        await service.apply({
          op: 'edit_file',
          path: str('path'),
          find: str('find'),
          replace: str('replace'),
          all: input.all === true,
        }),
      );
    case 'create_file':
      return describe(await service.apply({ op: 'create_file', path: str('path'), contents: str('contents') }));
    case 'delete_file':
      return describe(await service.apply({ op: 'delete_file', path: str('path') }));
    case 'replace_symbol':
      return describe(
        await service.apply({ op: 'replace_symbol', target: symbolTarget(input), replacement: str('replacement') }),
      );
    case 'insert_near_symbol':
      return describe(
        await service.apply({
          op: 'insert_near_symbol',
          target: symbolTarget(input),
          code: str('code'),
          position: str('position') === 'before' ? 'before' : 'after',
        }),
      );
    case 'rename_symbol':
      return describe(
        await service.apply({ op: 'rename_symbol', target: symbolTarget(input), newName: str('newName') }),
      );
    case 'add_import':
      return describe(await service.apply({ op: 'add_import', path: str('path'), statement: str('statement') }));
    case 'remove_import':
      return describe(await service.apply({ op: 'remove_import', path: str('path'), statement: str('statement') }));
    case 'move_file':
      return describe(await service.apply({ op: 'move_file', from: str('from'), to: str('to') }));
    case 'read_diagnostics': {
      const abs = toAbs(str('path'), workspaceRoot);
      const diags = await service.readDiagnostics(abs);
      if (diags.length === 0) return `No diagnostics for ${str('path')}.`;
      return (
        `Diagnostics for ${str('path')}:\n` +
        diags.map((d) => `- [${d.severity}] line ${d.line}: ${d.message}`).join('\n')
      );
    }
    default:
      return `ERROR: unknown edit tool ${name}`;
  }
}

function describe(r: ApplyResult): string {
  if (!r.ok) return `ERROR: ${r.reason}`;
  const errs = (r.diagnostics ?? []).filter((d) => d.severity === 'error');
  const diagNote =
    errs.length > 0
      ? ` — introduced ${errs.length} error(s): ${errs
          .slice(0, 5)
          .map((d) => `line ${d.line}: ${d.message}`)
          .join('; ')}. Fix them.`
      : ' — no new errors.';
  const filesNote = r.files && r.files.length > 1 ? ` (${r.files.length} files: ${r.files.join(', ')})` : '';
  return `OK: changed ${r.file}${filesNote}${diagNote}`;
}

function toAbs(p: string, root: string): string {
  return p.startsWith('/') ? p : `${root.replace(/\/$/, '')}/${p}`;
}

// --- Native diff ("Review all changes"): before (checkpoint) vs current file --

export const ORIGINAL_SCHEME = 'foundry-original';

class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  service?: ExecutionService;
  provideTextDocumentContent(uri: vscode.Uri): string {
    // `uri` is a real file:// URI with just the scheme swapped (see
    // openAllChangesDiff below), so `.fsPath` reverses it exactly — no manual
    // percent-encode/decode round-trip to get subtly wrong on odd paths.
    const bytes = this.service?.originalOf(uri.fsPath);
    return bytes == null ? '' : Buffer.from(bytes).toString('utf8');
  }
}

const originalProvider = new OriginalContentProvider();

export function registerDiffProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, originalProvider),
  );
}

// Open ALL changed files in ONE multi-file "changes" editor (pre-run vs current
// content each) — a real review surface, not a picker over single-file diffs.
// `vscode.changes` isn't in the typed API (@types/vscode has no declaration for
// it) but is a real, stable built-in command — confirmed against the installed
// VS Code build's own command registration ("Opens a list of resources in the
// changes editor to compare their contents"), signature
// (title: string, resources: [display: Uri, original: Uri, modified: Uri][]).
export async function openAllChangesDiff(service: ExecutionService, files: string[]): Promise<void> {
  if (files.length === 0) return;
  originalProvider.service = service;
  const resources = files.map((f) => {
    const uri = vscode.Uri.file(f);
    return [uri, uri.with({ scheme: ORIGINAL_SCHEME }), uri];
  });
  await vscode.commands.executeCommand('vscode.changes', 'Foundry · changes in this run', resources);
}
