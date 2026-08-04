// Unit test for the standalone symbols table + search_symbol union
// (embedding-free — no vectors). Seeds chunk symbols (callables, with bodies)
// and symbol-table rows (all kinds, incl. non-callable), then drives the
// search_symbol handler via a fake MCP server.
//   node scripts/test-symbols.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore } from '../dist/storage/store.js';
import { registerSearchSymbolTool } from '../dist/tools/searchSymbol.js';

const WS = '/repo';
const dbPath = join(tmpdir(), `symbols-test-${Date.now()}.db`);
const store = new VectorStore(dbPath);
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };

// ---- store-level ----------------------------------------------------------
assert(store.symbolStats().symbols === 0, 'symbol table starts empty');

// A callable chunk (has a body) for VectorStore's method, plus a fake embedding.
store.upsertChunks([
  {
    id: 'c1', file: 'src/store.ts', symbol: 'searchSymbols', startLine: 10, endLine: 20,
    text: 'searchSymbols(query) { /* ... */ }', contentHash: 'h1',
    embedding: new Float32Array(768),
  },
]);
// Symbol-table rows: the same callable (kind Method) + non-callable kinds.
store.upsertSymbols('src/store.ts', [
  { name: 'searchSymbols', kind: 'Method', startLine: 10, endLine: 20 },
  { name: 'VectorStore', kind: 'Class', startLine: 1, endLine: 200 },
]);
store.upsertSymbols('src/types.ts', [
  { name: 'CallGraphNode', kind: 'Interface', startLine: 5, endLine: 9 },
  { name: 'SymbolKind', kind: 'Enum', startLine: 12, endLine: 30 },
]);

assert(store.symbolStats().symbols === 4, 'four symbols persisted');
assert(store.searchSymbolsTable('CallGraph')[0]?.kind === 'Interface', 'table lookup finds non-callable Interface');

// Rescan replaces a file's rows (delete-then-insert), no stale duplicates.
store.upsertSymbols('src/types.ts', [
  { name: 'CallGraphNode', kind: 'Interface', startLine: 5, endLine: 9 },
]);
assert(store.symbolStats().symbols === 3, 'rescan of a file replaces its rows (no duplicates)');

// Build marker round-trips (resumable build).
store.setSymbolFileHash('src/store.ts', 'hashA');
assert(store.getSymbolFileHash('src/store.ts') === 'hashA', 'symbol file hash round-trips');
assert(store.getSymbolFileHash('src/nope.ts') === null, 'unscanned file has no hash');

// ---- search_symbol union --------------------------------------------------
let handler;
registerSearchSymbolTool({ tool: (_n, _d, _s, fn) => { handler = fn; } }, store, { topKDefault: 8 }, WS);
const textOf = (res) => res.content.map((c) => c.text).join('');

// Non-callable: found via the table, rendered with kind, no code fence.
const iface = await handler({ name: 'CallGraphNode' });
const ifaceText = textOf(iface);
assert(/CallGraphNode/.test(ifaceText) && /Interface/.test(ifaceText), 'search_symbol finds a non-callable Interface with its kind');
assert(!ifaceText.includes('```'), 'non-callable hit has no code fence (location + kind only)');

// Callable: merged from chunk (body) + table (kind).
const method = await handler({ name: 'searchSymbols' });
const methodText = textOf(method);
assert(methodText.includes('```'), 'callable hit still shows its code body');
assert(/Method/.test(methodText), 'callable hit is annotated with its kind from the table');
const methodRes = method.structuredContent.results.filter((r) => r.symbol === 'searchSymbols');
assert(methodRes.length === 1, 'callable present once (merged, not duplicated across sources)');

store.close();
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
console.log('\nAll symbols-table tests passed.');
