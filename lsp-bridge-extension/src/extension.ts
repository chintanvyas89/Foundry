import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs';
import { getPipePath } from './pipeName';
import { getSymbolsForFile } from './symbolProvider';

let server: net.Server | undefined;
let statusItem: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return; // Nothing to bridge without an open workspace.
  }

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
  let msg: { id: string; type: string; file: string };
  try {
    msg = JSON.parse(line);
  } catch {
    return; // Malformed request — drop it, don't crash the bridge.
  }
  try {
    const symbols = await getSymbolsForFile(msg.file);
    socket.write(JSON.stringify({ id: msg.id, symbols }) + '\n');
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
}
