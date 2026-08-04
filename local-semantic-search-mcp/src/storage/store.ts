import { DatabaseSync } from 'node:sqlite';
import type { IndexedChunk, SearchResult } from '../types.js';
import { cosineSimilarity } from './similarity.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  symbol TEXT,
  startLine INTEGER NOT NULL,
  endLine INTEGER NOT NULL,
  text TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file);
-- Per-file content hash, used to skip re-indexing files that haven't changed
-- since the last run (survives server restarts).
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  fileHash TEXT NOT NULL
);
-- Small key/value table. Stamps the embedding model + dtype the vectors were
-- built with, so a mismatched (or path-incompatible legacy) index is rebuilt
-- rather than silently searched with the wrong model.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// Separate from SCHEMA because FTS5 is a compile-time SQLite option: not every
// build ships it. We create it in a try/catch and fall back to pure vector
// search if it's missing, so the server still runs on a locked-down box whose
// sqlite lacks FTS5. `id`/`file` are UNINDEXED (stored but not tokenized) so we
// can join back to `chunks` and delete a file's rows; `symbol`/`text` are the
// searchable columns. Kept in sync manually from the write path (no external
// triggers) — simpler and portable.
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  id UNINDEXED,
  file UNINDEXED,
  symbol,
  text,
  tokenize = 'unicode61 remove_diacritics 2'
);
`;

// Persisted call graph. Populated from the LSP bridge's call-hierarchy data by
// an explicit one-time build pass (embedding-free — no vectors involved), so
// callers/callees can be answered offline, without VS Code/the bridge running.
//
// Each row is a DIRECTED edge `from -> to` (caller -> callee), with `viaFile`
// recording which file's symbol was being processed when the edge was
// discovered — that lets incremental re-indexing wipe and refetch exactly the
// edges owned by a changed file. Paths are workspace-relative (like chunks).
// `graph_files` tracks which files' edges have been built (keyed on the same
// fileHash as `files`), making the long build pass resumable and incremental.
const EDGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS call_edges (
  fromFile TEXT NOT NULL,
  fromLine INTEGER NOT NULL,
  fromName TEXT NOT NULL,
  toFile TEXT NOT NULL,
  toLine INTEGER NOT NULL,
  toName TEXT NOT NULL,
  viaFile TEXT NOT NULL,
  PRIMARY KEY (fromFile, fromLine, fromName, toFile, toLine, toName, viaFile)
);
CREATE INDEX IF NOT EXISTS idx_edges_from ON call_edges(fromFile, fromName);
CREATE INDEX IF NOT EXISTS idx_edges_to ON call_edges(toFile, toName);
CREATE INDEX IF NOT EXISTS idx_edges_via ON call_edges(viaFile);
CREATE TABLE IF NOT EXISTS graph_files (
  path TEXT PRIMARY KEY,
  fileHash TEXT NOT NULL
);
`;

// Standalone symbol index. Populated from the LSP bridge's document symbols by
// an explicit one-time build pass (SWE_BUILD_SYMBOLS) — embedding-free, and kept
// entirely separate from chunking so it can carry NON-CALLABLE kinds
// (interfaces, enums, type aliases, constants, …) that never became chunks.
// `search_symbol` unions this with the callable symbols already on `chunks`.
// Paths are workspace-relative, so the table rides inside a shared `index.db`.
// `symbol_files` tracks which files have been scanned (same fileHash as `files`)
// for a resumable/incremental build.
const SYMBOL_SCHEMA = `
CREATE TABLE IF NOT EXISTS symbols (
  file TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  startLine INTEGER NOT NULL,
  endLine INTEGER NOT NULL,
  PRIMARY KEY (file, name, kind, startLine)
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE TABLE IF NOT EXISTS symbol_files (
  path TEXT PRIMARY KEY,
  fileHash TEXT NOT NULL
);
`;

// Paths in `chunks.file` / `chunks.id` / `files.path` are stored RELATIVE to
// the workspace root (forward-slash separated). That keeps the index portable
// between machines/checkouts, so it can be shared without every dev re-indexing.
// The indexer relativizes on write; search resolves back to absolute for display.

// Brute-force cosine similarity over Float32Array BLOBs, per §3 — this
// server targets tens of thousands of chunks per repo, not millions;
// revisit only if sqlite-vec becomes warranted.
export class VectorStore {
  private db: DatabaseSync;
  // Whether the FTS5 lexical index is usable. False if this sqlite build lacks
  // FTS5; the store then transparently degrades to pure vector search.
  private ftsEnabled = false;
  // Set once we've stamped the current FTS content version this process, so we
  // don't re-write the meta row on every upsert batch.
  private ftsStamped = false;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    // WAL lets readers (search queries) proceed concurrently with the
    // background indexer's writes instead of blocking on a single lock,
    // which matters most when this process is the "loser" of the
    // single-instance lock and only serves search. busy_timeout gives any
    // remaining writer contention (schema migrations, checkpoints) a chance
    // to retry instead of throwing SQLITE_BUSY straight to the caller.
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(SCHEMA);
    this.db.exec(EDGE_SCHEMA);
    this.db.exec(SYMBOL_SCHEMA);
    try {
      this.db.exec(FTS_SCHEMA);
      this.ftsEnabled = true;
    } catch {
      // No FTS5 in this sqlite build — searchText returns nothing and
      // searchHybrid behaves exactly like pure vector search.
      this.ftsEnabled = false;
    }
  }

  // Whether hybrid (vector + lexical) retrieval is active. False means this
  // sqlite build has no FTS5, so search is vector-only.
  ftsAvailable(): boolean {
    return this.ftsEnabled;
  }

  deleteByFile(file: string): void {
    this.db.prepare('DELETE FROM chunks WHERE file = ?').run(file);
    if (this.ftsEnabled) {
      this.db.prepare('DELETE FROM chunks_fts WHERE file = ?').run(file);
    }
  }

  countByFile(file: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM chunks WHERE file = ?').get(file) as {
      c: number;
    };
    return row.c;
  }

  // contentHash -> embedding for a file's currently-stored chunks. The
  // indexer uses this to reuse embeddings for chunks whose text is unchanged,
  // instead of paying to re-embed them.
  getEmbeddingsByFile(file: string): Map<string, Float32Array> {
    const rows = this.db
      .prepare('SELECT contentHash, embedding FROM chunks WHERE file = ?')
      .all(file) as Array<{ contentHash: string; embedding: Uint8Array }>;
    const map = new Map<string, Float32Array>();
    for (const row of rows) {
      map.set(row.contentHash, blobToVector(row.embedding));
    }
    return map;
  }

  // Stored embeddings for the given chunk ids, in no particular order (missing
  // ids are skipped). Used by relevance feedback: "pinning" a result reuses its
  // already-computed vector to steer the next search — no re-embedding.
  getEmbeddingsByIds(ids: string[]): Float32Array[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT embedding FROM chunks WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ embedding: Uint8Array }>;
    return rows.map((row) => blobToVector(row.embedding));
  }

  // Full chunk rows for the given ids, returned IN THE REQUESTED ORDER (missing
  // ids skipped). Powers expand-on-request: fetch the full body of specific
  // prior results by id without re-running a search. `score` is a placeholder
  // (0) — these come from an explicit pick, not a ranking.
  getChunksByIds(ids: string[]): SearchResult[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id, file, symbol, startLine, endLine, text, contentHash
           FROM chunks WHERE id IN (${placeholders})`,
      )
      .all(...ids) as Array<{
      id: string;
      file: string;
      symbol: string | null;
      startLine: number;
      endLine: number;
      text: string;
      contentHash: string;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
      .map((r) => ({
        id: r.id,
        file: r.file,
        symbol: r.symbol ?? undefined,
        startLine: r.startLine,
        endLine: r.endLine,
        text: r.text,
        contentHash: r.contentHash,
        score: 0,
      }));
  }

  getFileHash(file: string): string | null {
    const row = this.db.prepare('SELECT fileHash FROM files WHERE path = ?').get(file) as
      | { fileHash: string }
      | undefined;
    return row?.fileHash ?? null;
  }

  setFileHash(file: string, hash: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO files (path, fileHash) VALUES (?, ?)')
      .run(file, hash);
  }

  deleteFileHash(file: string): void {
    this.db.prepare('DELETE FROM files WHERE path = ?').run(file);
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  // Ensure the stored index was built with this model+dtype. If it wasn't
  // (model changed, or a legacy pre-stamp index with incompatible absolute
  // paths), wipe the vectors so buildFull rebuilds cleanly. Returns whether a
  // wipe happened, so the caller can log it.
  ensureModelStamp(model: string, dtype: string): { rebuilt: boolean } {
    if (this.getMeta('model') === model && this.getMeta('dtype') === dtype) {
      return { rebuilt: false };
    }
    const hadData =
      (this.db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c > 0;
    if (hadData) {
      this.db.exec('DELETE FROM chunks; DELETE FROM files;');
      if (this.ftsEnabled) this.db.exec('DELETE FROM chunks_fts;');
    }
    this.setMeta('model', model);
    this.setMeta('dtype', dtype);
    return { rebuilt: hadData };
  }

  // Drop index entries for files that are no longer present in the workspace
  // (deleted, or newly excluded by an ignore rule). `keep` is the set of
  // relative paths seen in the current walk. Returns how many files were pruned.
  pruneMissing(keep: Set<string>): number {
    const rows = this.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
    let pruned = 0;
    for (const { path } of rows) {
      if (!keep.has(path)) {
        this.deleteByFile(path);
        this.deleteFileHash(path);
        this.deleteEdgesByViaFile(path);
        this.deleteGraphFile(path);
        this.deleteSymbolsByFile(path);
        this.deleteSymbolFile(path);
        pruned++;
      }
    }
    return pruned;
  }

  upsertChunks(chunks: IndexedChunk[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO chunks (id, file, symbol, startLine, endLine, text, contentHash, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // FTS5 has no UPSERT, so mirror INSERT OR REPLACE as delete-then-insert on
    // the same id, inside the same transaction as the chunk write so the two
    // stay consistent.
    const ftsDel = this.ftsEnabled
      ? this.db.prepare('DELETE FROM chunks_fts WHERE id = ?')
      : null;
    const ftsIns = this.ftsEnabled
      ? this.db.prepare('INSERT INTO chunks_fts (id, file, symbol, text) VALUES (?, ?, ?, ?)')
      : null;
    // These rows are written in the current FTS content format; stamp the
    // version once so backfillFts doesn't think the index is stale.
    if (this.ftsEnabled && !this.ftsStamped) {
      this.setMeta('fts_version', FTS_VERSION);
      this.ftsStamped = true;
    }
    // One transaction for the whole batch — SQLite autocommits per statement
    // otherwise, which means an fsync per chunk and dramatically slower writes
    // during a full index build.
    this.db.exec('BEGIN');
    try {
      for (const c of chunks) {
        stmt.run(
          c.id,
          c.file,
          c.symbol ?? null,
          c.startLine,
          c.endLine,
          c.text,
          c.contentHash,
          Buffer.from(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength),
        );
        if (ftsDel && ftsIns) {
          ftsDel.run(c.id);
          ftsIns.run(c.id, c.file, ftsAugment(c.symbol ?? ''), ftsAugment(c.text));
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Rebuild the FTS index from `chunks` when it's out of sync — either the row
  // counts differ (e.g. an index built before FTS existed, where the virtual
  // table is empty) or the stored FTS content version is stale (an older token
  // format, e.g. before identifier splitting). Reads only text already in
  // `chunks`, so it's a lexical re-index with NO re-embed. Cheap no-op when the
  // index is already current. Only the process holding the index lock (the
  // writer) should call this; a read-only query process leaves it alone.
  backfillFts(): number {
    if (!this.ftsEnabled) return 0;
    const versionOk = this.getMeta('fts_version') === FTS_VERSION;
    const cChunks = (this.db.prepare('SELECT COUNT(*) AS c FROM chunks').get() as { c: number }).c;
    const cFts = (this.db.prepare('SELECT COUNT(*) AS c FROM chunks_fts').get() as { c: number }).c;
    if (versionOk && cChunks === cFts) return 0;

    const rows = this.db.prepare('SELECT id, file, symbol, text FROM chunks').all() as Array<{
      id: string;
      file: string;
      symbol: string | null;
      text: string;
    }>;
    const ins = this.db.prepare('INSERT INTO chunks_fts (id, file, symbol, text) VALUES (?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM chunks_fts');
      for (const r of rows) {
        ins.run(r.id, r.file, ftsAugment(r.symbol ?? ''), ftsAugment(r.text));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.setMeta('fts_version', FTS_VERSION);
    this.ftsStamped = true;
    return cChunks;
  }

  search(queryEmbedding: Float32Array, topK: number): SearchResult[] {
    const rows = this.db.prepare('SELECT * FROM chunks').all() as Array<{
      id: string;
      file: string;
      symbol: string | null;
      startLine: number;
      endLine: number;
      text: string;
      contentHash: string;
      embedding: Uint8Array;
    }>;

    const scored: SearchResult[] = rows.map((row) => ({
      id: row.id,
      file: row.file,
      symbol: row.symbol ?? undefined,
      startLine: row.startLine,
      endLine: row.endLine,
      text: row.text,
      contentHash: row.contentHash,
      score: cosineSimilarity(queryEmbedding, blobToVector(row.embedding)),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  // Lexical (keyword) search over the FTS5 index, ranked by bm25 (best first).
  // Complements vector search on exact identifiers/tokens, which embeddings are
  // weak at. Returns [] if FTS5 is unavailable or the query has no usable terms.
  // The `score` field carries the raw bm25 value (lower = better); callers that
  // fuse with vector results use the RANK, not this magnitude.
  searchText(queryText: string, cap = 50): SearchResult[] {
    if (!this.ftsEnabled) return [];
    const match = toFtsMatch(queryText);
    if (!match) return [];
    let rows: Array<{
      id: string;
      file: string;
      symbol: string | null;
      startLine: number;
      endLine: number;
      text: string;
      contentHash: string;
      bm: number;
    }>;
    try {
      rows = this.db
        .prepare(
          `SELECT c.id, c.file, c.symbol, c.startLine, c.endLine, c.text, c.contentHash,
                  bm25(chunks_fts) AS bm
             FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.id
            WHERE chunks_fts MATCH ?
            ORDER BY bm
            LIMIT ?`,
        )
        .all(match, cap) as typeof rows;
    } catch {
      // A malformed MATCH expression shouldn't take down a search — just skip
      // the lexical arm for this query.
      return [];
    }
    return rows.map((row) => ({
      id: row.id,
      file: row.file,
      symbol: row.symbol ?? undefined,
      startLine: row.startLine,
      endLine: row.endLine,
      text: row.text,
      contentHash: row.contentHash,
      score: row.bm,
    }));
  }

  // Hybrid retrieval: semantic ranking (cosine) with a BOUNDED lexical bonus.
  //
  // We deliberately don't use rank-fusion (RRF) here. RRF lets a strong lexical
  // hit dethrone a strong semantic #1, which regresses natural-language queries
  // — made worse by FTS5's word tokenizer, which indexes `cosineSimilarity` as
  // one token but matches the two-word phrase "cosine similarity" only in prose
  // (docs/comments), not the actual identifier. So a NL query would surface docs
  // over code.
  //
  // Instead each result's cosine score gets a small additive bonus (decaying
  // with FTS rank, capped at LEX_BONUS). Because the bonus is bounded, a clearly
  // stronger semantic hit can never be overtaken; lexical evidence only decides
  // among results whose semantic scores are already close — which is exactly
  // when we want it to. This can't regress a query that pure vector got right;
  // it only promotes exact-token matches within the semantic candidate pool.
  //
  // Returns `score` = cosine + bonus so display order matches the number shown.
  // Degrades to pure vector search when FTS is unavailable. Note: it reorders /
  // promotes within the vector candidate pool but doesn't inject lexical-only
  // hits the vector arm missed entirely — a blind promotion of those (unknown
  // true relevance) is what caused the regressions we're avoiding.
  searchHybrid(direction: Float32Array, queryText: string, topK: number): SearchResult[] {
    const LEX_BONUS = 0.1; // max additive bump for the top lexical hit
    const pool = this.search(direction, Math.max(topK * 8, 64));

    const fts = this.searchText(queryText, Math.max(topK * 4, 50));
    const bonusById = new Map<string, number>();
    // Decay by rank so the strongest lexical hits get the most help: rank 0 ->
    // LEX_BONUS, rank 1 -> LEX_BONUS/2, ...
    fts.forEach((r, i) => bonusById.set(r.id, LEX_BONUS / (1 + i)));

    const fused = pool.map((r) => ({ ...r, score: r.score + (bonusById.get(r.id) ?? 0) }));
    fused.sort((a, b) => b.score - a.score);
    return fused.slice(0, topK);
  }

  // Name-based symbol lookup over the already-indexed chunks (which carry a
  // `symbol` from the LSP bridge / tree-sitter). Case-insensitive substring
  // match; ranking (exact > prefix > substring) is left to the caller. Powers
  // the search_symbol tool — the exact-identifier complement to embedding search.
  searchSymbols(
    query: string,
    cap = 200,
  ): Array<{ id: string; file: string; symbol: string; startLine: number; endLine: number; text: string }> {
    // Escape LIKE wildcards so a symbol fragment is matched literally.
    const escaped = query.replace(/[%_\\]/g, '\\$&');
    const rows = this.db
      .prepare(
        `SELECT id, file, symbol, startLine, endLine, text FROM chunks
         WHERE symbol IS NOT NULL AND symbol LIKE ? ESCAPE '\\' LIMIT ?`,
      )
      .all(`%${escaped}%`, cap) as Array<{
      id: string;
      file: string;
      symbol: string;
      startLine: number;
      endLine: number;
      text: string;
    }>;
    return rows;
  }

  // ---- Call graph (embedding-free) ------------------------------------------

  // Distinct callable symbols in the index — the function/method/class chunks
  // carry a `symbol`, file, and definition line. The call-graph builder asks the
  // language server about each of these. Pass `file` to limit to one file (used
  // by incremental graph updates).
  listCallableSymbols(file?: string): Array<{ file: string; symbol: string; startLine: number }> {
    const sql =
      'SELECT DISTINCT file, symbol, startLine FROM chunks WHERE symbol IS NOT NULL' +
      (file ? ' AND file = ?' : '') +
      ' ORDER BY file, startLine';
    const rows = (file ? this.db.prepare(sql).all(file) : this.db.prepare(sql).all()) as Array<{
      file: string;
      symbol: string;
      startLine: number;
    }>;
    return rows;
  }

  // Insert directed edges, ignoring exact duplicates. Batched in one
  // transaction like chunk writes. `viaFile` on each edge records the file whose
  // symbol produced it, so deleteEdgesByViaFile can wipe a file's contributions.
  upsertEdges(edges: CallEdge[]): void {
    if (edges.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO call_edges
        (fromFile, fromLine, fromName, toFile, toLine, toName, viaFile)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.db.exec('BEGIN');
    try {
      for (const e of edges) {
        stmt.run(e.fromFile, e.fromLine, e.fromName, e.toFile, e.toLine, e.toName, e.viaFile);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // Remove every edge discovered while processing `file`'s symbols. Called
  // before a changed file's edges are refetched, so the graph stays current.
  deleteEdgesByViaFile(file: string): void {
    this.db.prepare('DELETE FROM call_edges WHERE viaFile = ?').run(file);
  }

  // What the symbol at (file, name) calls — its outgoing edges, deduped.
  getCallees(file: string, name: string): CallGraphNode[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT toFile AS file, toLine AS line, toName AS name
           FROM call_edges WHERE fromFile = ? AND fromName = ?`,
      )
      .all(file, name) as Array<{ file: string; line: number; name: string }>;
    return rows;
  }

  // What calls the symbol at (file, name) — its incoming edges, deduped.
  getCallers(file: string, name: string): CallGraphNode[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT fromFile AS file, fromLine AS line, fromName AS name
           FROM call_edges WHERE toFile = ? AND toName = ?`,
      )
      .all(file, name) as Array<{ file: string; line: number; name: string }>;
    return rows;
  }

  getGraphFileHash(file: string): string | null {
    const row = this.db.prepare('SELECT fileHash FROM graph_files WHERE path = ?').get(file) as
      | { fileHash: string }
      | undefined;
    return row?.fileHash ?? null;
  }

  setGraphFileHash(file: string, hash: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO graph_files (path, fileHash) VALUES (?, ?)')
      .run(file, hash);
  }

  deleteGraphFile(file: string): void {
    this.db.prepare('DELETE FROM graph_files WHERE path = ?').run(file);
  }

  // Edge count + how many files have had their edges built — for build-progress
  // logging and to tell whether the graph has been populated at all.
  graphStats(): { edges: number; filesBuilt: number } {
    const edges = (this.db.prepare('SELECT COUNT(*) AS c FROM call_edges').get() as { c: number }).c;
    const filesBuilt = (this.db.prepare('SELECT COUNT(*) AS c FROM graph_files').get() as { c: number }).c;
    return { edges, filesBuilt };
  }

  // ---- Standalone symbols (embedding-free) ----------------------------------

  // Every indexed file (workspace-relative path), so the symbol build can scan
  // each one — unlike the call graph, symbols aren't limited to files that
  // produced callable chunks.
  listIndexedFiles(): string[] {
    const rows = this.db.prepare('SELECT path FROM files ORDER BY path').all() as Array<{
      path: string;
    }>;
    return rows.map((r) => r.path);
  }

  // Replace a file's symbols. Delete-then-insert in one transaction so a rescan
  // leaves no stale rows; INSERT OR IGNORE tolerates duplicate declarations
  // (same name+kind+line) a provider might report.
  upsertSymbols(file: string, symbols: SymbolRow[]): void {
    const del = this.db.prepare('DELETE FROM symbols WHERE file = ?');
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO symbols (file, name, kind, startLine, endLine) VALUES (?, ?, ?, ?, ?)',
    );
    this.db.exec('BEGIN');
    try {
      del.run(file);
      for (const s of symbols) ins.run(file, s.name, s.kind, s.startLine, s.endLine);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  deleteSymbolsByFile(file: string): void {
    this.db.prepare('DELETE FROM symbols WHERE file = ?').run(file);
  }

  // Name-based lookup over the standalone symbols table (all kinds). Case-
  // insensitive substring; LIKE wildcards in the fragment are escaped so it
  // matches literally. Complements searchSymbols (which is chunk/callable-only).
  searchSymbolsTable(
    fragment: string,
    limit = 50,
  ): Array<{ file: string; name: string; kind: string; startLine: number; endLine: number }> {
    const escaped = fragment.replace(/[\\%_]/g, (m) => `\\${m}`);
    const rows = this.db
      .prepare(
        `SELECT file, name, kind, startLine, endLine FROM symbols
           WHERE name LIKE ? ESCAPE '\\' LIMIT ?`,
      )
      .all(`%${escaped}%`, limit) as Array<{
      file: string;
      name: string;
      kind: string;
      startLine: number;
      endLine: number;
    }>;
    return rows;
  }

  getSymbolFileHash(file: string): string | null {
    const row = this.db.prepare('SELECT fileHash FROM symbol_files WHERE path = ?').get(file) as
      | { fileHash: string }
      | undefined;
    return row?.fileHash ?? null;
  }

  setSymbolFileHash(file: string, hash: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO symbol_files (path, fileHash) VALUES (?, ?)')
      .run(file, hash);
  }

  deleteSymbolFile(file: string): void {
    this.db.prepare('DELETE FROM symbol_files WHERE path = ?').run(file);
  }

  // Symbol count + how many files have been scanned — for build progress and to
  // tell whether the symbol table has been populated at all.
  symbolStats(): { symbols: number; filesBuilt: number } {
    const symbols = (this.db.prepare('SELECT COUNT(*) AS c FROM symbols').get() as { c: number }).c;
    const filesBuilt = (this.db.prepare('SELECT COUNT(*) AS c FROM symbol_files').get() as { c: number }).c;
    return { symbols, filesBuilt };
  }

  close(): void {
    this.db.close();
  }
}

// A node in the persisted call graph: a symbol identified by its workspace-
// relative file, definition line, and name.
export interface CallGraphNode {
  file: string;
  line: number;
  name: string;
}

// A declaration in the standalone symbols table (see SYMBOL_SCHEMA). `file` is
// workspace-relative; `kind` is the LSP SymbolKind name (Interface, Enum, …).
export interface SymbolRow {
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

// A directed caller -> callee edge, tagged with the file whose symbol produced
// it (see EDGE_SCHEMA).
export interface CallEdge {
  fromFile: string;
  fromLine: number;
  fromName: string;
  toFile: string;
  toLine: number;
  toName: string;
  viaFile: string;
}

// Common English/question function words carry no lexical signal for code
// search but, OR'd into the MATCH, would let bm25 reward chunks that merely
// repeat them — dethroning the true answer on natural-language queries. Dropped
// so the lexical arm matches on the meaningful terms only.
const FTS_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'and', 'or',
  'is', 'are', 'was', 'were', 'be', 'been', 'do', 'does', 'did', 'has', 'have',
  'this', 'that', 'these', 'those', 'it', 'its', 'as', 'with', 'from', 'into',
  'where', 'what', 'which', 'who', 'whom', 'how', 'why', 'when',
]);

// Bumped whenever the FTS *content* format changes (e.g. adding split-identifier
// tokens). A stored index whose stamp differs is rebuilt from existing chunk
// text on the next writer start — no re-embed, just a lexical re-index.
const FTS_VERSION = '2';

// Split a camelCase / snake_case / kebab-case identifier into its sub-words.
// FTS5's word tokenizer treats `getUserById` as ONE token, so a two-word query
// ("user by id") never matches it. Emitting the sub-words at index (and query)
// time fixes that. Returns [] when the token isn't a compound identifier.
function splitIdentifier(token: string): string[] {
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
function ftsAugment(text: string): string {
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
function toFtsMatch(text: string): string | null {
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

function blobToVector(blob: Uint8Array): Float32Array {
  return new Float32Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}
