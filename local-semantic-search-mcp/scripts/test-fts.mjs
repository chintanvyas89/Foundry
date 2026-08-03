// Unit test for FTS5 hybrid retrieval (no embedder needed — fake vectors).
// Verifies: FTS is available, searchText finds exact identifiers, and
// searchHybrid floats up an exact-token chunk that pure vector ranks LAST.
//   node scripts/test-fts.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore } from '../dist/storage/store.js';

const dbPath = join(tmpdir(), `fts-test-${Date.now()}.db`);
const store = new VectorStore(dbPath);

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok  -', msg);
};

assert(store.ftsAvailable(), 'FTS5 is available');

// Fake vectors chosen so cosine to `direction` is known and separable. The
// hybrid contract is a BOUNDED lexical bonus (max 0.1): a lexical match can
// overtake a non-matching chunk whose cosine is within the bonus band, but not
// a clearly-stronger one — so it never regresses a query pure vector got right.
const v = (a, b) => Float32Array.from([a, b]);
const chunk = (id, symbol, text, emb) => ({
  id, file: `src/${id}.ts`, symbol, startLine: 1, endLine: 5,
  text, contentHash: id, embedding: emb,
});

// cos(direction, e) for direction=(1,0): 'strong'≈0.98, 'near'≈0.94, 'target'≈0.86.
store.upsertChunks([
  chunk('strong', 'strongDecoy', 'generic helper code path strong', v(1, 0.2)),
  chunk('near', 'nearDecoy', 'generic helper code path near', v(1, 0.35)),
  chunk('target', 'computeCosineSimilarity',
        'function computeCosineSimilarity(a, b) { return dot(a,b); }', v(1, 0.6)),
]);
const direction = v(1, 0);

// 1. Pure vector: by cosine, order is strong > near > target.
const vec = store.search(direction, 3);
assert(vec.map((r) => r.id).join(',') === 'strong,near,target', 'pure vector orders by cosine');

// 2. Lexical: exact identifier is the top (only) FTS hit.
const fts = store.searchText('computeCosineSimilarity', 10);
assert(fts.length >= 1 && fts[0].id === 'target', 'FTS finds exact identifier as top hit');
assert(store.searchText('nonexistenttoken12345', 10).length === 0, 'FTS returns nothing for absent token');

// 2b. camelCase splitting: a two-word query matches the single-token identifier
//     `computeCosineSimilarity` (previously it would not).
assert(
  store.searchText('cosine similarity', 10).some((r) => r.id === 'target'),
  'FTS matches a camelCase identifier from a two-word query (split)',
);

// 3. Hybrid: the +0.1 bonus lifts target (0.86) above near (0.94)? No — gap 0.08
//    < 0.1 so it DOES overtake near; but NOT strong (0.98, gap 0.12 > 0.1).
const hyb = store.searchHybrid(direction, 'computeCosineSimilarity', 3);
assert(hyb[0].id === 'strong', 'bounded bonus does NOT dethrone the clearly-stronger semantic hit');
assert(hyb[1].id === 'target', 'bounded bonus promotes the exact-identifier hit past a near-tie');

// 4. Natural-language query with punctuation must not blow up the MATCH parser.
const nl = store.searchHybrid(direction, "where's the cosine similarity helper?", 3);
assert(Array.isArray(nl) && nl.length > 0, 'punctuated NL query returns results (no MATCH syntax error)');

// 4b. snake_case identifier: separate words match it.
store.upsertChunks([
  chunk('snakey', 'get_user_by_id', 'function get_user_by_id() { return 1; }', v(1, 0.05)),
]);
assert(
  store.searchText('user id', 10).some((r) => r.id === 'snakey'),
  'FTS matches a snake_case identifier from separate words',
);

// 5. backfillFts is a no-op when in sync (current version + counts match).
assert(store.backfillFts() === 0, 'backfillFts is a no-op when in sync');

// 6. deleteByFile also clears the FTS row.
store.deleteByFile('src/target.ts');
assert(store.searchText('computeCosineSimilarity', 10).length === 0, 'deleteByFile clears FTS rows');

store.close();
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
console.log('\nAll FTS hybrid tests passed.');
