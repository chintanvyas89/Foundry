import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';

export interface SearchResult {
  id: string;
  file: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

export interface SearchParams {
  query: string;
  topK: number;
  pins?: string[];
  note?: string;
  mode?: 'find' | 'refine' | 'expand';
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

// A tiny, dependency-free MCP client. The search server speaks JSON-RPC 2.0
// over newline-delimited JSON on stdio, so we spawn it and talk to it directly
// rather than pulling in the MCP SDK (the bridge ships with no runtime deps).
//
// The server is spawned in query-only mode: it loads the embedding model and
// answers searches against the existing index, but never builds, watches, or
// mutates it — so it coexists safely with the indexer VS Code runs for Copilot.
export class SearchClient {
  private proc: ChildProcess | undefined;
  private starting: Promise<void> | undefined;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly output: vscode.OutputChannel,
  ) {}

  async search(params: SearchParams): Promise<SearchResult[]> {
    await this.ensureStarted();

    const args: Record<string, unknown> = { query: params.query, topK: params.topK };
    if (params.pins && params.pins.length) args.pins = params.pins;
    if (params.note && params.note.trim()) args.note = params.note;
    if (params.mode && params.mode !== 'find') args.mode = params.mode;

    // The first query against a freshly spawned server waits for the model to
    // load (the server gates its tool on readiness), so allow a generous
    // timeout; later queries return in well under a second.
    const result = (await this.rpc(
      'tools/call',
      { name: 'semantic_search', arguments: args },
      180000,
    )) as { structuredContent?: { results?: SearchResult[] } } | undefined;

    const results = result?.structuredContent?.results;
    return Array.isArray(results) ? results : [];
  }

  async searchSymbol(name: string, limit: number): Promise<SearchResult[]> {
    await this.ensureStarted();
    const result = (await this.rpc(
      'tools/call',
      { name: 'search_symbol', arguments: { name, limit } },
      180000,
    )) as { structuredContent?: { results?: SearchResult[] } } | undefined;
    const results = result?.structuredContent?.results;
    return Array.isArray(results) ? results : [];
  }

  // Generic MCP tool passthrough — reuses the same query-only server + rpc
  // plumbing as search()/searchSymbol(). Returns the tool's text content (what
  // an LLM reads) plus its structuredContent (JSON, for callers that want it).
  // Used by the chat participant and the Language Model tools to reach every
  // MCP tool (trace_calls, find_usages, architecture_overview, …) without a
  // second subprocess.
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; structured: unknown }> {
    await this.ensureStarted();
    const result = (await this.rpc('tools/call', { name, arguments: args }, 180000)) as
      | { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown }
      | undefined;
    const text = (result?.content ?? [])
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n');
    return { text, structured: result?.structuredContent };
  }

  dispose(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill();
    }
    this.proc = undefined;
  }

  private config(): { serverEntry: string; nodePath: string } {
    const c = vscode.workspace.getConfiguration('sweSearch');
    return {
      serverEntry: (c.get<string>('serverEntry') ?? '').trim(),
      nodePath: (c.get<string>('nodePath') ?? '').trim() || 'node',
    };
  }

  private async ensureStarted(): Promise<void> {
    if (this.proc && !this.proc.killed) return;
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async start(): Promise<void> {
    const { serverEntry, nodePath } = this.config();
    if (!serverEntry) {
      throw new Error(
        'Set "sweSearch.serverEntry" to the absolute path of local-semantic-search-mcp/dist/index.js',
      );
    }

    const proc = spawn(nodePath, [serverEntry], {
      env: { ...process.env, WORKSPACE_ROOT: this.workspaceRoot, SWE_SEARCH_QUERY_ONLY: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdout!.setEncoding('utf-8');
    proc.stdout!.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr!.setEncoding('utf-8');
    proc.stderr!.on('data', (chunk: string) => this.output.append(chunk));

    proc.on('error', (err) => {
      this.output.appendLine(`[search] failed to spawn "${nodePath}": ${err.message}`);
      this.failAllPending(new Error(`could not start search server: ${err.message}`));
    });
    proc.on('exit', (code) => {
      this.output.appendLine(`[search] server exited (code ${code ?? 'null'})`);
      this.proc = undefined;
      this.buffer = '';
      this.failAllPending(new Error('search server exited'));
    });

    // MCP handshake: initialize, then the initialized notification.
    await this.rpc(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'swe-search-panel', version: '0.1.0' },
      },
      60000,
    );
    this.notify('notifications/initialized', {});
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;

      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // Not a JSON-RPC line (shouldn't happen on stdout) — ignore.
      }
      if (typeof msg.id !== 'number') continue; // Notification/log, not a reply.

      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(msg.error.message ?? 'RPC error'));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  private rpc(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(obj: unknown): void {
    this.proc?.stdin?.write(JSON.stringify(obj) + '\n');
  }

  private failAllPending(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
