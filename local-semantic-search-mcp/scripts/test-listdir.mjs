// Unit test for list_directory. Builds a temp workspace with nested dirs, a
// .gitignore, and node_modules, then drives the tool handler via a fake MCP server.
// Covers recursion, ignore rules, depth limiting + drill, path scoping, and caps.
//   node scripts/test-listdir.mjs
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerListDirectoryTool } from '../dist/tools/listDirectory.js';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };
const ws = mkdtempSync(join(tmpdir(), 'listdir-'));
const mk = (p) => mkdirSync(join(ws, p), { recursive: true });
const wr = (p, c = '') => writeFileSync(join(ws, p), c);

try {
  mk('src/storage');
  mk('src/tools');
  mk('modules/custom/market/src/Entity');
  mk('node_modules/foo');
  mk('web/profiles/nasdaq/config/sync');
  wr('.gitignore', 'node_modules/\ndist/\n');
  wr('README.md');
  wr('src/index.ts');
  wr('src/storage/store.ts');
  wr('src/tools/search.ts');
  wr('modules/custom/market/src/Entity/Activity.php');
  wr('node_modules/foo/index.js'); // must be ignored
  mk('dist'); wr('dist/out.js'); // ignored
  // Real config YAML — NOT gitignored, but a project commonly keeps it out of
  // the embed index via config.exclude (e.g. "config/sync/**"). list_directory
  // must not inherit that: it's a different tool with a different job.
  wr('web/profiles/nasdaq/config/sync/field.field.block_content.mercury_reference_card.field_hide_description.yml');

  let handler;
  registerListDirectoryTool({ tool: (_n, _d, _s, fn) => { handler = fn; } }, ws);
  const textOf = (res) => res.content.map((c) => c.text).join('');

  // ---- root, default depth --------------------------------------------------
  const root = await handler({});
  const rt = textOf(root);
  console.log('\n--- root tree ---\n' + rt + '\n');
  assert(/src\//.test(rt) && /modules\//.test(rt), 'lists top-level directories');
  assert(/store\.ts/.test(rt), 'recurses into subdirectories (src/storage/store.ts)');
  assert(!/node_modules/.test(rt), 'respects .gitignore (node_modules excluded)');
  assert(!/dist/.test(rt), 'respects .gitignore (dist excluded)');
  assert(root.structuredContent.tree.some((n) => n.name === 'src' && n.type === 'dir'), 'structuredContent carries the tree');

  // ---- depth limiting + drill marker ---------------------------------------
  const shallow = await handler({ depth: 1 });
  const shText = textOf(shallow);
  assert(/src\/…/.test(shText) && /modules\/…/.test(shText), 'depth-1 marks non-empty dirs with /… (drill hint)');
  assert(!/store\.ts/.test(shText), 'depth 1 does not descend into subdirectories');

  // ---- drill into a subdir via path (relative) ------------------------------
  const sub = await handler({ path: 'modules/custom/market' });
  const st = textOf(sub);
  assert(/Activity\.php/.test(st), 'drilling into a subdir path lists its nested files');
  assert(sub.structuredContent.path === 'modules/custom/market', 'structuredContent echoes the scoped path');

  // absolute path resolves the same
  const subAbs = await handler({ path: join(ws, 'modules/custom/market') });
  assert(/Activity\.php/.test(textOf(subAbs)), 'absolute path scopes the same as relative');

  // ---- NOT excluded via the embed index's config.exclude --------------------
  // Regression: a real, non-gitignored dir (config/sync) must never come back
  // "empty or entirely ignored" just because a project's config.exclude keeps
  // it out of the SEARCH index — list_directory takes no exclude list at all.
  const cfgSync = await handler({ path: 'web/profiles/nasdaq/config/sync' });
  const cfgText = textOf(cfgSync);
  assert(!/entirely ignored/.test(cfgText), 'config/sync is not reported as empty/ignored');
  assert(/field_hide_description\.yml/.test(cfgText), 'config/sync lists its real YAML file');

  // ---- entry cap ------------------------------------------------------------
  const capped = await handler({ maxEntries: 2 });
  assert(capped.structuredContent.truncated && capped.structuredContent.entries === 2, 'honours maxEntries + marks truncation');

  // ---- outside workspace refused -------------------------------------------
  assert(/outside the workspace/.test(textOf(await handler({ path: '../..' }))), 'refuses paths outside the workspace');

  console.log('\nAll list_directory tests passed.');
} finally {
  rmSync(ws, { recursive: true, force: true });
}
