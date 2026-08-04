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

// ---- Priority scheduler ---------------------------------------------------
// There is ONE ONNX pipeline and it saturates every core, so two embed calls
// running at once would contend. We funnel all embedding through a single
// serialized runner with two FIFO queues: a user's SEARCH-query embed ('high')
// always jumps ahead of the background index build ('low'). Because callers
// enqueue one ≤EMBED_BATCH_SIZE sub-batch at a time and the runner yields the
// event loop between sub-batches, a query submitted mid-build waits at most one
// sub-batch (~tens of ms), never the whole remaining build.
export type EmbedPriority = 'high' | 'low';

interface EmbedTask {
  texts: string[]; // already ≤ EMBED_BATCH_SIZE
  resolve: (v: Float32Array[]) => void;
  reject: (e: unknown) => void;
}

const highQueue: EmbedTask[] = [];
const lowQueue: EmbedTask[] = [];
let draining = false;

function sliceVectors(output: { dims: number[]; data: Float32Array }, rows: number): Float32Array[] {
  const dims = output.dims as number[];
  const dim = dims[dims.length - 1];
  const data = output.data as Float32Array;
  const out: Float32Array[] = [];
  for (let r = 0; r < rows; r++) {
    // .slice copies, so each vector owns its own backing buffer.
    out.push(new Float32Array(data.slice(r * dim, (r + 1) * dim)));
  }
  return out;
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const extractor = await extractorPromise!;
    while (highQueue.length > 0 || lowQueue.length > 0) {
      const task = highQueue.shift() ?? lowQueue.shift()!;
      try {
        const output = await extractor(task.texts, { pooling: 'mean', normalize: true });
        task.resolve(sliceVectors(output as { dims: number[]; data: Float32Array }, task.texts.length));
      } catch (err) {
        task.reject(err);
      }
      // Yield so a high-priority query that arrived mid-batch is picked next.
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    draining = false;
  }
}

function schedule(texts: string[], priority: EmbedPriority): Promise<Float32Array[]> {
  return new Promise<Float32Array[]>((resolve, reject) => {
    (priority === 'high' ? highQueue : lowQueue).push({ texts, resolve, reject });
    void drain();
  });
}

// Embed many texts at once. A single model call over a batch is meaningfully
// faster per chunk than one call each, which is what the indexer relies on for
// the build. `priority` defaults to 'high' (search queries); the background
// index build passes 'low' so it yields to queries.
export async function embedBatch(
  texts: string[],
  opts?: { priority?: EmbedPriority },
): Promise<Float32Array[]> {
  if (!extractorPromise) {
    throw new Error('Embedder not initialized — call initEmbedder(config) at startup first.');
  }
  const priority = opts?.priority ?? 'high';
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const sub = texts.slice(i, i + EMBED_BATCH_SIZE);
    out.push(...(await schedule(sub, priority)));
  }
  return out;
}

export async function embed(text: string): Promise<Float32Array> {
  return (await embedBatch([text]))[0];
}
