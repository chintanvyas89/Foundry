// Unit test for project vocabulary resolution (vocab/index.ts) — framework-
// AGNOSTIC by design: no framework's terminology is hardcoded. Covers the two
// working sources for v1: an explicit `.foundry/config.json` override, and
// auto-derivation from the project's OWN already-built config index.
//   node scripts/test-vocab.mjs
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore } from '../dist/storage/store.js';
import { resolveVocabulary } from '../dist/vocab/index.js';

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok  -', msg);
};

// ---- 1. Explicit .foundry/config.json override ----------------------------

const workspaceRoot = mkdtempSync(join(tmpdir(), 'vocab-test-'));
mkdirSync(join(workspaceRoot, '.foundry'));
writeFileSync(
  join(workspaceRoot, '.foundry', 'config.json'),
  JSON.stringify({ vocabulary: { 'content type': ['NodeType', 'node_type'] } }),
);

const dbPath = join(tmpdir(), `vocab-test-${Date.now()}.db`);
const store = new VectorStore(dbPath);

{
  const terms = resolveVocabulary(workspaceRoot, store, 'where is content type validated');
  assert(terms.includes('NodeType'), 'declared vocabulary resolves a matched phrase (NodeType)');
  assert(terms.includes('node_type'), 'declared vocabulary resolves a matched phrase (node_type)');
}
{
  const terms = resolveVocabulary(workspaceRoot, store, 'where is the cache invalidated');
  assert(!terms.includes('NodeType'), 'an unrelated query does not pick up unrelated declared vocabulary');
}

// ---- 2. Auto-derivation from the project's own config index (no framework
//         terms hardcoded — this is generic id/label cross-referencing) -----

store.replaceConfig('config/node.type.article.yml', [
  { file: 'config/node.type.article.yml', id: 'node.type.article', type: 'content_type', label: 'Article', deps: '', facts: 'Content type: Article', startLine: 1 },
]);

{
  const terms = resolveVocabulary(workspaceRoot, store, 'article content type fields');
  assert(terms.includes('node.type.article'), 'auto-derives the config item id from a label/id match');
  assert(terms.includes('article'), 'auto-derives the machine name\'s last segment');
}

// ---- 3. Clean no-op on a plain project (no config, no framework, no override)

const plainRoot = mkdtempSync(join(tmpdir(), 'vocab-plain-'));
const plainDbPath = join(tmpdir(), `vocab-plain-${Date.now()}.db`);
const plainStore = new VectorStore(plainDbPath);
{
  const terms = resolveVocabulary(plainRoot, plainStore, 'where is content type validated');
  assert(Array.isArray(terms) && terms.length === 0, 'no vocabulary sources -> clean empty result, no crash');
}

store.close();
plainStore.close();
for (const p of [dbPath, plainDbPath]) {
  rmSync(p, { force: true });
  rmSync(`${p}-wal`, { force: true });
  rmSync(`${p}-shm`, { force: true });
}
rmSync(workspaceRoot, { recursive: true, force: true });
rmSync(plainRoot, { recursive: true, force: true });
console.log('\nAll vocab tests passed.');
