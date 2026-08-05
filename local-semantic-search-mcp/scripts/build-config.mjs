// Standalone config-index builder — parses the workspace's structured config
// (.yml/.yaml, plus anything declared in .foundry/config.json) into the SAME
// index.db the MCP server/tools use. No embedding model, no server, no lock, no
// env var — just the config pass. Use it to build or verify the config index
// directly.
//
//   node scripts/build-config.mjs /abs/path/to/your/project
//   (or) WORKSPACE_ROOT=/abs/path node scripts/build-config.mjs
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { VectorStore } from '../dist/storage/store.js';
import { buildConfig } from '../dist/indexing/configBuilder.js';
import { resolveConfigExtensions, resolveEnabledPacks } from '../dist/config-index/settings.js';

const ws = process.argv[2] || process.env.WORKSPACE_ROOT;
if (!ws) {
  console.error('Usage: node scripts/build-config.mjs <workspaceRoot>  (or set WORKSPACE_ROOT)');
  process.exit(1);
}
const dbPath = join(ws, '.swe-search', 'index.db');
if (!existsSync(dbPath)) {
  console.error(
    `No index.db at ${dbPath} yet. Start the server once so the workspace index is created, ` +
      'then re-run this. (The config index rides inside the same index.db.)',
  );
  process.exit(1);
}

console.error(`[build-config] workspace: ${ws}`);
console.error(`[build-config] db:        ${dbPath}`);
console.error(`[build-config] extensions: ${[...resolveConfigExtensions(ws)].join(', ')}`);
const packs = resolveEnabledPacks(ws);
console.error(`[build-config] reader packs: ${packs.length ? packs.join(', ') : '(none — generic only)'}`);

const store = new VectorStore(dbPath);
const startAt = Date.now();
let lastLog = 0;
const stats = await buildConfig(ws, store, {
  onProgress: (p) => {
    const now = Date.now();
    if (now - lastLog < 500 && p.doneFiles !== p.totalFiles) return;
    lastLog = now;
    console.error(`[build-config] ${p.doneFiles}/${p.totalFiles} files — ${p.items} items`);
  },
});

const cfg = store.configStats();
console.error(
  `\n[build-config] DONE in ${Math.round((Date.now() - startAt) / 1000)}s — ` +
    `${stats.items} items from ${stats.filesProcessed} files ` +
    `(${stats.filesSkipped} unchanged, ${stats.filesPruned} pruned).`,
);
console.error(`[build-config] index now holds ${cfg.items} config items across ${cfg.filesBuilt} files.`);
if (cfg.byType.length) {
  console.error('[build-config] by type: ' + cfg.byType.map((t) => `${t.type}×${t.count}`).join(', '));
}
if (cfg.items === 0) {
  console.error(
    '\n[build-config] 0 items — no matching config files were found. Check that your project has ' +
      '.yml/.yaml files (or declare more extensions in .foundry/config.json), and that they are not ' +
      'under vendor/node_modules or ignored by .gitignore/.sweignore.',
  );
}
store.close?.();
