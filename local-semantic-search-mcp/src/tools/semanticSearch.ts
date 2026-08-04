import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { embed } from '../embedding/embedder.js';
import { indexState } from '../indexing/indexState.js';
import type { VectorStore, CallGraphNode } from '../storage/store.js';
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
      'pinResults=[1,3]) to steer the next search toward them. ' +
      'Pass context=true to annotate each hit with its callers/callees from the call ' +
      'graph (execution context inline, no extra trace_calls needed).',
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
      context: z
        .boolean()
        .optional()
        .describe(
          'When true, annotate each hit with structural context: its enclosing parent ' +
            '(e.g. the class a method is in), its callers/callees from the call graph, ' +
            'and related tests — so you get the flow around a result without extra ' +
            'trace_calls/find_usages. Draws on the built graph/symbol/usages indexes ' +
            '(whichever exist); adds a few tokens per hit, so leave off for plain ' +
            'lookups.',
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
    async ({ query, topK, pins, pinResults, note, mode, detail, expand, context }) => {
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

      // Lazy indexing: search opens as soon as the hot set is embedded, so an
      // early query may see a partial index. Surface that so the caller knows
      // results can be incomplete (and knows to re-run once it finishes).
      const idx = indexingStatus();

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                (idx?.note ?? '') +
                (idx ? 'No matches yet — the index is still building.' : 'No matching code found.'),
            },
          ],
          structuredContent: { results: [], ...(idx ? { indexing: idx.indexing } : {}) },
        };
      }

      // Structural context (opt-in): annotate each hit with its callers/callees
      // (call graph), its enclosing parent symbol (symbol table), and related
      // tests (usages index). All are cheap DB lookups keyed by the stored
      // (workspace-relative) file + symbol/line — no embedder or bridge — and
      // each source is used only if it's been built, so this degrades cleanly.
      const contextById = new Map<string, StructuralContext>();
      if (context === true) {
        const hasGraph = store.graphStats().edges > 0;
        const hasSymbols = store.symbolStats().symbols > 0;
        const hasUsages = store.usageStats().refs > 0;
        for (const r of results) {
          if (!r.symbol) continue;
          const callers = hasGraph ? store.getCallers(r.file, r.symbol) : [];
          const callees = hasGraph ? store.getCallees(r.file, r.symbol) : [];
          const parent = hasSymbols ? store.getEnclosingSymbol(r.file, r.startLine) : null;
          const tests = hasUsages ? testsFor(store, r.file, r.symbol) : [];
          if (callers.length || callees.length || parent || tests.length) {
            contextById.set(r.id, {
              callers,
              callees,
              ...(parent ? { parent } : {}),
              ...(tests.length ? { tests } : {}),
            });
          }
        }
      }

      // Stored paths are workspace-relative for portability; resolve each to an
      // absolute path against THIS machine's workspace root so callers (the
      // human-readable text and structured clients like the editor search
      // panel) can open the file directly. `id` is passed through opaquely so a
      // client can pin the result back for relevance feedback.
      const resolved = results.map((r) => resolveResult(r, workspaceRoot, contextById.get(r.id)));

      // Compact by default (signatures only — token-lean); full bodies on
      // request. structuredContent always carries the full text so non-LLM UI
      // clients (the search panel) render code cards regardless of `detail`.
      const text = (detail ?? 'compact') === 'full' ? renderFull(resolved) : renderCompact(resolved);

      // `content` is what an LLM reads; `structuredContent` is the same result
      // set as machine-readable JSON for non-LLM UI clients.
      return {
        content: [{ type: 'text', text: (idx?.note ?? '') + text }],
        structuredContent: { results: resolved, ...(idx ? { indexing: idx.indexing } : {}) },
      };
    },
  );
}

// While the background embedding pass is running (lazy indexing), return a note
// to prepend to results and an `indexing` payload for structured clients.
// Returns null once the index is complete.
function indexingStatus(): { note: string; indexing: { building: boolean; percent: number } } | null {
  const s = indexState.status();
  if (!s.building) return null;
  return {
    note:
      `⏳ Index still building — ${s.percent}% of files embedded; results may be ` +
      'incomplete, re-run shortly for full coverage.\n\n',
    indexing: { building: true, percent: s.percent },
  };
}

// Structural context for a result (opt-in via `context`): callers/callees from
// the call graph, the enclosing parent declaration from the symbol table, and
// related tests from the usages index. Each field is present only when its
// source is built and has something for the symbol.
interface StructuralContext {
  callers: CallGraphNode[];
  callees: CallGraphNode[];
  parent?: { name: string; kind: string; startLine: number; endLine: number };
  tests?: string[];
}

// A reference lives in a test file if its path looks like a test/spec — used to
// surface "related tests" for a hit from its stored usages.
function isTestPath(rel: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs)(\/|$)|[._-](test|spec)\.[a-z]+$|(^|\/)(test|spec)_/i.test(
    rel,
  );
}

// Test references to (file, symbol) from the persisted usages index, as
// `file:line`, deduped. Empty when usages aren't built or none are tests.
function testsFor(store: VectorStore, file: string, symbol: string): string[] {
  const uniq = new Set<string>();
  for (const u of store.getUsages(file, symbol)) {
    if (isTestPath(u.file)) uniq.add(`${u.file}:${u.line}`);
  }
  return [...uniq];
}

interface ResolvedResult {
  id: string;
  file: string;
  symbol: string | null;
  startLine: number;
  endLine: number;
  score: number;
  text: string;
  context?: StructuralContext;
}

// Resolve a stored (workspace-relative) result to an absolute-path result the
// caller can open directly. `context` (callers/callees) is attached only when
// structural context was requested and the graph had edges for the symbol.
function resolveResult(
  r: { id: string; file: string; symbol?: string; startLine: number; endLine: number; score: number; text: string },
  workspaceRoot: string,
  context?: StructuralContext,
): ResolvedResult {
  return {
    id: r.id,
    file: join(workspaceRoot, r.file),
    symbol: r.symbol ?? null,
    startLine: r.startLine,
    endLine: r.endLine,
    score: r.score,
    text: r.text,
    ...(context ? { context } : {}),
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

// One-line structural-context annotation: enclosing parent, what the symbol
// calls / who calls it, and related tests — all deduped and capped so it stays
// token-lean.
function contextLine(ctx: StructuralContext): string {
  const names = (ns: CallGraphNode[]): string => {
    const uniq = [...new Set(ns.map((n) => n.name))];
    const shown = uniq.slice(0, 4).join(', ');
    return uniq.length > 4 ? `${shown} +${uniq.length - 4}` : shown;
  };
  const parts: string[] = [];
  if (ctx.parent) parts.push(`in ${ctx.parent.name}`);
  if (ctx.callees.length) parts.push(`calls: ${names(ctx.callees)}`);
  if (ctx.callers.length) parts.push(`called by: ${names(ctx.callers)}`);
  if (ctx.tests && ctx.tests.length) {
    const shown = ctx.tests.slice(0, 2).join(', ');
    parts.push(`tests: ${ctx.tests.length > 2 ? `${shown} +${ctx.tests.length - 2}` : shown}`);
  }
  return parts.join('  ·  ');
}

// Token-lean listing: number, symbol/location, score, one-line signature, and
// (when requested) a one-line callers/callees annotation.
function renderCompact(resolved: ResolvedResult[]): string {
  const body = resolved
    .map((r, i) => {
      const base = `${i + 1}. ${label(r)} — score ${r.score.toFixed(3)}\n    ${signatureOf(r.text)}`;
      return r.context ? `${base}\n    ${contextLine(r.context)}` : base;
    })
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
      const ctx = r.context ? `\n    ${contextLine(r.context)}` : '';
      return `${head}${ctx}\n\`\`\`\n${r.text}\n\`\`\``;
    })
    .join('\n\n');
}
