// Unit test for repo_overview (embedding-free). Seeds a couple of chunks and
// some index data, then drives the repo_overview handler via a fake MCP server.
//   node scripts/test-overview.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore } from '../dist/storage/store.js';
import { registerRepoOverviewTool } from '../dist/tools/repoOverview.js';

const dbPath = join(tmpdir(), `overview-test-${Date.now()}.db`);
const store = new VectorStore(dbPath);
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };

// Seed chunks across two languages (also creates `files` rows).
const mk = (id, file, sym) => ({
  id, file, symbol: sym, startLine: 1, endLine: 3, text: 'x', contentHash: id,
  embedding: new Float32Array(768),
});
store.upsertChunks([mk('c1', 'src/a.ts', 'a'), mk('c2', 'src/b.ts', 'b'), mk('c3', 'src/c.py', 'c')]);
store.setFileHash('src/a.ts', 'h');
store.setFileHash('src/b.ts', 'h');
store.setFileHash('src/c.py', 'h');
// Some symbols so one index shows as built.
store.upsertSymbols('src/a.ts', [{ name: 'a', kind: 'Function', startLine: 1, endLine: 3 }]);
store.setSymbolFileHash('src/a.ts', 'h');

const r = store.repoStats();
assert(r.files === 3, 'repoStats counts files');
assert(r.chunks === 3, 'repoStats counts chunks');
assert(r.languages[0].ext === 'ts' && r.languages[0].files === 2, 'ts is the top language (2 files)');
assert(r.languages.some((l) => l.ext === 'py' && l.files === 1), 'py counted (1 file)');

let handler;
registerRepoOverviewTool({ tool: (_n, _d, _s, fn) => { handler = fn; } }, store);
const res = await handler({});
const t = res.content.map((c) => c.text).join('');
console.log('\n--- repo_overview ---\n' + t + '\n');
assert(/3 files indexed, 3 chunks/.test(t), 'overview reports file + chunk counts');
assert(/ts×2/.test(t), 'overview shows the language breakdown');
assert(/symbols: 1/.test(t), 'overview shows symbols built');
assert(/call graph edges: not built/.test(t), 'overview shows an unbuilt index as "not built"');
assert(res.structuredContent.files === 3 && res.structuredContent.symbols === 1, 'structuredContent carries counts');

store.close();
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
console.log('\nAll repo-overview tests passed.');
