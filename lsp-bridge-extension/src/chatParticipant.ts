import * as vscode from 'vscode';
import type { SearchClient } from './searchClient';
import { moduleGraphMermaid, callGraphMermaid, type ModuleNode, type FlowNodeLite } from './mermaid';
import type { SearchHit } from './planContext';
import { runAgentTurn } from './implement';

// The @codebase chat participant. `/index`, `/arch`, `/graph` are deterministic,
// LLM-free commands (no model call). Everything else — Q&A, proposing a plan,
// or actually making a change — goes through ONE agentic loop (implement.ts →
// executor/planAgent.ts): the model itself decides, from what was asked,
// whether to just answer, propose a plan, or ground itself and edit. There is
// no separate "/plan"/"/implement" split — that used to mean two independent
// conversations, so the execution phase re-discovered whatever planning had
// already found. One continuous conversation fixes that at the source.

const PARTICIPANT_ID = 'foundry.codebase';

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  client: SearchClient,
  output: vscode.OutputChannel,
): void {
  if (typeof vscode.chat?.createChatParticipant !== 'function') {
    output.appendLine('[chat] Chat participant API unavailable — skipping @codebase.');
    return;
  }

  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
    if (!serverConfigured()) {
      stream.markdown(
        'Set **`sweSearch.serverEntry`** to the absolute path of ' +
          '`local-semantic-search-mcp/dist/index.js`, then try again — that’s the local ' +
          'index @codebase reads from.',
      );
      return {};
    }

    try {
      // Deterministic, LLM-free slash commands for quick orientation.
      if (request.command === 'index') {
        return await renderTool(client, stream, 'repo_overview', {});
      }
      if (request.command === 'arch') {
        return await runArch(client, stream);
      }
      if (request.command === 'graph') {
        return await runGraph(request, client, stream, output);
      }
      return await runAgentTurn(request, chatContext, stream, token, output);
    } catch (err) {
      if (err instanceof vscode.CancellationError) return {};
      const m = err instanceof Error ? err.message : String(err);
      output.appendLine(`[chat] ${m}`);
      stream.markdown(`\n\n_Something went wrong: ${m}_`);
      return { errorDetails: { message: m } };
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'search.svg');
  participant.followupProvider = {
    provideFollowups() {
      return [
        { prompt: 'Summarize the architecture', label: 'Architecture overview', command: 'arch' },
        { prompt: 'What does the local index cover?', label: 'Index status', command: 'index' },
      ];
    },
  };
  context.subscriptions.push(participant);
  output.appendLine('[chat] registered @codebase participant.');
}

function serverConfigured(): boolean {
  return ((vscode.workspace.getConfiguration('sweSearch').get<string>('serverEntry') ?? '').trim()).length > 0;
}

// Run a tool and print its text output directly (no model call).
async function renderTool(
  client: SearchClient,
  stream: vscode.ChatResponseStream,
  mcpName: string,
  args: Record<string, unknown>,
): Promise<vscode.ChatResult> {
  const { text } = await client.callTool(mcpName, args);
  stream.markdown('```\n' + (text || '(no data — is the index built?)') + '\n```');
  return {};
}

// /arch — the architecture_overview text PLUS a Mermaid module dependency graph
// built from the same call's structuredContent. Deterministic (no model call).
async function runArch(client: SearchClient, stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
  const { text, structured } = await client.callTool('architecture_overview', {});
  stream.markdown('```\n' + (text || '(no data — is the index built?)') + '\n```');
  const modules = (structured as { modules?: ModuleNode[] } | undefined)?.modules;
  if (Array.isArray(modules) && modules.length > 0) {
    const mmd = moduleGraphMermaid(modules);
    if (mmd) stream.markdown('\n\n### Module dependency graph\n\n' + mmd);
  }
  return {};
}

// /graph <symbol> — a Mermaid call graph for a symbol (prefix "callers" to
// invert). Deterministic: resolves the symbol, walks the persisted call graph.
async function runGraph(
  request: vscode.ChatRequest,
  client: SearchClient,
  stream: vscode.ChatResponseStream,
  output: vscode.OutputChannel,
): Promise<vscode.ChatResult> {
  let arg = request.prompt.trim();
  let direction: 'callers' | 'callees' = 'callees';
  const m = /^(callers|callees)\s+(.*)$/i.exec(arg);
  if (m) {
    direction = m[1].toLowerCase() as 'callers' | 'callees';
    arg = m[2].trim();
  }
  if (!arg) {
    stream.markdown(
      'Give a symbol for a call graph — e.g. `@codebase /graph checkoutOrder` ' +
        '(or `/graph callers checkoutOrder` to invert). For the module map, use `/arch`.',
    );
    return {};
  }

  let hit: SearchHit | undefined;
  try {
    const { structured } = await client.callTool('search_symbol', { name: arg, limit: 1 });
    hit = (structured as { results?: SearchHit[] } | undefined)?.results?.[0];
  } catch (err) {
    output.appendLine(`[chat/graph] search_symbol failed: ${String(err)}`);
  }
  if (!hit?.symbol || !hit.file || !hit.startLine) {
    stream.markdown(`Couldn't find a symbol named \`${arg}\` in the index.`);
    return {};
  }

  let root: FlowNodeLite | undefined;
  try {
    const { structured } = await client.callTool('show_execution_flow', {
      file: hit.file,
      symbol: hit.symbol,
      line: hit.startLine,
      direction,
      depth: 3,
    });
    root = (structured as { root?: FlowNodeLite } | undefined)?.root;
  } catch (err) {
    output.appendLine(`[chat/graph] show_execution_flow failed: ${String(err)}`);
  }
  if (!root?.children || root.children.length === 0) {
    stream.markdown(
      `\`${hit.symbol}\` has no ${direction} in the call graph — build it with ` +
        '`SWE_BUILD_GRAPH=1` (or `SWE_BUILD_ALL=1`) if the graph is empty.',
    );
    return {};
  }
  stream.markdown(
    `### Call graph — ${direction} of \`${hit.symbol}\`\n\n` + callGraphMermaid(root, direction),
  );
  return {};
}
