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
