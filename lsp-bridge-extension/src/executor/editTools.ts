import * as vscode from 'vscode';
import { ExecutionService, ApplyResult } from './executionService';

// The edit channel: the ONLY mutating tools the plan-agent may call. They are
// defined here (not contributed globally) so they exist solely inside the
// executor loop — the @codebase Q&A participant never gets edit power. Each tool
// forwards to ExecutionService.apply and returns a short text result the LLM reads
// to decide its next move (fix + retry, or move on).

export const EDIT_TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: 'apply_edit',
    description:
      'Replace an exact snippet in an existing file. `find` MUST appear exactly once — include ' +
      'enough surrounding lines to make it unique. Read the real current file first; never guess. ' +
      'If it does not match, you get an error and should re-read and retry.',
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
  return `OK: changed ${r.file}${diagNote}`;
}

function toAbs(p: string, root: string): string {
  return p.startsWith('/') ? p : `${root.replace(/\/$/, '')}/${p}`;
}

// --- Native diff ("Open Diff" button): before (checkpoint) vs current file -----

export const ORIGINAL_SCHEME = 'foundry-original';

class OriginalContentProvider implements vscode.TextDocumentContentProvider {
  service?: ExecutionService;
  provideTextDocumentContent(uri: vscode.Uri): string {
    const absPath = decodeURIComponent(uri.path.replace(/^\//, ''));
    const bytes = this.service?.originalOf(absPath);
    return bytes == null ? '' : Buffer.from(bytes).toString('utf8');
  }
}

const originalProvider = new OriginalContentProvider();

export function registerDiffProvider(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, originalProvider),
  );
}

// Open a native diff of a changed file: its pre-run content vs. its current content.
export async function openChangeDiff(service: ExecutionService, absPath: string): Promise<void> {
  originalProvider.service = service;
  const rel = vscode.workspace.asRelativePath(absPath);
  const left = vscode.Uri.parse(`${ORIGINAL_SCHEME}:/${encodeURIComponent(absPath)}`);
  const right = vscode.Uri.file(absPath);
  await vscode.commands.executeCommand('vscode.diff', left, right, `Foundry · ${rel} (before → after)`, {
    preview: true,
  });
}
