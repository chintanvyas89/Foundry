// Benchmark embedding throughput on THIS machine, and show the batching win.
// Run:  node scripts/bench.mjs
import { pipeline } from '@huggingface/transformers';

const MODEL = 'onnx-community/embeddinggemma-300m-ONNX';
const DTYPE = process.env.DTYPE ?? 'q8';

// A handful of realistic code-sized snippets (~10-30 lines), repeated to N.
const snippet = `export async function chunkFile(filePath, workspaceRoot) {
  const bridgeSymbols = await getSymbolsViaBridge(workspaceRoot, filePath);
  if (bridgeSymbols && bridgeSymbols.length > 0) {
    const chunks = chunksFromBridgeSymbols(filePath, bridgeSymbols);
    if (chunks.length > 0) return chunks;
  }
  const ext = extname(filePath);
  if (supportsTreeSitter(ext)) {
    const chunks = await chunkWithTreeSitter(filePath, ext);
    if (chunks.length > 0) return chunks;
  }
  return chunkByFixedWindow(filePath);
}`;
const N = Number(process.env.N ?? 24);
const texts = Array.from({ length: N }, (_, i) => `// chunk ${i}\n${snippet}`);

console.error(`[bench] loading model (${MODEL}, dtype=${DTYPE}) ...`);
const t0 = Date.now();
const extractor = await pipeline('feature-extraction', MODEL, { dtype: DTYPE });
console.error(`[bench] model loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// warm up (first inference pays extra one-time cost)
await extractor(texts[0], { pooling: 'mean', normalize: true });

// --- sequential, one chunk at a time (what the indexer does today) ---
const s0 = Date.now();
for (const t of texts) await extractor(t, { pooling: 'mean', normalize: true });
const seqMs = Date.now() - s0;

// --- batched, all N in one call (the proposed improvement) ---
const b0 = Date.now();
await extractor(texts, { pooling: 'mean', normalize: true });
const batchMs = Date.now() - b0;

console.log('\n===== results =====');
console.log(`chunks:                 ${N}`);
console.log(`sequential total:       ${(seqMs / 1000).toFixed(1)}s  (${(seqMs / N).toFixed(0)} ms/chunk)`);
console.log(`batched total:          ${(batchMs / 1000).toFixed(1)}s  (${(batchMs / N).toFixed(0)} ms/chunk)`);
console.log(`batching speedup:       ${(seqMs / batchMs).toFixed(1)}x`);
process.exit(0);
