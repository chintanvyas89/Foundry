// Unit + integration test for the query planner (queryPlan.ts) and the
// dilution fix it enables in searchHybrid: a multi-word query like "xyz block"
// should find a rare `xyzBlock` identifier even though "block" alone is used
// thousands of times elsewhere in the corpus.
//   node scripts/test-query-plan.mjs
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planQuery } from '../dist/storage/queryPlan.js';
import { VectorStore } from '../dist/storage/store.js';

const assert = (cond, msg) => {
  if (!cond) { console.error('FAIL:', msg); process.exit(1); }
  console.log('ok  -', msg);
};

// ---- 1. planQuery: pure unit tests (no DB) ---------------------------------

{
  const plan = planQuery('xyz block', { docFrequency: () => 0, totalChunks: 0 });
  assert(plan.tokens.join(',') === 'xyz,block', 'tokenizes a two-word query');
  assert(plan.compounds.includes('xyzblock'), 'builds the joined compound candidate');
  assert(plan.matchTier1 === '"xyzblock"', 'tier1 MATCH is the quoted compound');
  assert(plan.matchTier2 === 'NEAR("xyz" "block", 4)', 'tier2 MATCH is a NEAR proximity expression');
  assert(plan.matchTier3 === '"xyz" OR "block"', 'tier3 MATCH is OR of tokens when nothing is classified common');
}

{
  // "block" is ubiquitous (appears in 500/1000 chunks = 50%), "xyz" is rare.
  const docFreq = (t) => (t === 'block' ? 500 : 1);
  const plan = planQuery('xyz block', { docFrequency: docFreq, totalChunks: 1000, ubiquityRatio: 0.01 });
  assert(plan.commonTokens.join(',') === 'block', 'classifies the ubiquitous token as common');
  assert(plan.rareTokens.join(',') === 'xyz', 'drops the common token from the rare set');
  assert(plan.matchTier3 === '"xyz"', 'tier3 excludes the ubiquitous token — no more dilution by "block"');
  assert(plan.matchTier1 === '"xyzblock"', 'tier1 (compound) is unaffected by ubiquity — still targets the identifier');
}

{
  // Guard: an all-common query (just "block") must not empty the recall floor.
  const plan = planQuery('block', { docFrequency: () => 999, totalChunks: 1000, ubiquityRatio: 0.01 });
  assert(plan.matchTier3 === '"block"', 'all-common query still searches (guard against emptying tier3)');
  assert(plan.matchTier1 === null, 'single-token query has no compound (needs 2+ tokens)');
  assert(plan.matchTier2 === null, 'single-token query has no NEAR (needs 2+ tokens)');
}

{
  const plan = planQuery('the block of xyz', { docFrequency: () => 0, totalChunks: 0 });
  assert(plan.tokens.join(',') === 'block,xyz', 'stopwords ("the", "of") are dropped before planning');
}

{
  const plan = planQuery('', { docFrequency: () => 0, totalChunks: 0 });
  assert(plan.tokens.length === 0 && plan.matchTier1 === null && plan.matchTier3 === null, 'empty query plans to nothing, no crash');
}

// ---- 2. searchHybrid: end-to-end dilution fix ------------------------------

const dbPath = join(tmpdir(), `query-plan-test-${Date.now()}.db`);
const store = new VectorStore(dbPath);

const v = (a, b) => Float32Array.from([a, b]);
const chunk = (id, symbol, text, emb) => ({
  id, file: `src/${id}.ts`, symbol, startLine: 1, endLine: 5,
  text, contentHash: id, embedding: emb,
});

// Flood the corpus with "block"-heavy decoys that all cosine-rank ABOVE the
// real target — enough of them (150, all with higher cosine, and >64 so the
// pool of max(topK*8, 64) is entirely decoys) to push the target completely
// out of the vector pool, so this exercises INJECTION, not just within-pool
// re-ranking. 150 decoys also keeps "xyz" below the 1% ubiquity threshold
// (1/151 chunks) so it's correctly classified rare, isolating the assertion
// to the compound-injection mechanism (tier 1) rather than tier 3's bonus.
const decoys = [];
for (let i = 0; i < 150; i++) {
  decoys.push(
    chunk(`decoy${i}`, `genericBlockHelper${i}`, `function genericBlockHelper${i}() { return block(); }`, v(1, 1.8 + i * 0.0001)),
  );
}
// The real target: a rare `xyzBlock` identifier, deliberately given a WORSE
// cosine than every decoy (simulating the mean-pooled "xyz block" query
// embedding being dragged toward generic "block" semantics, away from this
// specific chunk) — so it would never surface via pure vector search or the
// old single-tier lexical bonus (which only re-ranks WITHIN the pool).
const target = chunk('target', 'xyzBlock', 'function xyzBlock() { return renderXyzBlock(); }', v(1, 2.5));

store.upsertChunks([...decoys, target]);
const direction = v(1, 0);

// Sanity: confirm the target really is outside the pure-vector pool.
const vectorOnly = store.search(direction, 8);
assert(!vectorOnly.some((r) => r.id === 'target'), 'sanity: pure vector search misses the diluted target (outside topK)');

const hybrid = store.searchHybrid(direction, 'xyz block', 8);
assert(hybrid.some((r) => r.id === 'target'), 'searchHybrid injects the compound-identifier hit despite dilution');
assert(hybrid[0].id === 'target', 'the injected compound hit ranks above the block-flooded decoys');

store.close();
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });
console.log('\nAll query-plan tests passed.');
