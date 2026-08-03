import * as net from 'node:net';
import { getPipePath } from './pipeName.js';

export interface BridgeSymbol {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface BridgeCallNode {
  name: string;
  detail: string;
  file: string;
  line: number;
  kind: string;
}

export interface BridgeCallHierarchy {
  root: BridgeCallNode | null;
  outgoing: BridgeCallNode[];
  incoming: BridgeCallNode[];
}

interface BridgeResponse {
  id: string;
  symbols?: BridgeSymbol[];
  calls?: BridgeCallHierarchy;
  error?: string;
}

const CONNECT_TIMEOUT_MS = 2000;
const REQUEST_TIMEOUT_MS = 8000; // generous — a language server's first
// activation for a given language can be slow.

let socket: net.Socket | null = null;
let connecting: Promise<net.Socket | null> | null = null;
let nextId = 1;
let buffer = '';
const pending = new Map<string, { resolve: (msg: BridgeResponse) => void; reject: (e: unknown) => void }>();

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
    let msg: BridgeResponse;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // Malformed line — drop it, don't take down the client.
    }
    const p = pending.get(msg.id);
    if (!p) continue;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg);
  }
}

// Send one request to the bridge and await its response. Returns null on any
// failure (no bridge running, timeout, malformed response) rather than throwing
// — every caller has a fallback and must never block on the bridge's absence.
async function sendRequest(
  workspaceRoot: string,
  payload: Record<string, unknown>,
): Promise<BridgeResponse | null> {
  try {
    const s = await getConnection(workspaceRoot);
    if (!s) return null;

    const id = String(nextId++);
    return await new Promise<BridgeResponse>((resolve, reject) => {
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
      s.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  } catch {
    return null;
  }
}

export async function getSymbolsViaBridge(
  workspaceRoot: string,
  filePath: string,
): Promise<BridgeSymbol[] | null> {
  const msg = await sendRequest(workspaceRoot, { type: 'getSymbols', file: filePath });
  return msg ? (msg.symbols ?? []) : null;
}

// Call hierarchy for the symbol at (file, line). Returns null when the bridge
// isn't reachable; returns a result with `root: null` when the language server
// has no call-hierarchy for that position.
export async function getCallHierarchyViaBridge(
  workspaceRoot: string,
  file: string,
  line: number,
  symbol?: string,
): Promise<BridgeCallHierarchy | null> {
  const msg = await sendRequest(workspaceRoot, { type: 'callHierarchy', file, line, symbol });
  return msg?.calls ?? null;
}
