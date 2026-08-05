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
import { indexState } from './indexing/indexState.js';
import { buildCallGraph, updateFileGraph } from './indexing/graphBuilder.js';
import { buildSymbols, updateFileSymbols } from './indexing/symbolBuilder.js';
import { buildUsages, updateFileUsages } from './indexing/usageBuilder.js';
import { buildImpls, updateFileImpls } from './indexing/implsBuilder.js';
import { buildConfig, updateFileConfig } from './indexing/configBuilder.js';
import { isConfigFile } from './config-index/registry.js';
import { initConfigIndex } from './config-index/settings.js';
import { relative, sep } from 'node:path';
import { acquireLock } from './lock.js';
import { registerSemanticSearchTool } from './tools/semanticSearch.js';
import { registerSearchSymbolTool } from './tools/searchSymbol.js';
import { registerTraceCallsTool } from './tools/traceCalls.js';
import { registerExecutionFlowTool } from './tools/showExecutionFlow.js';
import { registerSymbolRefTools } from './tools/symbolRefs.js';
import { registerRepoOverviewTool } from './tools/repoOverview.js';
import { registerArchitectureOverviewTool } from './tools/architectureOverview.js';
import { registerReadFileTool } from './tools/readFile.js';
import { registerListDirectoryTool } from './tools/listDirectory.js';
import { registerProjectStandardsTool } from './tools/projectStandards.js';
import { registerSearchConfigTool } from './tools/searchConfig.js';

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
    // queries against the shared read-only view of the index. Open search
    // immediately against the existing index (there's no build to wait for).
    if (!holdsIndexLock) {
      indexState.markSearchable();
      return;
    }

    // Reject a stored index built with a different model/dtype (or a legacy
    // absolute-path index from before this version) — its vectors/paths aren't
    // compatible, so wipe and rebuild.
    const { rebuilt } = store.ensureModelStamp(config.model, config.dtype);
    if (rebuilt) {
      console.error(
        `[swe-search] existing index was built with a different model — rebuilding for ${config.model} (${config.dtype})`,
      );
    }

    // SWE_REINDEX_EXT=.php,.module — targeted re-index. Drops the stored chunks +
    // file-hash for files with these extensions so the build below re-chunks and
    // re-embeds just them (e.g. to pick up newly-added PHP tree-sitter chunking)
    // without a full re-embed of the whole repo. Applied only by the lock-holding
    // build server; a no-op for query-only servers.
    const reindexExt = (process.env.SWE_REINDEX_EXT ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    if (reindexExt.length > 0 && !rebuilt) {
      const invalidated = store.invalidateByExtensions(reindexExt);
      console.error(
        `[swe-search] SWE_REINDEX_EXT: invalidated ${invalidated} file(s) matching ${reindexExt.join(', ')} — they will re-chunk & re-embed this run`,
      );
    }

    // Resolve which extensions are structured config (and which reader packs are
    // enabled) for this workspace BEFORE indexing, so the indexer/chunker keep
    // config out of the vector store from the first file.
    const cfgIndex = initConfigIndex(workspaceRoot);
    console.error(
      `[swe-search] config index: extensions ${cfgIndex.extensions.join(', ')}` +
        `${cfgIndex.packs.length ? ` · packs ${cfgIndex.packs.join(', ')}` : ' · packs (none — generic only)'}`,
    );

    const indexer = new Indexer(workspaceRoot, store, config.exclude);
    console.error('[swe-search] building initial index...');
    const startAt = Date.now();
    let lastLog = 0;
    const onSearchable = () => {
      if (config.lazyIndex && indexState.building) {
        console.error('[swe-search] search is now open (hot set embedded) — indexing continues in the background');
      }
      indexState.markSearchable();
    };
    const { files, chunks, embedded, skippedFiles, prunedFiles } = await indexer.buildFull({
      lazy: config.lazyIndex,
      hotSet: config.lazyHotSet,
      onSearchable,
      onProgress: (p) => {
      const now = Date.now();
      const isLast = p.done === p.total;
      // The first callback (done=0) fires right after the walk, before any
      // embedding starts — surface it as its own line so an oversized walk
      // (missing excludes, unignored generated dirs) is visible up front
      // instead of buried in throttled progress updates.
      if (p.done === 0) {
        indexState.beginBuild(p.total);
        lastLog = now;
        console.error(
          `[swe-search] walked ${p.total} files under ignore rules — starting embedding pass`,
        );
        return;
      }
      indexState.progress(p.done);

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
      },
    });
    indexState.finishBuild();
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
      // Config (YAML) never enters the code indexes — keep only the embedding-free
      // config index current (no-op until it's been built).
      if (isConfigFile(rel)) {
        try {
          updateFileConfig(workspaceRoot, store, rel);
        } catch (err) {
          console.error(`[swe-search] config: incremental update failed for ${rel}:`, err);
        }
        return;
      }
      void updateFileGraph(workspaceRoot, store, rel).catch((err) =>
        console.error(`[swe-search] call graph: incremental update failed for ${rel}:`, err),
      );
      // Keep the standalone symbol table current too (no-op until it's built).
      void updateFileSymbols(workspaceRoot, store, rel)
        .catch((err) =>
          console.error(`[swe-search] symbols: incremental update failed for ${rel}:`, err),
        )
        // Refresh this file's usages after its symbols are current (also a no-op
        // until the usages index has been built). Chained so it reads fresh
        // symbol rows.
        .then(() =>
          updateFileUsages(workspaceRoot, store, rel).catch((err) =>
            console.error(`[swe-search] usages: incremental update failed for ${rel}:`, err),
          ),
        )
        .then(() =>
          updateFileImpls(workspaceRoot, store, rel).catch((err) =>
            console.error(`[swe-search] impls: incremental update failed for ${rel}:`, err),
          ),
        );
    };
    startWatcher(workspaceRoot, indexer, config.exclude, onFileIndexed);
    console.error('[swe-search] incremental watch active');
  })();
  ready.catch((err) => {
    console.error('[swe-search] background init failed:', err);
    // Unblock the search gate with the error instead of hanging forever.
    indexState.failInit(err);
  });

  // Explicit one-time index builds — all opt-in, DETACHED (never inside `ready`,
  // which gates search, so a long LSP pass doesn't block queries), and
  // EMBEDDING-FREE (they read the LSP bridge + already-indexed data and never
  // re-chunk or re-embed). Each writes a shareable table into index.db. Set an
  // individual flag to build one, or SWE_BUILD_ALL=1 to build them in dependency
  // order (symbols first — usages/impls key off it). All are resumable: a build
  // that aborts (bridge down) continues where it left off on restart.
  type BuildResult = {
    bridgeDown: boolean;
    noSymbols?: boolean;
    filesProcessed: number;
    filesSkipped: number;
  };
  const builds: Array<{
    flag: string;
    label: string;
    unit: string;
    run: (onProgress: (p: { doneFiles: number; totalFiles: number }) => void) => Promise<BuildResult>;
    total: () => number;
  }> = [
    {
      // Config parses YAML only — no LSP bridge, so it's listed first and always
      // completes even when the bridge-backed builds below abort.
      flag: 'SWE_BUILD_CONFIG', label: 'config', unit: 'items',
      run: (onProgress) => buildConfig(workspaceRoot, store, { delayMs: 2, onProgress }),
      total: () => store.configStats().items,
    },
    {
      flag: 'SWE_BUILD_SYMBOLS', label: 'symbols', unit: 'symbols',
      run: (onProgress) => buildSymbols(workspaceRoot, store, { delayMs: 5, onProgress }),
      total: () => store.symbolStats().symbols,
    },
    {
      flag: 'SWE_BUILD_GRAPH', label: 'call graph', unit: 'edges',
      run: (onProgress) => buildCallGraph(workspaceRoot, store, { delayMs: 5, onProgress }),
      total: () => store.graphStats().edges,
    },
    {
      flag: 'SWE_BUILD_USAGES', label: 'usages', unit: 'references',
      run: (onProgress) => buildUsages(workspaceRoot, store, { delayMs: 5, onProgress }),
      total: () => store.usageStats().refs,
    },
    {
      flag: 'SWE_BUILD_IMPLS', label: 'implementations', unit: 'implementations',
      run: (onProgress) => buildImpls(workspaceRoot, store, { delayMs: 5, onProgress }),
      total: () => store.implStats().impls,
    },
  ];

  const buildAll = process.env.SWE_BUILD_ALL === '1';
  const selected = builds.filter((b) => buildAll || process.env[b.flag] === '1');
  if (holdsIndexLock && selected.length > 0) {
    void (async () => {
      // Wait for the WHOLE embedding pass (not just `searchable`) so these
      // passes iterate the complete file/symbol set, not a partial hot set.
      await indexState.indexComplete;
      if (buildAll) {
        console.error(
          '[swe-search] build-all: config → symbols → call graph → usages → implementations ' +
            '(one-time; config needs no bridge, the rest need the VS Code LSP bridge running)...',
        );
      }
      for (const b of selected) {
        console.error(`[swe-search] ${b.label}: starting one-time build...`);
        const startAt = Date.now();
        let lastLog = 0;
        const stats = await b.run((p) => {
          const now = Date.now();
          if (now - lastLog < 1000 && p.doneFiles !== p.totalFiles) return;
          lastLog = now;
          console.error(
            `[swe-search] ${b.label}: ${p.doneFiles}/${p.totalFiles} files — ` +
              `${Math.round((now - startAt) / 1000)}s`,
          );
        });
        if (stats.noSymbols) {
          console.error(
            `[swe-search] ${b.label}: the symbol table is empty — build it first with ` +
              'SWE_BUILD_SYMBOLS=1 (or SWE_BUILD_ALL=1).',
          );
          if (buildAll) break;
        } else if (stats.bridgeDown) {
          console.error(
            `[swe-search] ${b.label}: LSP bridge not reachable — build aborted. Open VS Code ` +
              'with the extension active and restart. (It resumes where it left off.)',
          );
          if (buildAll) break;
        } else {
          console.error(
            `[swe-search] ${b.label}: done — ${b.total()} ${b.unit} (${stats.filesProcessed} files ` +
              `this run, ${stats.filesSkipped} already built). Shareable in index.db; teammates get ` +
              'it offline (no bridge needed).',
          );
        }
      }
      if (buildAll) console.error('[swe-search] build-all: complete.');
    })().catch((err) => console.error('[swe-search] index build failed:', err));
  }

  // Search gates on `searchable` (embedder loaded + hot set embedded), not the
  // full build — so on a fresh repo it opens in seconds and streams the rest.
  registerSemanticSearchTool(server, store, config, workspaceRoot, indexState.searchable);
  // Symbol-name lookup over the stored index — no embedder needed, so no `ready`
  // gate; returns whatever is already indexed.
  registerSearchSymbolTool(server, store, config, workspaceRoot);
  // Call-graph tool. Doesn't touch the embedder/store — it asks the LSP bridge
  // — so it needs no `ready` gate and works in query-only mode too.
  registerTraceCallsTool(server, store, workspaceRoot);
  // Multi-level execution-flow walk over the persisted call graph — offline, no
  // embedder/bridge needed at query time (needs the graph to have been built).
  registerExecutionFlowTool(server, store, workspaceRoot);
  // find_usages / find_implementations — also bridge-backed, no gate needed.
  registerSymbolRefTools(server, store, workspaceRoot);
  // Workspace orientation summary — reads stored counts only, no gate.
  registerRepoOverviewTool(server, store, workspaceRoot);
  // Deterministic module-level architecture map — aggregates the persisted
  // symbols/usages/graph indexes; no gate, no re-index.
  registerArchitectureOverviewTool(server, store);

  registerReadFileTool(server, workspaceRoot);

  registerListDirectoryTool(server, workspaceRoot, config.exclude);

  registerProjectStandardsTool(server, workspaceRoot);

  // Keyword search over the embedding-free config index (YAML is never embedded).
  registerSearchConfigTool(server, store, workspaceRoot);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[swe-search] MCP server connected (indexing in background)');
}

main().catch((err) => {
  console.error('[swe-search] fatal error:', err);
  process.exit(1);
});
