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
import { registerSemanticSearchTool } from './tools/semanticSearch.js';

async function main() {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
  const config = loadConfig(workspaceRoot);

  // Everything below logs to stderr only — stdout is reserved for the MCP
  // stdio transport's protocol messages.
  const dataDir = join(workspaceRoot, '.swe-search');
  mkdirSync(dataDir, { recursive: true });
  const store = new VectorStore(join(dataDir, 'index.db'));

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

    const indexer = new Indexer(workspaceRoot, store);
    console.error('[swe-search] building initial index...');
    const { files, chunks, embedded, skippedFiles } = await indexer.buildFull();
    console.error(
      `[swe-search] index ready: ${chunks} chunks across ${files} files ` +
        `(${embedded} embedded this run, ${skippedFiles} files unchanged & skipped)`,
    );

    startWatcher(workspaceRoot, indexer);
    console.error('[swe-search] incremental watch active');
  })();
  ready.catch((err) => console.error('[swe-search] background init failed:', err));

  registerSemanticSearchTool(server, store, config, ready);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[swe-search] MCP server connected (indexing in background)');
}

main().catch((err) => {
  console.error('[swe-search] fatal error:', err);
  process.exit(1);
});
