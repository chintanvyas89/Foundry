// Unit test for the persisted usages index + find_usages offline fallback
// (embedding-free — no vectors). Seeds symbol_refs, then drives the find_usages
// handler via a fake MCP server. With no bridge running, the live path returns
// null and the tool falls back to the persisted index.
//   node scripts/test-usages.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore } from '../dist/storage/store.js';
import { registerSymbolRefTools } from '../dist/tools/symbolRefs.js';

const WS = '/repo';
const dbPath = join(tmpdir(), `usages-test-${Date.now()}.db`);
const store = new VectorStore(dbPath);
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };

// ---- store-level ----------------------------------------------------------
assert(store.usageStats().refs === 0, 'usages index starts empty');

// searchHybrid is referenced from two places; store those references.
const ref = (rf, rl, txt) => ({
  defFile: 'src/store.ts', defName: 'searchHybrid',
  refFile: rf, refLine: rl, refText: txt, viaFile: 'src/store.ts',
});
store.upsertRefs([
  ref('src/tools/semanticSearch.ts', 180, 'store.searchHybrid(direction, textQuery, k)'),
  ref('scripts/test-fts.mjs', 42, 'store.searchHybrid(vec, "q", 5)'),
]);
assert(store.usageStats().refs === 2, 'two references persisted');

const usages = store.getUsages('src/store.ts', 'searchHybrid');
assert(usages.length === 2, 'getUsages returns both references');
assert(usages[0].text.includes('searchHybrid'), 'reference carries its source line text');

// Duplicate insert is a no-op (idempotent build/refetch).
store.upsertRefs([ref('src/tools/semanticSearch.ts', 180, 'store.searchHybrid(direction, textQuery, k)')]);
assert(store.usageStats().refs === 2, 'duplicate reference insert is ignored (INSERT OR IGNORE)');

// Incremental: rebuilding the def file wipes its rows first.
store.deleteRefsByViaFile('src/store.ts');
assert(store.getUsages('src/store.ts', 'searchHybrid').length === 0, 'deleteRefsByViaFile clears the file rows');

// Resumability marker round-trips.
store.setUsageFileHash('src/store.ts', 'h1');
assert(store.getUsageFileHash('src/store.ts') === 'h1', 'usage file hash round-trips');
assert(store.getUsageFileHash('src/other.ts') === null, 'unscanned file has no usage hash');

// Re-seed for the tool test.
store.upsertRefs([
  ref('src/tools/semanticSearch.ts', 180, 'store.searchHybrid(direction, textQuery, k)'),
  ref('scripts/test-fts.mjs', 42, 'store.searchHybrid(vec, "q", 5)'),
]);

// ---- find_usages offline fallback -----------------------------------------
let handler;
registerSymbolRefTools({ tool: (n, _d, _s, fn) => { if (n === 'find_usages') handler = fn; } }, store, WS);
const textOf = (res) => res.content.map((c) => c.text).join('');

// No bridge is running in this test, so the live lookup returns null and the
// tool falls back to the persisted index (symbol name required).
const res = await handler({ file: `${WS}/src/store.ts`, line: 445, symbol: 'searchHybrid' });
const t = textOf(res);
console.log('\n--- find_usages (offline) ---\n' + t + '\n');
assert(/saved usages index/.test(t), 'reports the persisted (offline) source');
assert(/semanticSearch\.ts:180/.test(t), 'lists a persisted reference with file:line');
assert(res.structuredContent.source === 'persisted', 'structuredContent marks source persisted');
assert(res.structuredContent.results.length === 2, 'returns both references');

// Unknown symbol with no stored refs and no bridge -> unavailable.
const none = await handler({ file: `${WS}/src/store.ts`, line: 1, symbol: 'nopeNothing' });
assert(/unavailable/i.test(textOf(none)), 'unknown symbol with no bridge reports unavailable');

store.close();
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
console.log('\nAll usages tests passed.');
