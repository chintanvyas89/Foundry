// End-to-end test for the embedding-free config index. Builds a temp Drupal-shaped
// workspace (config/sync exports + module *.services/routing/permissions/info.yml +
// a generic yaml), runs the config build, and drives searchConfig, the tool handler,
// incremental skip, pluggability, and the YAML-never-embedded / eviction guards.
// Headless — no LSP bridge, no embeddings.
//   node scripts/test-config-index.mjs
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore } from '../dist/storage/store.js';
import { buildConfig } from '../dist/indexing/configBuilder.js';
import { summarizeConfigFile } from '../dist/config-index/registry.js';
import { chunkFile } from '../dist/chunking/chunker.js';
import { Indexer } from '../dist/indexing/indexer.js';
import { registerSearchConfigTool } from '../dist/tools/searchConfig.js';
import {
  resolveConfigExtensions,
  resolveEnabledPacks,
  initConfigIndex,
  isConfigExtension,
} from '../dist/config-index/settings.js';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };
const ws = mkdtempSync(join(tmpdir(), 'configidx-'));
const mk = (p) => mkdirSync(join(ws, p), { recursive: true });
const wr = (p, c) => { mk(p.split('/').slice(0, -1).join('/') || '.'); writeFileSync(join(ws, p), c); };

try {
  // --- Fixtures: representative Drupal config + a generic yaml ---------------
  wr('config/sync/views.view.frontpage.yml',
`langcode: en
status: true
dependencies:
  module:
    - node
    - views
id: frontpage
label: 'Front page'
base_table: node_field_data
display:
  default:
    display_options:
      fields:
        title:
          id: title
        body:
          id: body
      filters:
        status:
          value: '1'
      access:
        type: perm
  page_1:
    display_plugin: page
`);
  wr('config/sync/field.field.node.article.body.yml',
`langcode: en
id: node.article.body
field_name: body
entity_type: node
bundle: article
label: Body
required: false
`);
  wr('web/modules/custom/market/market.permissions.yml',
`access market data:
  title: 'Access market data'
  description: 'View market activity.'
  restrict access: true
`);
  wr('web/modules/custom/market/market.routing.yml',
`market.activity:
  path: '/market/activity'
  defaults:
    _controller: '\\Drupal\\market\\Controller\\MarketController::activity'
    _title: 'Activity'
  requirements:
    _permission: 'access market data'
`);
  wr('web/modules/custom/market/market.services.yml',
`services:
  market.route_subscriber:
    class: Drupal\\market\\Routing\\RouteSubscriber
    arguments: ['@entity_type.manager']
    tags:
      - { name: event_subscriber }
`);
  wr('web/modules/custom/market/market.info.yml',
`name: Market
type: module
description: 'Market activity module.'
package: Custom
core_version_requirement: ^10 || ^11
dependencies:
  - drupal:node
  - drupal:views
`);
  wr('some/random/thing.yml', "foo:\n  bar: baz\nlist:\n  - a\n  - b\n");

  // --- Build the config index -----------------------------------------------
  const store = new VectorStore(join(ws, 'index.db'));
  const stats = await buildConfig(ws, store);
  console.log('\nbuild stats:', JSON.stringify(stats));
  assert(stats.files >= 7, 'walked all project .yml files');
  assert(stats.filesProcessed === stats.files, 'summarized every config file');
  assert(stats.items >= 7, 'wrote at least one item per file');
  assert(stats.bridgeDown === false, 'config build needs no bridge');

  const cs = store.configStats();
  const types = cs.byType.map((t) => t.type);
  console.log('types:', types);
  for (const t of ['view', 'field', 'permission', 'route', 'service', 'module_info']) {
    assert(types.includes(t), `type '${t}' present in the index`);
  }

  // --- searchConfig: ranking + type filter ----------------------------------
  const byId = store.searchConfig('frontpage');
  assert(byId[0] && byId[0].id === 'frontpage' && byId[0].type === 'view', 'exact id -> the view ranks first');

  const field = store.searchConfig('node.article.body', { type: 'field' });
  assert(field.some((r) => r.type === 'field' && r.id === 'node.article.body'), 'field found with type filter');
  assert(field.every((r) => r.type === 'field'), 'type filter only returns matching types');
  const asView = store.searchConfig('node.article.body', { type: 'view' });
  assert(asView.every((r) => r.type === 'view') && !asView.some((r) => r.id === 'node.article.body'),
    'the field itself never surfaces under type:view');

  const route = store.searchConfig('market.activity');
  assert(route.some((r) => r.type === 'route' && /market\/activity/.test(r.facts)), 'route found by id, facts include its path');

  const svc = store.searchConfig('route_subscriber');
  assert(svc.some((r) => r.type === 'service'), 'service found by id substring');

  const info = store.searchConfig('market', { type: 'module_info' });
  assert(info.every((r) => r.type === 'module_info') && info.some((r) => r.id === 'market'), 'type filter narrows to module_info');

  if (store.ftsAvailable()) {
    const kw = store.searchConfig('node_field_data');
    assert(kw.some((r) => r.id === 'frontpage'), 'FTS keyword over facts finds the view by its base table');
    console.log('ok  - (FTS5 available: facts keyword search exercised)');
  } else {
    console.log('ok  - (FTS5 not in this sqlite build; LIKE fallback path used)');
  }

  // --- Pluggability: an extra summarizer is used first ----------------------
  const fake = {
    id: 'fake',
    match: (rel) => rel.endsWith('some/random/thing.yml'),
    summarize: () => [{ id: 'custom-thing', type: 'fake_type', facts: 'a plugged-in summary', startLine: 1 }],
  };
  const items = summarizeConfigFile('some/random/thing.yml', 'foo: bar\n', { extraSummarizers: [fake] });
  assert(items.length === 1 && items[0].type === 'fake_type' && items[0].id === 'custom-thing', 'an extra summarizer overrides the built-ins');

  // The Drupal pack in the MAIN workspace is AUTO-enabled from the detected
  // framework (market.info.yml) — that's why the view/field/etc. got precise types.
  assert(resolveEnabledPacks(ws).includes('drupal'), 'Drupal pack auto-enabled from detected framework');

  // --- Incremental: a second build skips everything unchanged ---------------
  const again = await buildConfig(ws, store);
  assert(again.filesProcessed === 0 && again.filesSkipped === again.files, 'incremental re-run skips unchanged files');

  // --- Pruning: removing a file drops its items on the next build -----------
  rmSync(join(ws, 'some/random/thing.yml'));
  const pruned = await buildConfig(ws, store);
  assert(pruned.filesPruned >= 1, 'a deleted config file is pruned from the index');
  assert(!store.searchConfig('thing').some((r) => r.id === 'thing'), 'the pruned file\'s item is gone');
  assert(store.listConfigFiles().every((f) => f !== 'some/random/thing.yml'), 'pruned file dropped from config_files');

  // --- YAML is NEVER embedded ------------------------------------------------
  const ymlChunks = await chunkFile(join(ws, 'config/sync/views.view.frontpage.yml'), ws);
  assert(Array.isArray(ymlChunks) && ymlChunks.length === 0, 'chunkFile() yields NO chunks for a .yml file');

  // --- Eviction of leaked YAML chunks via the indexer guard -----------------
  const rel = 'config/sync/views.view.frontpage.yml';
  const emb = new Float32Array(768).fill(0.01);
  store.upsertChunks([
    { id: `${rel}:1:2`, file: rel, symbol: 'leak', startLine: 1, endLine: 2, text: 'id: frontpage', contentHash: 'seed', embedding: emb },
  ]);
  assert(store.countByFile(rel) === 1, 'seeded a leaked YAML chunk (simulating a pre-upgrade index)');
  const indexer = new Indexer(ws, store, []);
  await indexer.indexFile(join(ws, rel));
  assert(store.countByFile(rel) === 0, 'indexer evicts the leaked YAML chunk (never re-embeds it)');

  // invalidateByExtensions still works as a bulk fallback. A pre-upgrade index has
  // BOTH a chunk and a `files` row for the YAML, so seed both.
  store.upsertChunks([
    { id: `${rel}:3:4`, file: rel, symbol: 'leak2', startLine: 3, endLine: 4, text: 'x', contentHash: 'seed2', embedding: emb },
  ]);
  store.setFileHash(rel, 'seedhash');
  const n = store.invalidateByExtensions(['.yml', '.yaml']);
  assert(n >= 1 && store.countByFile(rel) === 0, 'invalidateByExtensions removes YAML chunks in bulk');

  // --- Tool handler returns structured content with ABSOLUTE paths ----------
  let handler;
  registerSearchConfigTool({ tool: (_n, _d, _s, fn) => { handler = fn; } }, store, ws);
  const res = await handler({ query: 'frontpage' });
  const r0 = res.structuredContent.results[0];
  assert(r0 && r0.id === 'frontpage', 'search_config tool returns the view');
  assert(r0.file.startsWith(ws) && r0.file.endsWith(rel), 'tool emits an ABSOLUTE file path');
  assert(/frontpage \[view\]/.test(res.content[0].text), 'tool text shows id [type]');

  store.close?.();

  // ========================================================================
  // Generalization: generic core, Drupal as an opt-in pack, per-project config
  // ========================================================================
  const scratch = [];
  const freshWs = (files) => {
    const w = mkdtempSync(join(tmpdir(), 'configidx2-'));
    scratch.push(w);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(w, p.split('/').slice(0, -1).join('/') || '.'), { recursive: true });
      writeFileSync(join(w, p), c);
    }
    return w;
  };
  const viewYml = "label: Things\nbase_table: node_field_data\n";

  // (A) Non-Drupal project: the Drupal pack is NOT core, so a views.view.*.yml is
  //     summarized GENERICALLY (type = first id segment), never as a 'view'.
  {
    const w = freshWs({ 'config/sync/views.view.things.yml': viewYml });
    const st = new VectorStore(join(w, 'index.db'));
    await buildConfig(w, st);
    assert(resolveEnabledPacks(w).length === 0, 'no packs auto-enabled for a non-framework project');
    const hit = st.searchConfig('views.view.things');
    assert(hit[0] && hit[0].type === 'views', 'without the Drupal pack a view is generic (type=first segment)');
    assert(!st.configStats().byType.some((t) => t.type === 'view'), 'no Drupal "view" type when the pack is off');
    st.close?.();
  }

  // (B) Explicit opt-in via .foundry/config.json enables the Drupal pack even
  //     with no framework auto-detection.
  {
    const w = freshWs({
      'config/sync/views.view.things.yml': viewYml,
      '.foundry/config.json': JSON.stringify({ configReaders: ['drupal'] }),
    });
    const st = new VectorStore(join(w, 'index.db'));
    await buildConfig(w, st);
    assert(resolveEnabledPacks(w).includes('drupal'), 'configReaders explicitly enables the drupal pack');
    assert(st.searchConfig('things').some((r) => r.type === 'view'), 'explicit pack yields precise "view" type');
    st.close?.();
  }

  // (C) Per-project extra extension: .json becomes config only when declared.
  {
    const w = freshWs({
      'app.settings.yml': 'name: App\n',
      'data/seed.json': JSON.stringify({ id: 'seed', label: 'Seed data', count: 3 }),
      '.foundry/config.json': JSON.stringify({ configExtensions: ['.yml', '.yaml', '.json'] }),
    });
    assert(resolveConfigExtensions(w).has('.json'), 'configExtensions adds .json for this project');
    const st = new VectorStore(join(w, 'index.db'));
    const s = await buildConfig(w, st);
    assert(s.files >= 2, 'the declared .json file is walked as config');
    assert(st.searchConfig('seed').some((r) => /seed\.json/.test(r.file)), 'a .json config file is summarized and searchable');
    st.close?.();
  }

  // Default extension set excludes .json; the active guard tracks the project.
  {
    const wJson = freshWs({ '.foundry/config.json': JSON.stringify({ configExtensions: ['.yml', '.json'] }) });
    const wDefault = freshWs({});
    assert(!resolveConfigExtensions(wDefault).has('.json'), 'by default .json is NOT config');
    initConfigIndex(wJson);
    assert(isConfigExtension('x.json') && isConfigExtension('x.yml'), 'active guard honors the project extension set');
    initConfigIndex(wDefault);
    assert(!isConfigExtension('x.json') && isConfigExtension('x.yml'), 'active guard resets to defaults for a plain project');
  }

  console.log('\nAll config-index tests passed.');
  for (const w of scratch) rmSync(w, { recursive: true, force: true });
} finally {
  rmSync(ws, { recursive: true, force: true });
}
