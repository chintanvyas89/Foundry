import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import { getPipePath } from './pipeName';
import { getSymbolsForFile, getAllSymbolsForFile } from './symbolProvider';
import { getCallHierarchy } from './callHierarchy';
import { getReferences, getImplementations } from './references';
import { resolveWorkspaceSymbol } from './workspaceSymbol';
import { SearchClient } from './searchClient';
import { registerSearchCommands } from './searchCommands';
import { SearchPanelProvider } from './searchPanel';
import { registerLanguageModelTools } from './languageModelTools';
import { registerChatParticipant } from './chatParticipant';
import { FOUNDRY_AGENT_MD, FOUNDRY_AGENT_NAME, FOUNDRY_AGENT_REL_PATH } from './foundryAgent';
import * as path from 'path';

let server: net.Server | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let searchClient: SearchClient | undefined;

export function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return; // Nothing to bridge or search without an open workspace.
  }

  // No-LLM semantic search commands, backed by a query-only search server.
  const searchOutput = vscode.window.createOutputChannel('Semantic Search');
  context.subscriptions.push(searchOutput);
  searchClient = new SearchClient(workspaceRoot, searchOutput);
  context.subscriptions.push({ dispose: () => searchClient?.dispose() });
  registerSearchCommands(context, searchClient);

  // Copilot-facing surfaces over the same local index (one shared client):
  // the foundry_* Language Model tools (incl. #foundryCodebase) and the
  // @codebase chat participant. Both no-op gracefully on older VS Code.
  registerLanguageModelTools(context, searchClient, searchOutput);
  registerChatParticipant(context, searchClient, searchOutput);

  // Relevance-feedback drilldown panel (sidebar).
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SearchPanelProvider.viewType,
      new SearchPanelProvider(context.extensionUri, searchClient),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand('sweSearch.focusPanel', () =>
      vscode.commands.executeCommand('sweSearch.panel.focus'),
    ),
    // Hand off a plan/answer from @codebase (read-only) to VS Code's built-in
    // agent mode (which has edit/terminal tools). Invoked by the "⚡ Implement in
    // agent mode" button rendered in @codebase responses. The agent can still
    // call the foundry_* tools / foundry_plan for more search and planning.
    vscode.commands.registerCommand(
      'foundry.implementPlan',
      async (payload?: string | { request?: string; content?: string }) => {
      // Accept the structured payload from the button, or a bare string (older
      // buttons / manual invocation).
      const request = typeof payload === 'object' ? (payload?.request ?? '').trim() : '';
      const content = (typeof payload === 'string' ? payload : payload?.content ?? '').trim();
      if (!content) {
        vscode.window.showInformationMessage('Nothing to implement — no plan text was captured.');
        return;
      }
      // LEAN sectioned prompt: the tool policy / working rules now live in the
      // "Foundry" custom agent (.github/agents/foundry.agent.md), so the query is
      // just the user's intent + the authoritative plan, plus one line reminding
      // the agent to follow the plan (survives even if the agent isn't selected).
      const sections = [
        '# Implement the plan below',
        'The plan below was produced by a codebase-aware analysis and is **authoritative** — ' +
          'follow it. Execute the steps in order; do not re-derive the solution or run a ' +
          'discovery loop to rediscover it. Explore only for a missing detail, only after ' +
          'starting, and only with the Foundry (foundry_*) tools.',
        request ? `## Original request (the user's intent)\n\n${request}` : '',
        `## Plan to implement (authoritative — follow these steps in order)\n\n${content}`,
      ];
      const query = sections.filter(Boolean).join('\n\n');
      // Prefer the "Foundry" custom agent (tool scope + full policy live in the agent
      // file). Fall back to plain agent mode, then a bare open, for older VS Code or
      // when the agent file isn't installed. Some builds ignore an unknown mode rather
      // than throwing, which is fine — the query still lands in a usable chat.
      const attempts: Array<Record<string, unknown>> = [
        { query, mode: FOUNDRY_AGENT_NAME },
        { query, mode: 'agent' },
        { query },
      ];
      let opened = false;
      for (const args of attempts) {
        try {
          await vscode.commands.executeCommand('workbench.action.chat.open', args);
          opened = true;
          break;
        } catch {
          /* try the next fallback */
        }
      }
      if (!opened) {
        vscode.window.showWarningMessage("Couldn't open chat for implementation.");
      }
    }),
    // Scaffold the "Foundry" custom agent into the workspace so agent-mode work is
    // scoped to the local index. One-click adoption; the file is committable/shareable.
    vscode.commands.registerCommand('foundry.installAgent', async () => {
      try {
        const dest = vscode.Uri.file(path.join(workspaceRoot, FOUNDRY_AGENT_REL_PATH));
        let exists = false;
        try {
          await vscode.workspace.fs.stat(dest);
          exists = true;
        } catch {
          /* not present yet */
        }
        if (exists) {
          const pick = await vscode.window.showWarningMessage(
            `${FOUNDRY_AGENT_REL_PATH} already exists. Overwrite it?`,
            'Overwrite',
            'Cancel',
          );
          if (pick !== 'Overwrite') return;
        }
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.file(path.join(workspaceRoot, path.dirname(FOUNDRY_AGENT_REL_PATH))),
        );
        await vscode.workspace.fs.writeFile(dest, Buffer.from(FOUNDRY_AGENT_MD, 'utf8'));
        vscode.window.showInformationMessage(
          `Installed the "${FOUNDRY_AGENT_NAME}" agent at ${FOUNDRY_AGENT_REL_PATH}. ` +
            'Pick it from the chat mode dropdown, and verify its edit/run tools in the Tools picker.',
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Couldn't install the Foundry agent: ${String(err)}`);
      }
    }),
  );

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
  statusItem.text = '$(circle-outline) LSP Bridge: starting';
  statusItem.tooltip = 'Local semantic search LSP bridge — no network access';
  statusItem.show();
  context.subscriptions.push(statusItem);

  const pipePath = getPipePath(workspaceRoot);
  removeStaleSocket(pipePath);

  server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf-8');
    socket.on('data', async (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) {
          await handleRequest(socket, line);
        }
      }
    });
  });

  server.on('error', (err) => {
    statusItem!.text = '$(warning) LSP Bridge: error';
    console.error('[lsp-bridge] server error:', err);
  });

  server.listen(pipePath, () => {
    // Restrict the socket file to the current user on Unix — no other
    // local account should be able to connect. Named pipes on Windows
    // default to the creating session; no equivalent step needed there.
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(pipePath, 0o600);
      } catch {
        /* best effort */
      }
    }
    statusItem!.text = '$(check) LSP Bridge: listening';
  });

  context.subscriptions.push({ dispose: () => server?.close() });
}

async function handleRequest(socket: net.Socket, line: string) {
  let msg: { id: string; type: string; file: string; line?: number; symbol?: string; query?: string };
  try {
    msg = JSON.parse(line);
  } catch {
    return; // Malformed request — drop it, don't crash the bridge.
  }
  try {
    if (msg.type === 'callHierarchy') {
      const calls = await getCallHierarchy(msg.file, msg.line ?? 1, msg.symbol);
      socket.write(JSON.stringify({ id: msg.id, calls }) + '\n');
    } else if (msg.type === 'references') {
      const refs = await getReferences(msg.file, msg.line ?? 1, msg.symbol);
      socket.write(JSON.stringify({ id: msg.id, refs }) + '\n');
    } else if (msg.type === 'implementations') {
      const refs = await getImplementations(msg.file, msg.line ?? 1, msg.symbol);
      socket.write(JSON.stringify({ id: msg.id, refs }) + '\n');
    } else if (msg.type === 'workspaceSymbol') {
      const workspaceSymbols = await resolveWorkspaceSymbol(msg.query ?? '');
      socket.write(JSON.stringify({ id: msg.id, workspaceSymbols }) + '\n');
    } else if (msg.type === 'allSymbols') {
      // All indexable declaration kinds for the standalone symbols table —
      // separate from the chunking symbol stream below, so it can't change
      // chunk boundaries / embeddings.
      const symbols = await getAllSymbolsForFile(msg.file);
      socket.write(JSON.stringify({ id: msg.id, symbols }) + '\n');
    } else {
      const symbols = await getSymbolsForFile(msg.file);
      socket.write(JSON.stringify({ id: msg.id, symbols }) + '\n');
    }
  } catch (err) {
    socket.write(JSON.stringify({ id: msg.id, error: String(err) }) + '\n');
  }
}

function removeStaleSocket(pipePath: string) {
  if (process.platform === 'win32') return; // Named pipes leave no file behind.
  try {
    fs.unlinkSync(pipePath);
  } catch {
    /* fine if it didn't exist */
  }
}

export function deactivate() {
  server?.close();
  searchClient?.dispose();
}
