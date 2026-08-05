import * as vscode from 'vscode';
import type { SearchClient } from './searchClient';

// Registers our local MCP tools as VS Code Language Model Tools, so Copilot's
// own chat / agent mode (and our @codebase participant) can call them. Every
// tool routes to the query-only MCP server via SearchClient.callTool — the
// index stays local; only the small text result reaches the model.
//
// The registered names here MUST match the `contributes.languageModelTools`
// entries in package.json. `foundry_semanticSearch` is the one marked
// `canBeReferencedInPrompt` (#foundryCodebase) — the drop-in for the disabled
// #codebase; the rest are model-invoked.

interface ToolDef {
  /** Registered LM tool name (matches package.json). */
  lmName: string;
  /** Underlying MCP tool name. */
  mcpName: string;
  /** Human-readable progress/confirmation label from the input. */
  label: (input: Record<string, unknown>) => string;
  /** Optional arg massaging before the MCP call. */
  transform?: (input: Record<string, unknown>) => Record<string, unknown>;
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '');

const TOOLS: ToolDef[] = [
  {
    lmName: 'foundry_semanticSearch',
    mcpName: 'semantic_search',
    label: (i) => `Searching the local index for “${s(i.query) || 'code'}”`,
    // Ask for structural context on plain searches; leave it off when the model
    // is expanding earlier hits (expand returns full bodies already).
    transform: (i) => (i.expand ? i : { ...i, context: true }),
  },
  {
    lmName: 'foundry_searchSymbol',
    mcpName: 'search_symbol',
    label: (i) => `Looking up symbol “${s(i.name)}”`,
  },
  {
    lmName: 'foundry_traceCalls',
    mcpName: 'trace_calls',
    label: (i) => `Tracing calls for ${s(i.symbol) || 'symbol'}`,
  },
  {
    lmName: 'foundry_showExecutionFlow',
    mcpName: 'show_execution_flow',
    label: (i) => `Walking the call graph from ${s(i.symbol) || 'symbol'}`,
  },
  {
    lmName: 'foundry_findUsages',
    mcpName: 'find_usages',
    label: (i) => `Finding usages of ${s(i.symbol) || 'symbol'}`,
  },
  {
    lmName: 'foundry_findImplementations',
    mcpName: 'find_implementations',
    label: (i) => `Finding implementations of ${s(i.symbol) || 'symbol'}`,
  },
  {
    lmName: 'foundry_architectureOverview',
    mcpName: 'architecture_overview',
    label: (i) => (s(i.module) ? `Summarizing module ${s(i.module)}` : 'Summarizing the architecture'),
  },
  {
    lmName: 'foundry_repoOverview',
    mcpName: 'repo_overview',
    label: () => 'Reading the index overview',
  },
  {
    lmName: 'foundry_readFile',
    mcpName: 'read_file',
    label: (i) =>
      s(i.symbol)
        ? `Reading ${s(i.symbol)} in ${s(i.file) || 'file'}`
        : `Outlining ${s(i.file) || 'file'}`,
  },
  {
    lmName: 'foundry_listDirectory',
    mcpName: 'list_directory',
    label: (i) => `Listing ${s(i.path) || 'the workspace'}`,
  },
  {
    lmName: 'foundry_projectStandards',
    mcpName: 'project_standards',
    label: () => 'Detecting project standards',
  },
];

/** LM tool names we own — used by the participant to filter the tool list. */
export const FOUNDRY_TOOL_PREFIX = 'foundry_';

export function registerLanguageModelTools(
  context: vscode.ExtensionContext,
  client: SearchClient,
  output: vscode.OutputChannel,
): void {
  // `vscode.lm.registerTool` is only present on VS Code ≥ 1.95; guard so an
  // older host still activates the rest of the extension.
  if (typeof vscode.lm?.registerTool !== 'function') {
    output.appendLine('[lm-tools] Language Model Tools API unavailable (needs VS Code ≥ 1.95) — skipping.');
    return;
  }

  for (const def of TOOLS) {
    const tool: vscode.LanguageModelTool<Record<string, unknown>> = {
      async invoke(options, token) {
        void token;
        const input = (options.input ?? {}) as Record<string, unknown>;
        const args = def.transform ? def.transform(input) : input;
        try {
          const { text } = await client.callTool(def.mcpName, args);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(text || '(no results)'),
          ]);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          output.appendLine(`[lm-tool ${def.lmName}] ${m}`);
          return new vscode.LanguageModelToolResult([
            new vscode.LanguageModelTextPart(
              `Foundry local search is unavailable: ${m}. ` +
                'Check the "sweSearch.serverEntry" setting and that the index is built.',
            ),
          ]);
        }
      },
      prepareInvocation(options) {
        return { invocationMessage: def.label((options.input ?? {}) as Record<string, unknown>) };
      },
    };
    context.subscriptions.push(vscode.lm.registerTool(def.lmName, tool));
  }

  output.appendLine(`[lm-tools] registered ${TOOLS.length} Foundry Language Model tools.`);
}
