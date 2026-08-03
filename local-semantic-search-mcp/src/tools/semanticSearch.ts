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
  // Ordered chunk ids of the most recent search's results, kept in memory so a
  // follow-up call can pin results by their NUMBER (1-based, as printed) via
  // `pinResults` — no need to surface raw chunk ids in the text output. This is
  // per server process, which maps naturally to one client/conversation.
  let lastResultIds: string[] = [];

  server.tool(
    'semantic_search',
    'Find code in the current workspace by meaning/intent. USE THIS FIRST — before ' +
      'reading files or grepping — to answer "where is X implemented?", "what code ' +
      'handles Y?", or "find code similar to Z" across this codebase. It ranks the ' +
      'most relevant functions/classes by semantic similarity to a natural-language ' +
      'or code query (not keyword match). ' +
      'BY DEFAULT it returns a TOKEN-LEAN list: each hit as its symbol, file:line ' +
      'range, score, and one-line signature — enough to pick the right place without ' +
      'pulling whole function bodies into context. To read the full code of specific ' +
      'hits, call again with expand=[n,...] (the NUMBERS from the list; no need to ' +
      'repeat the query), or open the file at the given line range. Pass detail="full" ' +
      'to get every result\'s full body at once. ' +
      'TO DRILL DOWN, call it again: set mode="refine" to narrow to high-confidence ' +
      'hits or mode="expand" to broaden; add a note to sharpen intent; and/or pass ' +
      'pinResults with the NUMBERS of the previous results you found on-target (e.g. ' +
      'pinResults=[1,3]) to steer the next search toward them.',
    {
      query: z
        .string()
        .optional()
        .describe(
          'What to find, in natural language or code, e.g. "where JWT tokens are ' +
            'validated". Required unless you are using expand to fetch full code of ' +
            'previous results.',
        ),
      topK: z.number().int().positive().optional().describe('How many results to return (default 8)'),
      detail: z
        .enum(['compact', 'full'])
        .optional()
        .describe(
          'compact (default): symbol + location + score + one-line signature per hit ' +
            '(token-lean). full: include each hit\'s complete code body.',
        ),
      expand: z
        .array(z.number().int().positive())
        .optional()
        .describe(
          'Result NUMBERS from your PREVIOUS semantic_search call whose full code you ' +
            'want (e.g. [1, 3]). Returns those bodies without re-running the search; no ' +
            'query needed.',
        ),
      pinResults: z
        .array(z.number().int().positive())
        .optional()
        .describe(
          'Relevance feedback by result number: 1-based positions from your PREVIOUS ' +
            'semantic_search call to steer this search toward (e.g. [1, 3]). No need to ' +
            'track chunk ids — the server remembers the last results.',
        ),
      note: z
        .string()
        .optional()
        .describe('Extra text blended into the query to refine intent, e.g. "the discount rules".'),
      mode: z
        .enum(['find', 'refine', 'expand'])
        .optional()
        .describe('find (default), refine (narrow to high-confidence hits), or expand (broaden).'),
      pins: z
        .array(z.string())
        .optional()
        .describe(
          'Relevance feedback by chunk id (the "id" from structured results) — used by ' +
            'non-LLM UI clients. Prefer pinResults if you are working from the text output.',
        ),
    },
    async ({ query, topK, pins, pinResults, note, mode, detail, expand }) => {
      // Block until the background model load + initial index have finished.
      // A query that arrives during startup waits here rather than running
      // against a not-yet-loaded embedder or an empty store.
      await ready;

      // Expand-on-request: return the full code of specific PRIOR results by
      // their number, without re-embedding or re-searching. This is the other
      // half of the compact-by-default contract — the model triages on cheap
      // signatures, then pulls only the bodies it actually needs.
      if (expand && expand.length > 0) {
        const ids = expand
          .map((n) => lastResultIds[n - 1])
          .filter((id): id is string => Boolean(id));
        const rows = store.getChunksByIds(ids);
        if (rows.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text:
                  'Nothing to expand — those result numbers are not from the last ' +
                  'search. Run semantic_search first, then expand its result numbers.',
              },
            ],
            structuredContent: { results: [] },
          };
        }
        const resolvedExpand = rows.map((r) => resolveResult(r, workspaceRoot));
        return {
          content: [{ type: 'text', text: renderFull(resolvedExpand, false) }],
          structuredContent: { results: resolvedExpand },
        };
      }

      if (!query || !query.trim()) {
        return {
          content: [
            {
              type: 'text',
              text: 'Provide a query to search for, or expand=[n,...] to fetch full code of previous results.',
            },
          ],
          structuredContent: { results: [] },
        };
      }

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
      // Pins can arrive as explicit chunk ids (UI clients) and/or as result
      // numbers from the previous search (LLM callers). Resolve the numbers
      // against the remembered last results, then blend all pinned vectors.
      const pinIds = [...(pins ?? [])];
      if (pinResults && pinResults.length > 0) {
        for (const n of pinResults) {
          const id = lastResultIds[n - 1];
          if (id) pinIds.push(id);
        }
      }
      if (pinIds.length > 0) {
        const pinVecs = store.getEmbeddingsByIds(pinIds);
        for (const vec of pinVecs) {
          components.push({ vec, weight: tuning.pinWeight / pinVecs.length });
        }
      }
      const direction = components.length === 1 ? queryEmbedding : blend(components);

      const k = topK ?? config.topKDefault * tuning.topKFactor;
      // Hybrid retrieval: the blended vector drives semantic ranking while the
      // raw query text (plus any note) drives the lexical/FTS arm, so exact
      // identifiers the embedding misses still surface. Degrades to pure vector
      // search when FTS5 is unavailable.
      const textQuery = note && note.trim() ? `${query} ${note}` : query;
      let results = store.searchHybrid(direction, textQuery, k);
      if (tuning.minScore > 0) {
        results = results.filter((r) => r.score >= tuning.minScore);
      }

      // Remember this result set so a follow-up call can pin by result number.
      lastResultIds = results.map((r) => r.id);

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
      const resolved = results.map((r) => resolveResult(r, workspaceRoot));

      // Compact by default (signatures only — token-lean); full bodies on
      // request. structuredContent always carries the full text so non-LLM UI
      // clients (the search panel) render code cards regardless of `detail`.
      const text = (detail ?? 'compact') === 'full' ? renderFull(resolved) : renderCompact(resolved);

      // `content` is what an LLM reads; `structuredContent` is the same result
      // set as machine-readable JSON for non-LLM UI clients.
      return { content: [{ type: 'text', text }], structuredContent: { results: resolved } };
    },
  );
}

interface ResolvedResult {
  id: string;
  file: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
}

// Resolve a stored (workspace-relative) result to an absolute-path result the
// caller can open directly.
function resolveResult(
  r: { id: string; file: string; symbol?: string; startLine: number; endLine: number; score: number; text: string },
  workspaceRoot: string,
): ResolvedResult {
  return {
    id: r.id,
    file: join(workspaceRoot, r.file),
    symbol: r.symbol ?? null,
    startLine: r.startLine,
    endLine: r.endLine,
    score: r.score,
    text: r.text,
  };
}

function label(r: ResolvedResult): string {
  const location = `${r.file}:${r.startLine}-${r.endLine}`;
  return r.symbol ? `${r.symbol} (${location})` : location;
}

// One-line signature: the first non-empty line of the chunk (usually the
// declaration), trimmed and length-capped, with an ellipsis when a body
// follows — enough to recognise the symbol without emitting its whole body.
function signatureOf(text: string): string {
  const nonEmpty = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  const first = nonEmpty[0]?.trim() ?? '';
  const clipped = first.length > 200 ? `${first.slice(0, 197)}…` : first;
  return nonEmpty.length > 1 ? `${clipped} …` : clipped;
}

// Token-lean listing: number, symbol/location, score, one-line signature.
function renderCompact(resolved: ResolvedResult[]): string {
  const body = resolved
    .map((r, i) => `${i + 1}. ${label(r)} — score ${r.score.toFixed(3)}\n    ${signatureOf(r.text)}`)
    .join('\n\n');
  return (
    `${body}\n\n` +
    'Signatures only. For a hit\'s full code, call semantic_search again with ' +
    'expand=[n,...] (no query needed) or open the file at its line range.'
  );
}

// Full listing: each result's complete code body in a fenced block. `withScore`
// is false for expand-on-request, where the results were picked explicitly and
// carry no meaningful ranking score.
function renderFull(resolved: ResolvedResult[], withScore = true): string {
  return resolved
    .map((r, i) => {
      const head = withScore ? `${i + 1}. ${label(r)} — score ${r.score.toFixed(3)}` : `${i + 1}. ${label(r)}`;
      return `${head}\n\`\`\`\n${r.text}\n\`\`\``;
    })
    .join('\n\n');
}
