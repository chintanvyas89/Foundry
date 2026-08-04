// Unit test for lazy indexing: the IndexState gates/status, and the embedder's
// priority queue (a high-priority search-query embed preempts low-priority
// background build embeds). The queue test uses the real embedder (like
// test-context) — it needs the model cached locally.
//   node scripts/test-lazy.mjs
import { IndexState } from '../dist/indexing/indexState.js';
import { initEmbedder, embedBatch } from '../dist/embedding/embedder.js';

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } console.log('ok  -', m); };
const settled = (p) => { let done = false; p.then(() => (done = true), () => (done = true)); return () => done; };
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- IndexState gates + status --------------------------------------------
{
  const st = new IndexState();
  let s = st.status();
  assert(s.building === false && s.percent === 100, 'fresh state: not building, 100%');

  const searchableDone = settled(st.searchable);
  const completeDone = settled(st.indexComplete);
  await tick();
  assert(!searchableDone() && !completeDone(), 'both gates start pending');

  st.beginBuild(10);
  s = st.status();
  assert(s.building && s.filesTotal === 10 && s.percent === 0, 'beginBuild: building, 0%');

  st.progress(5);
  assert(st.status().percent === 50, 'progress(5/10) → 50%');

  st.markSearchable();
  await tick();
  assert(searchableDone(), 'markSearchable resolves the searchable gate');
  assert(!completeDone(), 'indexComplete still pending after markSearchable');

  st.finishBuild();
  await tick();
  assert(completeDone(), 'finishBuild resolves indexComplete');
  s = st.status();
  assert(!s.building && s.percent === 100, 'after finishBuild: not building, 100%');
}

// ---- failInit surfaces an error instead of hanging ------------------------
{
  const st = new IndexState();
  let rejected = false;
  st.searchable.catch(() => (rejected = true));
  st.indexComplete.catch(() => {});
  st.failInit(new Error('model load failed'));
  await tick();
  assert(rejected, 'failInit rejects the searchable gate (search errors, not hangs)');
}

// ---- priority queue: high (query) preempts low (background build) ---------
console.log('\nLoading embedder for the priority-queue test (uses the cached model)…');
await initEmbedder({ model: 'onnx-community/embeddinggemma-300m-ONNX', dtype: 'q8', topKDefault: 8 });

const order = [];
const lows = [];
for (let i = 0; i < 5; i++) {
  lows.push(embedBatch([`background chunk ${i}`], { priority: 'low' }).then(() => order.push(`low${i}`)));
}
// Enqueued after the lows, but high-priority — must finish before the pending lows.
const high = embedBatch(['user search query'], { priority: 'high' }).then(() => order.push('high'));

await Promise.all([...lows, high]);
console.log('completion order:', order.join(', '));
assert(order[0] === 'high', 'a high-priority query embed runs before already-queued low-priority embeds');
assert(order.length === 6, 'all six embeds completed');

console.log('\nAll lazy-indexing tests passed.');
