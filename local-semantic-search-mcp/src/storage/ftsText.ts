// FTS5 text/token helpers — extracted from store.ts so they can be shared with
// the query planner (queryPlan.ts) WITHOUT that module importing VectorStore
// (which would create store.ts <-> queryPlan.ts import cycle, since store.ts
// needs queryPlan's types for its tiered search). This module has no
// dependency on the store, sqlite, or anything else — pure text functions.

// Common English/question function words carry no lexical signal for code
// search but, OR'd into the MATCH, would let bm25 reward chunks that merely
// repeat them — dethroning the true answer on natural-language queries. Dropped
// so the lexical arm matches on the meaningful terms only.
export const FTS_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'and', 'or',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'has', 'have',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'with', 'from', 'into',
  'where', 'what', 'which', 'who', 'whom', 'how', 'why', 'when',
]);

// Bumped whenever the FTS *content* format changes (e.g. adding split-identifier
// tokens). A stored index whose stamp differs is rebuilt from existing chunk
// text on the next writer start — no re-embed, just a lexical re-index.
export const FTS_VERSION = '2';

// Split a camelCase / snake_case / kebab-case identifier into its sub-words.
// FTS5's word tokenizer treats `getUserById` as ONE token, so a two-word query
// ("user by id") never matches it. Emitting the sub-words at index (and query)
// time fixes that. Returns [] when the token isn't a compound identifier.
export function splitIdentifier(token: string): string[] {
  const spaced = token
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  if (spaced === token) return [];
  return spaced.split(/\s+/).filter((w) => w.length > 0);
}

// Augment text for the FTS index: the original text plus the sub-words of any
// compound identifiers in it, so both `cosineSimilarity` and the phrase "cosine
// similarity" match the same chunk. Only the extra split-words are appended (the
// originals are already present), deduped to keep the addition small.
export function ftsAugment(text: string): string {
  const words = text.match(/[A-Za-z0-9]+/g) ?? [];
  const extra = new Set<string>();
  for (const w of words) {
    for (const part of splitIdentifier(w)) extra.add(part.toLowerCase());
  }
  return extra.size > 0 ? `${text} ${[...extra].join(' ')}` : text;
}

// Turn a free-text query into a safe FTS5 MATCH expression. User queries
// contain punctuation ("where's the cache?") and FTS operators that would be a
// syntax error or mean something unintended, so we extract bare word/identifier
// tokens and OR them as quoted single-token phrases. OR (not the FTS default
// AND) maximises lexical recall — RRF then ranks; a chunk matching more terms
// naturally scores better on bm25. Stopwords are removed first. Returns null
// when nothing usable remains (e.g. an all-stopword query) so the caller falls
// back to pure vector search.
export function toFtsMatch(text: string): string | null {
  const raw = (text.match(/[A-Za-z0-9_]+/g) ?? []).filter(
    (t) => t.length >= 2 && !FTS_STOPWORDS.has(t.toLowerCase()),
  );
  // Include each token AND its identifier sub-words, so a camelCase query term
  // matches the split tokens now stored in the index (and vice-versa).
  const set = new Set<string>();
  for (const t of raw) {
    set.add(t);
    for (const part of splitIdentifier(t)) {
      if (part.length >= 2 && !FTS_STOPWORDS.has(part.toLowerCase())) set.add(part);
    }
  }
  const tokens = [...set].slice(0, 48);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

// Extract bare word/identifier tokens from free text (punctuation stripped),
// deduped, stopwords removed, lowercased. The shared tokenization step behind
// both toFtsMatch and the query planner, so the two always agree on what
// counts as a "term" in a user query.
export function extractQueryTokens(text: string): string[] {
  const raw = (text.match(/[A-Za-z0-9_]+/g) ?? []).filter(
    (t) => t.length >= 2 && !FTS_STOPWORDS.has(t.toLowerCase()),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const lower = t.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      out.push(lower);
    }
  }
  return out;
}

// Escape a token for use inside a quoted FTS5 MATCH phrase (`"..."`). FTS5
// quoted strings use `""` to escape an embedded `"`; tokens here are already
// restricted to [A-Za-z0-9_] by extractQueryTokens/toFtsMatch, so this is a
// defensive no-op in practice, kept for any caller passing raw text.
export function ftsQuote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}
