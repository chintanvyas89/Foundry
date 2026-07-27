import * as net from 'node:net';
import { getPipePath } from './pipeName.js';

export interface BridgeSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

const CONNECT_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 8000; // generous — a language server's first
// activation for a given language can be slow.

let socket: net.Socket | null = null;
let connecting: Promise<net.Socket | null> | null = null;
let nextId = 1;
let buffer = '';
const pending = new Map<string, { resolve: (v: BridgeSymbol[]) => void; reject: (e: unknown) => void }>();

async function getConnection(workspaceRoot: string): Promise<net.Socket | null> {
  if (socket && !socket.destroyed) return socket;
  if (connecting) return connecting;

  connecting = new Promise((resolve) => {
    const pipePath = getPipePath(workspaceRoot);
    const s = net.createConnection(pipePath);

    const timer = setTimeout(() => {
      s.destroy();
      resolve(null);
    }, CONNECT_TIMEOUT_MS);

    s.once('connect', () => {
      clearTimeout(timer);
      socket = s;
      s.setEncoding('utf-8');
      s.on('data', onData);
      s.on('close', () => {
        socket = null;
      });
      s.on('error', () => {
        socket = null;
      });
      resolve(s);
    });
    // No bridge listening — this is the expected, common case when the
    // companion extension isn't installed or no VS Code window has this
    // workspace open. Fail quietly, the caller falls back.
    s.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  const result = await connecting;
  connecting = null;
  return result;
}

function onData(chunk: string) {
  buffer += chunk;
  let idx: number;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    let msg: { id: string; symbols?: BridgeSymbol[]; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // Malformed line — drop it, don't take down the client.
    }
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.symbols ?? []);
  }
}

/**
 * Returns null on any failure (no bridge running, timeout, malformed
 * response) rather than throwing — the caller always has a fallback tier
 * to move to. This function never blocks indexing on the bridge's absence.
 */
export async function getSymbolsViaBridge(
  workspaceRoot: string,
  filePath: string,
): Promise<BridgeSymbol[] | null> {
  try {
    const s = await getConnection(workspaceRoot);
    if (!s) return null;

    const id = String(nextId++);
    return await new Promise<BridgeSymbol[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('LSP bridge request timed out'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      s.write(JSON.stringify({ id, type: 'getSymbols', file: filePath }) + '\n');
    });
  } catch {
    return null;
  }
}
