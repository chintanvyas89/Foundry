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

store.close();
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
console.log('\nAll call-graph store tests passed.');
