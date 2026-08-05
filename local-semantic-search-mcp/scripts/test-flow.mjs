// Unit test for show_execution_flow. Uses a fake MCP server to capture the
// tool handler, then drives it against a seeded persisted graph (no bridge, no
// embedder). Covers the multi-level tree, depth limit, cycle guard, direction,
// and the not-built message.
//   node scripts/test-flow.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore } from '../dist/storage/store.js';
import { registerExecutionFlowTool } from '../dist/tools/showExecutionFlow.js';

const WS = '/repo';
const dbPath = join(tmpdir(), `flow-test-${Date.now()}.db`);
const store = new VectorStore(dbPath);
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };

// Capture the registered handler.
let handler;
registerExecutionFlowTool({ tool: (_n, _d, _s, fn) => { handler = fn; } }, store, WS);
const run = (args) => handler(args);
const textOf = (res) => res.content.map((c) => c.text).join('');

// Not built yet.
const empty = await run({ file: `${WS}/a.ts`, symbol: 'a' });
assert(/hasn't been built/i.test(textOf(empty)), 'reports when the graph is not built');

// Seed a chain a -> b -> c -> d with a cycle d -> b.
const e = (ff, fn, tf, tn) => ({ fromFile: ff, fromLine: 1, fromName: fn, toFile: tf, toLine: 1, toName: tn, viaFile: ff });
store.upsertEdges([
  e('a.ts', 'a', 'b.ts', 'b'),
  e('b.ts', 'b', 'c.ts', 'c'),
  e('c.ts', 'c', 'd.ts', 'd'),
  e('d.ts', 'd', 'b.ts', 'b'),
]);

// Callees from a, depth 3: a -> b -> c -> d(depth limit, since d -> b exists).
const flow = await run({ file: `${WS}/a.ts`, symbol: 'a', depth: 3 });
const t = textOf(flow);
console.log('\n--- callees(a, depth 3) ---\n' + t + '\n');
assert(t.includes('calls, depth 3'), 'header shows direction + depth');
assert(t.includes('b (') && t.includes('c (') && t.includes('d ('), 'walks three levels deep');
assert(/depth limit/.test(t), 'marks the depth cutoff (d still has callees)');

// Cycle: from b at depth 6, the walk hits b again and marks it, not loops forever.
const cyc = await run({ file: `${WS}/b.ts`, symbol: 'b', depth: 6 });
assert(/shown above/.test(textOf(cyc)), 'cycle back to b is marked, not expanded');

// Direction = callers: who reaches d.
const callers = await run({ file: `${WS}/d.ts`, symbol: 'd', direction: 'callers', depth: 2 });
const ct = textOf(callers);
assert(ct.includes('called by'), 'callers direction header');
assert(ct.includes('c ('), 'callers walk finds c (c -> d)');

// A workspace-RELATIVE file arg must resolve the same as the absolute one
// (index paths are relative; a bare relative path used to be mangled to nothing).
const relFlow = await run({ file: 'a.ts', symbol: 'a', depth: 3 });
assert(textOf(relFlow) === t, 'relative file arg gives the same result as absolute');

store.close();
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
console.log('\nAll execution-flow tests passed.');
