import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { Config } from '../config.js';

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

// Lazily created on first call and reused for the life of the process —
// loading the model is the expensive part, embedding a single string is
// cheap once it's warm.
export function initEmbedder(config: Config): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    // The explicit type argument keeps TS from trying to infer T from
    // context and then indexing the ~40-variant AllTasks map to resolve the
    // return type — that combination blows past tsc's type-complexity
    // budget (TS2590) even though 'feature-extraction' alone resolves fine.
    extractorPromise = pipeline<'feature-extraction'>('feature-extraction', config.model, {
      dtype: config.dtype as never,
      // Log download/load progress to stderr. Without this the first run —
      // which fetches a few hundred MB of model weights — prints nothing and
      // looks like a hang. Also lets a killed/partial download be spotted
      // (it won't reach 100%) rather than silently caching a truncated file.
      progress_callback: (p: { status: string; file?: string; progress?: number }) => {
        if (p.status === 'progress' && p.file && typeof p.progress === 'number') {
          process.stderr.write(`[swe-search] downloading ${p.file}: ${p.progress.toFixed(0)}%\r`);
        } else if (p.status === 'done' && p.file) {
          console.error(`[swe-search] fetched ${p.file}`);
        }
      },
    });
  }
  return extractorPromise;
}

// How many chunks to embed per model call. The model already saturates the
// CPU across cores, so this mostly amortizes per-call overhead; kept modest
// to bound peak memory and sequence-padding waste on long chunks.
const EMBED_BATCH_SIZE = 16;

// Embed many texts at once. A single model call over a batch is meaningfully
// faster per chunk than one call each, which is what the indexer relies on
// for the initial build.
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (!extractorPromise) {
    throw new Error('Embedder not initialized — call initEmbedder(config) at startup first.');
  }
  const extractor = await extractorPromise;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const output = await extractor(batch, { pooling: 'mean', normalize: true });
    const dims = output.dims as number[];
    const dim = dims[dims.length - 1];
    const data = output.data as Float32Array;
    for (let r = 0; r < batch.length; r++) {
      // .slice copies, so each vector owns its own backing buffer.
      out.push(new Float32Array(data.slice(r * dim, (r + 1) * dim)));
    }
  }
  return out;
}

export async function embed(text: string): Promise<Float32Array> {
  return (await embedBatch([text]))[0];
}
