// Unit test for the persisted call-graph store (embedding-free — no vectors).
//   node scripts/test-graph.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore } from '../dist/storage/store.js';

const dbPath = join(tmpdir(), `graph-test-${Date.now()}.db`);
const store = new VectorStore(dbPath);
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };

// Graph: a() -> b() -> c(), all discovered while processing their own files.
store.upsertEdges([
  { fromFile: 'src/a.ts', fromLine: 1, fromName: 'a', toFile: 'src/b.ts', toLine: 1, toName: 'b', viaFile: 'src/a.ts' },
  { fromFile: 'src/b.ts', fromLine: 1, fromName: 'b', toFile: 'src/c.ts', toLine: 1, toName: 'c', viaFile: 'src/b.ts' },
]);

assert(store.graphStats().edges === 2, 'edges persisted');

// Callees / callers.
const bCallees = store.getCallees('src/b.ts', 'b');
assert(bCallees.length === 1 && bCallees[0].name === 'c', 'getCallees returns what b calls (c)');
const bCallers = store.getCallers('src/b.ts', 'b');
assert(bCallers.length === 1 && bCallers[0].name === 'a', 'getCallers returns who calls b (a)');
assert(store.getCallees('src/c.ts', 'c').length === 0, 'leaf has no callees');

// Duplicate insert is ignored (idempotent build/refetch).
store.upsertEdges([
  { fromFile: 'src/a.ts', fromLine: 1, fromName: 'a', toFile: 'src/b.ts', toLine: 1, toName: 'b', viaFile: 'src/a.ts' },
]);
assert(store.graphStats().edges === 2, 'duplicate edge insert is a no-op (INSERT OR IGNORE)');

// Resumability markers.
store.setGraphFileHash('src/a.ts', 'hash1');
assert(store.getGraphFileHash('src/a.ts') === 'hash1', 'graph file hash round-trips (resumable build)');
assert(store.getGraphFileHash('src/z.ts') === null, 'unbuilt file has no hash');

// Incremental: changing a.ts wipes only edges it produced, then refetch.
store.deleteEdgesByViaFile('src/a.ts');
assert(store.getCallers('src/b.ts', 'b').length === 0, 'deleteEdgesByViaFile removes a.ts contributions');
assert(store.getCallees('src/b.ts', 'b').length === 1, "other files' edges survive");

// Multi-level chain + cycle — the traversal show_execution_flow walks.
// Current edges: b -> c. Add c -> d and a cycle d -> b.
store.upsertEdges([
  { fromFile: 'src/c.ts', fromLine: 1, fromName: 'c', toFile: 'src/d.ts', toLine: 1, toName: 'd', viaFile: 'src/c.ts' },
  { fromFile: 'src/d.ts', fromLine: 1, fromName: 'd', toFile: 'src/b.ts', toLine: 1, toName: 'b', viaFile: 'src/d.ts' },
]);
assert(store.getCallees('src/c.ts', 'c')[0]?.name === 'd', 'c -> d edge (level 3) reachable');
assert(store.getCallees('src/d.ts', 'd')[0]?.name === 'b', 'd -> b cycle edge present');
// A depth-first walk from b following callees must terminate despite the cycle:
const seen = new Set();
(function walk(file, name, guard = 0) {
  const key = `${file}|${name}`;
  if (seen.has(key) || guard > 50) return;
  seen.add(key);
  for (const n of store.getCallees(file, name)) walk(n.file, n.name, guard + 1);
})('src/b.ts', 'b');
assert(seen.size === 3, 'cycle-guarded walk from b visits exactly {b,c,d}');

store.close();
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
console.log('\nAll call-graph store tests passed.');
