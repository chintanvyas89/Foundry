import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { embed } from '../embedding/embedder.js';
import type { VectorStore } from '../storage/store.js';
import { blend } from '../storage/similarity.js';
import type { Config } from '../config.js';

// Relevance-feedback tuning per mode. `find` is a plain search; `refine` leans
// harder on pinned results and keeps only high-confidence hits; `expand`
// broadens (lighter pins, lower floor, more results) to surface neighbours.
const MODES = {
  find: { pinWeight: 1.0, minScore: 0, topKFactor: 1 },
  refine: { pinWeight: 1.3, minScore: 0.5, topKFactor: 1 },
  expand: { pinWeight: 0.6, minScore: 0.25, topKFactor: 2 },
} as const;

export function registerSemanticSearchTool(
  server: McpServer,
  store: VectorStore,
  config: Config,
  workspaceRoot: string,
  ready: Promise<void>,
): void {
  server.tool(
    'semantic_search',
    'Find code in the current workspace by meaning/intent. USE THIS FIRST — before ' +
      'reading files or grepping — to answer "where is X implemented?", "what code ' +
      'handles Y?", or "find code similar to Z" across this codebase. It ranks the ' +
      'most relevant functions/classes by semantic similarity to a natural-language ' +
      'or code query (not keyword match) and returns each with its file path, line ' +
      'range, and the code itself, so you can jump straight to the right place ' +
      'instead of scanning files one by one. Prefer this over file-reading for ' +
      'locating or exploring unfamiliar code.',
    {
      query: z
        .string()
        .describe('What to find, in natural language or code, e.g. "where JWT tokens are validated"'),
      topK: z.number().int().positive().optional().describe('How many results to return (default 8)'),
      pins: z
        .array(z.string())
        .optional()
        .describe(
          'Relevance feedback: chunk ids (the "id" field from prior results) to steer the ' +
            'search toward. Their stored vectors are blended into the query — no re-embedding.',
        ),
      note: z
        .string()
        .optional()
        .describe('Extra text blended into the query to refine intent, e.g. "the discount rules".'),
      mode: z
        .enum(['find', 'refine', 'expand'])
        .optional()
        .describe('find (default), refine (narrow to high-confidence hits), or expand (broaden).'),
    },
    async ({ query, topK, pins, note, mode }) => {
      // Block until the background model load + initial index have finished.
      // A query that arrives during startup waits here rather than running
      // against a not-yet-loaded embedder or an empty store.
      await ready;

      const tuning = MODES[mode ?? 'find'];

      // Build the search direction: the query, plus any typed note and pinned
      // results, blended by weight (see MODES). With nothing pinned and no note
      // this is just the query vector.
      const queryEmbedding = await embed(query);
      const components: Array<{ vec: Float32Array; weight: number }> = [
        { vec: queryEmbedding, weight: 1.0 },
      ];
      if (note && note.trim()) {
        components.push({ vec: await embed(note), weight: 1.0 });
      }
      if (pins && pins.length > 0) {
        const pinVecs = store.getEmbeddingsByIds(pins);
        for (const vec of pinVecs) {
          components.push({ vec, weight: tuning.pinWeight / pinVecs.length });
        }
      }
      const direction = components.length === 1 ? queryEmbedding : blend(components);

      const k = topK ?? config.topKDefault * tuning.topKFactor;
      let results = store.search(direction, k);
      if (tuning.minScore > 0) {
        results = results.filter((r) => r.score >= tuning.minScore);
      }

      if (results.length === 0) {
        return {
          content: [{ type: 'text', text: 'No matching code found.' }],
          structuredContent: { results: [] },
        };
      }

      // Stored paths are workspace-relative for portability; resolve each to an
      // absolute path against THIS machine's workspace root so callers (the
      // human-readable text and structured clients like the editor search
      // panel) can open the file directly. `id` is passed through opaquely so a
      // client can pin the result back for relevance feedback.
      const resolved = results.map((r) => ({
        id: r.id,
        file: join(workspaceRoot, r.file),
        symbol: r.symbol ?? null,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        text: r.text,
      }));

      const text = resolved
        .map((r, i) => {
          const location = `${r.file}:${r.startLine}-${r.endLine}`;
          const label = r.symbol ? `${r.symbol} (${location})` : location;
          return `${i + 1}. ${label} — score ${r.score.toFixed(3)}\n\`\`\`\n${r.text}\n\`\`\``;
        })
        .join('\n\n');

      // `content` is what an LLM reads; `structuredContent` is the same result
      // set as machine-readable JSON for non-LLM UI clients.
      return { content: [{ type: 'text', text }], structuredContent: { results: resolved } };
    },
  );
}
