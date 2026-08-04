#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { initEmbedder } from './embedding/embedder.js';
import { VectorStore } from './storage/store.js';
import { Indexer } from './indexing/indexer.js';
import { startWatcher } from './indexing/watcher.js';
import { buildCallGraph, updateFileGraph } from './indexing/graphBuilder.js';
import { relative, sep } from 'node:path';
import { acquireLock } from './lock.js';
import { registerSemanticSearchTool } from './tools/semanticSearch.js';
import { registerSearchSymbolTool } from './tools/searchSymbol.js';
import { registerTraceCallsTool } from './tools/traceCalls.js';
import { registerSymbolRefTools } from './tools/symbolRefs.js';

async function main() {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
  const { config, source: configSource, expectedPath: configExpectedPath } =
    loadConfig(workspaceRoot);

  // Everything below logs to stderr only — stdout is reserved for the MCP
  // stdio transport's protocol messages.
  console.error(`[swe-search] workspace: ${workspaceRoot}`);
  if (configSource) {
    console.error(`[swe-search] config: ${configSource}`);
  } else {
    // Explicitly report the path we looked for, so a config file placed
    // one directory too deep (e.g. inside .swe-search/) is obvious rather
    // than silently ignored.
    console.error(
      `[swe-search] config: none found at ${configExpectedPath} — using defaults`,
    );
  }

  const dataDir = join(workspaceRoot, '.swe-search');
  mkdirSync(dataDir, { recursive: true });
  const store = new VectorStore(join(dataDir, 'index.db'));

  // Query-only mode: never build, watch, or mutate the index — just load the
  // embedder and answer searches against whatever index already exists. This
  // is what a read-only client (e.g. the editor search panel) spawns so it can
  // query without spinning up a competing indexer or rebuilding on a model
  // mismatch. It deliberately does not touch the lock.
  const queryOnly =
    process.env.SWE_SEARCH_QUERY_ONLY === '1' || process.argv.includes('--query-only');

  // Single-instance guard for the build + watcher. If another MCP process is
  // already indexing this workspace, we still connect the MCP transport and
  // serve searches from the shared index (WAL keeps reads non-blocking) —
  // we just don't run a competing indexer.
  const holdsIndexLock = queryOnly ? false : acquireLock(join(dataDir, 'lock'));
  if (queryOnly) {
    console.error('[swe-search] query-only mode — serving search against the existing index');
  } else if (!holdsIndexLock) {
    console.error(
      '[swe-search] another indexer already holds the lock for this workspace — ' +
        'this instance will serve search from the existing index only',
    );
  }

  const server = new McpServer({ name: 'local-semantic-search', version: '0.1.0' });

  // Model load + full index can take well over a minute on a real repo (the
  // first run also downloads a few hundred MB of weights). That work must NOT
  // sit in front of server.connect(): the MCP client's `initialize` request
  // would time out before we ever answer it. So we connect the transport
  // first — answering `initialize` immediately — and do the heavy startup in
  // the background. The `ready` promise gates the search tool, so an early
  // query waits for indexing to finish instead of racing an empty store.
  const ready = (async () => {
    console.error('[swe-search] loading embedding model...');
    await initEmbedder(config);

    // Only the lock holder mutates the store — everyone else stops here.
    // The embedder is still loaded above so this instance can embed search
    // queries against the shared read-only view of the index.
    if (!holdsIndexLock) return;

    // Reject a stored index built with a different model/dtype (or a legacy
    // absolute-path index from before this version) — its vectors/paths aren't
    // compatible, so wipe and rebuild.
    const { rebuilt } = store.ensureModelStamp(config.model, config.dtype);
    if (rebuilt) {
      console.error(
        `[swe-search] existing index was built with a different model — rebuilding for ${config.model} (${config.dtype})`,
      );
    }

    const indexer = new Indexer(workspaceRoot, store, config.exclude);
    console.error('[swe-search] building initial index...');
    const startAt = Date.now();
    let lastLog = 0;
    const { files, chunks, embedded, skippedFiles, prunedFiles } = await indexer.buildFull((p) => {
      const now = Date.now();
      const isLast = p.done === p.total;
      // The first callback (done=0) fires right after the walk, before any
      // embedding starts — surface it as its own line so an oversized walk
      // (missing excludes, unignored generated dirs) is visible up front
      // instead of buried in throttled progress updates.
      if (p.done === 0) {
        lastLog = now;
        console.error(
          `[swe-search] walked ${p.total} files under ignore rules — starting embedding pass`,
        );
        return;
      }

      // Throttle to ~1 line/sec so a large repo doesn't flood the Output tab,
      // but always emit the very last update.
      if (isLast || now - lastLog >= 1000) {
        lastLog = now;
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
        const pending = p.total - p.done;
        const elapsed = Math.round((now - startAt) / 1000);
        console.error(
          `[swe-search] indexing ${pct}% — ${p.done}/${p.total} files, ${pending} pending, ` +
            `${p.chunks} chunks (${p.embedded} embedded, ${p.skippedFiles} unchanged) — ${elapsed}s`,
        );
      }
    });
    console.error(
      `[swe-search] index ready: ${chunks} chunks across ${files} files ` +
        `(${embedded} embedded this run, ${skippedFiles} files unchanged & skipped, ${prunedFiles} stale files pruned)`,
    );

    // Populate the FTS5 lexical index for hybrid search. buildFull only writes
    // FTS rows for files it (re)embedded this run, so an index built before FTS
    // existed — or one where unchanged files were skipped — needs a one-time
    // backfill. No-op once the counts line up.
    if (store.ftsAvailable()) {
      const backfilled = store.backfillFts();
      console.error(
        backfilled > 0
          ? `[swe-search] hybrid search: FTS5 lexical index backfilled (${backfilled} chunks)`
          : '[swe-search] hybrid search: FTS5 lexical index active',
      );
    } else {
      console.error('[swe-search] hybrid search: FTS5 unavailable in this sqlite — vector-only');
    }

    // Keep the persisted call graph current: after a watched file re-indexes,
    // refetch its edges (only if the graph has already been built, and only if
    // the bridge is reachable). Embedding-free.
    const onFileIndexed = (absPath: string) => {
      const rel = relative(workspaceRoot, absPath).split(sep).join('/');
      void updateFileGraph(workspaceRoot, store, rel).catch((err) =>
        console.error(`[swe-search] call graph: incremental update failed for ${rel}:`, err),
      );
    };
    startWatcher(workspaceRoot, indexer, config.exclude, onFileIndexed);
    console.error('[swe-search] incremental watch active');
  })();
  ready.catch((err) => console.error('[swe-search] background init failed:', err));

  // Explicit one-time call-graph build (opt-in via SWE_BUILD_GRAPH=1). Runs
  // DETACHED — never inside `ready`, which gates search — so a long LSP pass
  // doesn't block queries. Embedding-free: reads indexed symbols + the LSP
  // bridge, writes the shareable call_edges graph. Needs VS Code + the bridge
  // running; aborts cleanly if it isn't.
  if (holdsIndexLock && process.env.SWE_BUILD_GRAPH === '1') {
    void (async () => {
      await ready;
      console.error(
        '[swe-search] call graph: starting one-time build (needs the VS Code LSP bridge running)...',
      );
      const startAt = Date.now();
      let lastLog = 0;
      const stats = await buildCallGraph(workspaceRoot, store, {
        delayMs: 5,
        onProgress: (p) => {
          const now = Date.now();
          if (now - lastLog < 1000 && p.doneFiles !== p.totalFiles) return;
          lastLog = now;
          const elapsed = Math.round((now - startAt) / 1000);
          console.error(
            `[swe-search] call graph: ${p.doneFiles}/${p.totalFiles} files, ${p.edges} edges — ${elapsed}s`,
          );
        },
      });
      if (stats.bridgeDown) {
        console.error(
          '[swe-search] call graph: LSP bridge not reachable — build aborted. Open the ' +
            'workspace in VS Code with the extension active, then restart with SWE_BUILD_GRAPH=1. ' +
            '(It resumes where it left off.)',
        );
      } else {
        console.error(
          `[swe-search] call graph: done — ${stats.edges} edges across ${stats.filesProcessed} ` +
            `files (${stats.filesSkipped} already built). This index.db can be shared; teammates ` +
            'get the call graph offline (no bridge needed).',
        );
      }
    })().catch((err) => console.error('[swe-search] call graph build failed:', err));
  }

  registerSemanticSearchTool(server, store, config, workspaceRoot, ready);
  // Symbol-name lookup over the stored index — no embedder needed, so no `ready`
  // gate; returns whatever is already indexed.
  registerSearchSymbolTool(server, store, config, workspaceRoot);
  // Call-graph tool. Doesn't touch the embedder/store — it asks the LSP bridge
  // — so it needs no `ready` gate and works in query-only mode too.
  registerTraceCallsTool(server, store, workspaceRoot);
  // find_usages / find_implementations — also bridge-backed, no gate needed.
  registerSymbolRefTools(server, workspaceRoot);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[swe-search] MCP server connected (indexing in background)');
}

main().catch((err) => {
  console.error('[swe-search] fatal error:', err);
  process.exit(1);
});
