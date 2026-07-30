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

// Paths in `chunks.file` / `chunks.id` / `files.path` are stored RELATIVE to
// the workspace root (forward-slash separated). That keeps the index portable
// between machines/checkouts, so it can be shared without every dev re-indexing.
// The indexer relativizes on write; search resolves back to absolute for display.

// Brute-force cosine similarity over Float32Array BLOBs, per §3 — this
// server targets tens of thousands of chunks per repo, not millions;
// revisit only if sqlite-vec becomes warranted.
export class VectorStore {
  private db: DatabaseSync;

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
  }

  deleteByFile(file: string): void {
    this.db.prepare('DELETE FROM chunks WHERE file = ?').run(file);
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
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
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

  close(): void {
    this.db.close();
  }
}

function blobToVector(blob: Uint8Array): Float32Array {
  return new Float32Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}
