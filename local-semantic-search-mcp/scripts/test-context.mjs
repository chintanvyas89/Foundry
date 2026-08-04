// Unit test for structural context expansion in semantic_search: with
// context=true, each hit is annotated with its callers/callees from the
// persisted call graph; with it off (default), output stays token-lean.
// Uses a fake MCP server to capture the handler and drives it against a seeded
// store (real embedder for the query + chunk vectors, seeded edges).
//   node scripts/test-context.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore } from '../dist/storage/store.js';
import { registerSemanticSearchTool } from '../dist/tools/semanticSearch.js';
import { embed, initEmbedder } from '../dist/embedding/embedder.js';

const WS = '/repo';
const CONFIG = { model: 'onnx-community/embeddinggemma-300m-ONNX', dtype: 'q8', topKDefault: 8 };
const dbPath = join(tmpdir(), `context-test-${Date.now()}.db`);
const store = new VectorStore(dbPath);
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };

await initEmbedder(CONFIG);

// Two symbols, alpha() -> beta(), embedded from their own text so a query for
// "alpha" ranks them.
const chunk = async (id, file, symbol, text) => ({
  id, file, symbol, startLine: 1, endLine: 3, text, contentHash: id,
  embedding: await embed(text),
});
store.upsertChunks([
  await chunk('c1', 'alpha.ts', 'alpha', 'function alpha() {\n  return beta();\n}'),
  await chunk('c2', 'beta.ts', 'beta', 'function beta() {\n  return 42;\n}'),
]);
store.upsertEdges([
  { fromFile: 'alpha.ts', fromLine: 1, fromName: 'alpha', toFile: 'beta.ts', toLine: 1, toName: 'beta', viaFile: 'alpha.ts' },
]);

// Capture the registered handler.
let handler;
const server = { tool: (_n, _d, _s, fn) => { handler = fn; } };
registerSemanticSearchTool(server, store, CONFIG, WS, Promise.resolve());
const run = (args) => handler(args);
const textOf = (res) => res.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

// Default (no context): token-lean, no call-graph annotation.
const plain = await run({ query: 'alpha function' });
const plainText = textOf(plain);
assert(!/calls:|called by:/.test(plainText), 'default output has no structural-context lines');

// context=true: alpha shows what it calls, beta shows who calls it.
const ctx = await run({ query: 'alpha function', context: true });
const ctxText = textOf(ctx);
console.log('\n--- context=true ---\n' + ctxText + '\n');
assert(/calls: beta/.test(ctxText), 'alpha is annotated with "calls: beta"');
assert(/called by: alpha/.test(ctxText), 'beta is annotated with "called by: alpha"');

// context is per-result in structuredContent too.
const alphaRes = ctx.structuredContent.results.find((r) => r.symbol === 'alpha');
assert(alphaRes?.context?.callees?.[0]?.name === 'beta', 'structuredContent carries callees for alpha');

store.close();
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
console.log('\nAll structural-context tests passed.');
