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
`;

// Brute-force cosine similarity over Float32Array BLOBs, per §3 — this
// server targets tens of thousands of chunks per repo, not millions;
// revisit only if sqlite-vec becomes warranted.
export class VectorStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
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
      file: string;
      symbol: string | null;
      startLine: number;
      endLine: number;
      text: string;
      contentHash: string;
      embedding: Uint8Array;
    }>;

    const scored: SearchResult[] = rows.map((row) => ({
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
