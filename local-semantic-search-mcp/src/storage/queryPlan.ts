import { extractQueryTokens, ftsQuote } from './ftsText.js';

// The query planner: turns a free-text semantic_search query into a TIERED FTS5
// match strategy, so a multi-word query like "xyz block" doesn't get diluted by
// a ubiquitous term ("block" used thousands of times) when the real target is a
// compound identifier (`xyzBlock` / `xyz_block` / `xyz-block`).
//
// This module is a LEAF — it has no dependency on VectorStore/sqlite (doc
// frequency and vocabulary are INJECTED by the caller), so store.ts can import
// it without creating an import cycle, and it stays trivially unit-testable.
//
// Why THREE tiers instead of one OR-of-everything MATCH:
//   Tier 1 (compound)  — targets identifiers with NO separator (xyzBlock),
//     which the FTS5 tokenizer stores as a single token. A plain OR can never
//     favor this case over "xyz OR block" noise; an exact joined-token phrase
//     query can, precisely.
//   Tier 2 (proximity) — targets identifiers WITH a separator (xyz_block,
//     xyz-block) or just naturally-adjacent source text. These tokenize to
//     ["xyz","block"] adjacent in the index; NEAR(...) matches that adjacency
//     specifically, which plain OR (order/distance-blind) cannot express.
//   Tier 3 (recall floor) — today's behavior: OR of the query's RARE tokens
//     (ubiquitous ones dropped), so a query that isn't about a compound
//     identifier at all still gets normal lexical recall, unchanged.
// Tiers are additive signal, not exclusive routing — the caller (store.ts)
// tries all three and fuses with the vector arm; see searchHybrid.

export interface QueryPlanOptions {
  // Count of chunks whose FTS content contains this bare token. Injected so
  // this module never touches the DB directly.
  docFrequency: (token: string) => number;
  totalChunks: number;
  // Ratio of totalChunks at/above which a token is treated as "ubiquitous" —
  // dropped from the tier-3 recall floor (kept in tier-1/2, where proximity/
  // exactness already makes it precise). Default 0.01 (1% of the corpus).
  ubiquityRatio?: number;
  // Canonical identifier variants a project-vocabulary layer resolved for this
  // query (e.g. "content type" -> ["NodeType", "node_type"]). Optional — the
  // core planner is framework-agnostic and does nothing with vocabulary unless
  // a caller wires resolution in (see vocab/index.ts).
  vocabTerms?: string[];
}

export interface QueryPlan {
  tokens: string[]; // all non-stopword query tokens, lowercased, in query order
  rareTokens: string[]; // tokens below the ubiquity threshold (or all, if every token is common)
  commonTokens: string[]; // tokens at/above the ubiquity threshold
  compounds: string[]; // adjacent-pair + whole-run joins, e.g. "xyzblock"
  vocabTerms: string[]; // pass-through of resolved vocabulary terms
  matchTier1: string | null; // FTS MATCH: compounds + vocabTerms as exact phrases, OR'd
  matchTier2: string | null; // FTS MATCH: NEAR proximity across all query tokens
  matchTier3: string | null; // FTS MATCH: OR of rare tokens (today's toFtsMatch behavior)
  symbolProbes: string[]; // candidates worth checking against the symbol table
}

const DEFAULT_UBIQUITY_RATIO = 0.01;
const NEAR_DISTANCE = 4;
const MAX_SYMBOL_PROBES = 12;

export function planQuery(rawQuery: string, opts: QueryPlanOptions): QueryPlan {
  const tokens = extractQueryTokens(rawQuery);
  const ratio = opts.ubiquityRatio ?? DEFAULT_UBIQUITY_RATIO;

  let commonTokens: string[] = [];
  let rareTokens: string[] = tokens;
  if (opts.totalChunks > 0 && tokens.length > 0) {
    commonTokens = tokens.filter((t) => opts.docFrequency(t) / opts.totalChunks >= ratio);
    const rare = tokens.filter((t) => !commonTokens.includes(t));
    // Guard: never let ubiquity classification empty the recall floor — a query
    // that's ENTIRELY common terms (e.g. just "block") still needs to search.
    rareTokens = rare.length > 0 ? rare : tokens;
  }

  const compounds = buildCompounds(tokens);
  const vocabTerms = dedupe(opts.vocabTerms ?? []);

  const tier1Candidates = dedupe([...compounds, ...vocabTerms]);
  const matchTier1 = tier1Candidates.length > 0 ? tier1Candidates.map(ftsQuote).join(' OR ') : null;

  const matchTier2 = tokens.length >= 2 ? `NEAR(${tokens.map(ftsQuote).join(' ')}, ${NEAR_DISTANCE})` : null;

  const matchTier3 = rareTokens.length > 0 ? rareTokens.map(ftsQuote).join(' OR ') : null;

  const symbolProbes = dedupe([...compounds, ...vocabTerms]).slice(0, MAX_SYMBOL_PROBES);

  return { tokens, rareTokens, commonTokens, compounds, vocabTerms, matchTier1, matchTier2, matchTier3, symbolProbes };
}

// Adjacent-pair joins (covers 2+ tokens) plus the whole-run join, lowercase, no
// separator — targets identifiers the FTS5 tokenizer stores as ONE token
// (camelCase/PascalCase/already-joined lowercase). Snake/kebab/spaced forms are
// covered by tier 2 (NEAR), not here — joining them would look for a token that
// was never indexed (see the module doc comment above).
function buildCompounds(tokens: string[]): string[] {
  if (tokens.length < 2) return [];
  const out: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    out.push(tokens[i] + tokens[i + 1]);
  }
  if (tokens.length > 2) out.push(tokens.join(''));
  return dedupe(out).filter((c) => c.length >= 4);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (!seen.has(key) && key.length > 0) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}
