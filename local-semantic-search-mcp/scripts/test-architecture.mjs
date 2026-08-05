// Unit test for architecture_overview (embedding-free). Seeds files across a few
// modules plus symbols/usages/call-graph rows, then drives the tool's handler via
// a fake MCP server — both the whole-repo map and a single-module drill-down. No
// embedder, no bridge, no re-index.
//   node scripts/test-architecture.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore } from '../dist/storage/store.js';
import { registerArchitectureOverviewTool } from '../dist/tools/architectureOverview.js';

const dbPath = join(tmpdir(), `arch-test-${Date.now()}.db`);
const store = new VectorStore(dbPath);
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };

// ---- seed three modules ----------------------------------------------------
const files = [
  'src/storage/store.ts',
  'src/tools/semanticSearch.ts',
  'src/tools/searchSymbol.ts',
  'src/indexing/indexer.ts',
];
for (const f of files) store.setFileHash(f, 'h');

store.upsertSymbols('src/storage/store.ts', [
  { name: 'VectorStore', kind: 'Class', startLine: 10, endLine: 900 },
  { name: 'upsertChunks', kind: 'Method', startLine: 40, endLine: 60 },
]);
store.upsertSymbols('src/tools/semanticSearch.ts', [
  { name: 'registerSemanticSearchTool', kind: 'Function', startLine: 5, endLine: 200 },
]);
store.upsertSymbols('src/tools/searchSymbol.ts', [
  { name: 'registerSearchSymbolTool', kind: 'Function', startLine: 5, endLine: 120 },
]);
store.upsertSymbols('src/indexing/indexer.ts', [
  { name: 'Indexer', kind: 'Class', startLine: 8, endLine: 300 },
  { name: 'buildAll', kind: 'Function', startLine: 310, endLine: 340 },
]);

// Usages: tools + indexing reference storage's VectorStore/upsertChunks.
const ref = (defFile, defName, refFile, refLine) => ({
  defFile, defName, refFile, refLine, refText: `use of ${defName}`, viaFile: defFile,
});
store.upsertRefs([
  ref('src/storage/store.ts', 'VectorStore', 'src/tools/semanticSearch.ts', 11),
  ref('src/storage/store.ts', 'VectorStore', 'src/tools/semanticSearch.ts', 12),
  ref('src/storage/store.ts', 'VectorStore', 'src/tools/searchSymbol.ts', 9),
  ref('src/storage/store.ts', 'VectorStore', 'src/indexing/indexer.ts', 15),
  ref('src/storage/store.ts', 'upsertChunks', 'src/indexing/indexer.ts', 22),
  ref('src/storage/store.ts', 'upsertChunks', 'src/indexing/indexer.ts', 23),
  ref('src/storage/store.ts', 'upsertChunks', 'src/indexing/indexer.ts', 24),
]);

// Call graph: buildAll and registerSemanticSearchTool are roots (never callees).
const edge = (fromFile, fromName, toFile, toName) => ({
  fromFile, fromLine: 1, fromName, toFile, toLine: 1, toName, viaFile: fromFile,
});
store.upsertEdges([
  edge('src/indexing/indexer.ts', 'buildAll', 'src/storage/store.ts', 'upsertChunks'),
  edge('src/tools/semanticSearch.ts', 'registerSemanticSearchTool', 'src/storage/store.ts', 'VectorStore'),
]);

// ---- store aggregation -----------------------------------------------------
assert(store.refEdges().length === 3, 'refEdges reports cross-file dependency pairs');
assert(store.symbolHotspots(5)[0].name === 'VectorStore', 'VectorStore is the top hotspot (4 refs)');
assert(store.allSymbolRows().length === 6, 'allSymbolRows returns every declared symbol');
assert(store.callEdges().length === 2, 'callEdges returns the seeded edges');

// ---- whole-repo map --------------------------------------------------------
let handler;
registerArchitectureOverviewTool({ tool: (_n, _d, _s, fn) => { handler = fn; } }, store);
const textOf = (res) => res.content.map((c) => c.text).join('');

const repo = await handler({});
const rt = textOf(repo);
console.log('\n--- architecture_overview (repo) ---\n' + rt + '\n');
assert(/3 module\(s\)/.test(rt), 'repo map counts the three modules');
assert(/src\/tools \(2 files\)/.test(rt), 'tools module shows its file count');
assert(/depends on: storage/.test(rt), 'tools module depends on storage');
assert(/src\/storage.*used by:.*tools/.test(rt), 'storage is used by tools/indexing');
assert(/Entry points.*buildAll/.test(rt), 'entry points include the call-graph root buildAll');
assert(/Hotspots.*VectorStore \(4\)/.test(rt), 'hotspots list the most-referenced symbol');
assert(repo.structuredContent.scope === 'repo' && repo.structuredContent.moduleCount === 3, 'structuredContent carries the repo map');

// ---- single-module drill-down ----------------------------------------------
const mod = await handler({ module: 'storage' });
const mt = textOf(mod);
console.log('\n--- architecture_overview (module=storage) ---\n' + mt + '\n');
assert(/## src\/storage — module/.test(mt), 'drill-down headers the resolved module');
assert(/Key symbols:.*VectorStore \(Class/.test(mt), 'key symbols ranked by references');
assert(/Used by \(modules\):.*tools/.test(mt), 'module drill-down shows dependents');
assert(mod.structuredContent.scope === 'module' && mod.structuredContent.matched, 'structuredContent marks a matched module');

// Path form + unknown form.
const byPath = await handler({ module: 'src/tools/searchSymbol.ts' });
assert(/## src\/tools — module/.test(textOf(byPath)), 'a file path resolves to its directory module');
const miss = await handler({ module: 'nope' });
assert(/No module matched/.test(textOf(miss)) && miss.structuredContent.matched === false, 'unknown module reports no match');

// ---- absolute / fully-qualified path resolves to the relative index key -----
// Search UIs surface absolute paths, but the index stores relative ones; the
// drilldown must peel the workspace-root prefix.
const abs = await handler({ module: '/home/dev/project/src/storage' });
assert(/## src\/storage — module/.test(textOf(abs)), 'an absolute path resolves to the relative module key');
const absFile = await handler({ module: '/home/dev/project/src/tools/searchSymbol.ts' });
assert(/## src\/tools — module/.test(textOf(absFile)), 'an absolute FILE path resolves to its directory module');

// ---- recursive drilldown into a parent that has only sub-directories --------
// A Drupal-style nested module: files live only in subfolders, so the parent
// dir has no direct files. Drilling into it must return the SUBTREE, not "not
// found".
for (const f of [
  'modules/custom/market/src/Entity/Activity.php',
  'modules/custom/market/src/Controller/MarketController.php',
  'modules/custom/market/src/Form/SettingsForm.php',
]) {
  store.setFileHash(f, 'h');
}
const sub = await handler({ module: 'modules/custom/market' });
const st = textOf(sub);
console.log('\n--- architecture_overview (subtree=modules/custom/market) ---\n' + st + '\n');
assert(/subtree · 3 submodules/.test(st), 'parent dir renders as a recursive subtree summary');
assert(/### Submodules \(3\)/.test(st), 'subtree lists its child submodules');
assert(/Entity \(1 file\)/.test(st) && /Controller \(1 file\)/.test(st), 'child submodules show relative names + file counts');
assert(sub.structuredContent.subtree === true && sub.structuredContent.submodules.length === 3, 'structuredContent marks a subtree with its submodules');
assert(sub.structuredContent.files.length === 3, 'subtree aggregates all files under the parent');

// The same subtree via an absolute path.
const subAbs = await handler({ module: '/var/www/html/modules/custom/market' });
assert(/subtree · 3 submodules/.test(textOf(subAbs)), 'absolute path also resolves to the recursive subtree');

store.close();
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
console.log('\nAll architecture-overview tests passed.');
