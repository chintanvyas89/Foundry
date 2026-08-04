// Unit test for the persisted implementations index + find_implementations
// offline fallback (embedding-free). Seeds symbol_impls, then drives the
// find_implementations handler via a fake MCP server. With no bridge running,
// the live path returns null and the tool falls back to the persisted index.
//   node scripts/test-impls.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore } from '../dist/storage/store.js';
import { registerSymbolRefTools } from '../dist/tools/symbolRefs.js';

const WS = '/repo';
const dbPath = join(tmpdir(), `impls-test-${Date.now()}.db`);
const store = new VectorStore(dbPath);
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };

// ---- store-level ----------------------------------------------------------
assert(store.implStats().impls === 0, 'impls index starts empty');

const impl = (f, l, txt) => ({
  defFile: 'src/types.ts', defName: 'Store',
  implFile: f, implLine: l, implText: txt, viaFile: 'src/types.ts',
});
store.upsertImpls([
  impl('src/storage/store.ts', 87, 'export class VectorStore implements Store'),
  impl('src/storage/memStore.ts', 12, 'export class MemStore implements Store'),
]);
assert(store.implStats().impls === 2, 'two implementations persisted');

const impls = store.getImplementations('src/types.ts', 'Store');
assert(impls.length === 2, 'getImplementations returns both');
assert(impls[0].text.includes('implements Store'), 'implementation carries its source line');

// Idempotent + incremental wipe.
store.upsertImpls([impl('src/storage/store.ts', 87, 'export class VectorStore implements Store')]);
assert(store.implStats().impls === 2, 'duplicate implementation insert is ignored');
store.deleteImplsByViaFile('src/types.ts');
assert(store.getImplementations('src/types.ts', 'Store').length === 0, 'deleteImplsByViaFile clears the rows');

// Resumability marker.
store.setImplFileHash('src/types.ts', 'h1');
assert(store.getImplFileHash('src/types.ts') === 'h1', 'impl file hash round-trips');
assert(store.getImplFileHash('src/none.ts') === null, 'unscanned file has no impl hash');

// Re-seed for the tool test.
store.upsertImpls([
  impl('src/storage/store.ts', 87, 'export class VectorStore implements Store'),
  impl('src/storage/memStore.ts', 12, 'export class MemStore implements Store'),
]);

// ---- find_implementations offline fallback --------------------------------
let handler;
registerSymbolRefTools({ tool: (n, _d, _s, fn) => { if (n === 'find_implementations') handler = fn; } }, store, WS);
const textOf = (res) => res.content.map((c) => c.text).join('');

const res = await handler({ file: `${WS}/src/types.ts`, line: 5, symbol: 'Store' });
const t = textOf(res);
console.log('\n--- find_implementations (offline) ---\n' + t + '\n');
assert(/saved index/.test(t), 'reports the persisted (offline) source');
assert(/store\.ts:87/.test(t) && /memStore\.ts:12/.test(t), 'lists both implementations with file:line');
assert(res.structuredContent.source === 'persisted', 'structuredContent marks source persisted');
assert(res.structuredContent.results.length === 2, 'returns both implementations');

const none = await handler({ file: `${WS}/src/types.ts`, line: 1, symbol: 'Nonexistent' });
assert(/unavailable/i.test(textOf(none)), 'unknown symbol with no bridge reports unavailable');

store.close();
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
console.log('\nAll implementations tests passed.');
