import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildIgnoreMatcher, isIgnored, type Ignore } from '../ignore/ignoreMatcher.js';
import { chunkFile } from '../chunking/chunker.js';
import { embedBatch } from '../embedding/embedder.js';
import { VectorStore } from '../storage/store.js';
import type { IndexedChunk } from '../types.js';

export interface IndexFileResult {
  total: number; // chunks the file has in the index after this call
  embedded: number; // chunks that actually had to be embedded
  skipped: boolean; // file unchanged since last run — no work done
}

export interface BuildStats {
  files: number;
  chunks: number;
  embedded: number; // chunks embedded this run
  skippedFiles: number; // files unchanged since last run
}

export interface BuildProgress {
  done: number; // files processed so far
  total: number; // total files to process
  chunks: number; // chunks in the index so far
  embedded: number; // chunks embedded so far this run
  skippedFiles: number; // files skipped as unchanged so far
}

export class Indexer {
  constructor(
    private workspaceRoot: string,
    private store: VectorStore,
  ) {}

  // onProgress is called once before the loop (done=0, so the total is known
  // immediately) and after each file. The caller decides how often to actually
  // log — reporting every file keeps the indexer decoupled from output policy.
  async buildFull(onProgress?: (p: BuildProgress) => void): Promise<BuildStats> {
    const ig = buildIgnoreMatcher(this.workspaceRoot);
    const files = this.walk(this.workspaceRoot, ig);
    const total = files.length;
    const stats: BuildStats = { files: total, chunks: 0, embedded: 0, skippedFiles: 0 };
    onProgress?.({ done: 0, total, chunks: 0, embedded: 0, skippedFiles: 0 });
    for (let i = 0; i < total; i++) {
      const r = await this.indexFile(files[i]);
      stats.chunks += r.total;
      stats.embedded += r.embedded;
      if (r.skipped) stats.skippedFiles++;
      onProgress?.({
        done: i + 1,
        total,
        chunks: stats.chunks,
        embedded: stats.embedded,
        skippedFiles: stats.skippedFiles,
      });
    }
    return stats;
  }

  // Re-indexes one file, doing as little work as possible:
  //   - If the file's content hash matches what we stored last time, skip it
  //     entirely (this is what makes a restart cheap — unchanged files cost
  //     nothing beyond a read + hash).
  //   - Otherwise re-chunk, but reuse the stored embedding for any chunk whose
  //     text is unchanged (by contentHash), and only embed the genuinely new
  //     or changed chunks — batched, in one pass.
  async indexFile(absPath: string): Promise<IndexFileResult> {
    let content: Buffer;
    try {
      content = readFileSync(absPath);
    } catch {
      return { total: 0, embedded: 0, skipped: false }; // unreadable (e.g. removed mid-walk)
    }
    const fileHash = createHash('sha1').update(content).digest('hex');

    if (this.store.getFileHash(absPath) === fileHash) {
      return { total: this.store.countByFile(absPath), embedded: 0, skipped: true };
    }

    const chunks = await chunkFile(absPath, this.workspaceRoot);
    if (chunks.length === 0) {
      this.store.deleteByFile(absPath);
      this.store.setFileHash(absPath, fileHash);
      return { total: 0, embedded: 0, skipped: false };
    }

    // Reuse embeddings for chunks whose text is unchanged; collect the rest to
    // embed in one batched call.
    const existing = this.store.getEmbeddingsByFile(absPath);
    const indexed: IndexedChunk[] = new Array(chunks.length);
    const toEmbed: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const id = `${c.file}:${c.startLine}:${c.endLine}`;
      const reused = existing.get(c.contentHash);
      if (reused) {
        indexed[i] = { ...c, id, embedding: reused };
      } else {
        toEmbed.push(i);
      }
    }

    if (toEmbed.length > 0) {
      const embeddings = await embedBatch(toEmbed.map((i) => chunks[i].text));
      for (let j = 0; j < toEmbed.length; j++) {
        const i = toEmbed[j];
        const c = chunks[i];
        indexed[i] = { ...c, id: `${c.file}:${c.startLine}:${c.endLine}`, embedding: embeddings[j] };
      }
    }

    this.store.deleteByFile(absPath);
    this.store.upsertChunks(indexed);
    this.store.setFileHash(absPath, fileHash);
    return { total: indexed.length, embedded: toEmbed.length, skipped: false };
  }

  removeFile(absPath: string): void {
    this.store.deleteByFile(absPath);
    this.store.deleteFileHash(absPath);
  }

  private walk(dir: string, ig: Ignore): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (isIgnored(ig, this.workspaceRoot, full)) continue;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...this.walk(full, ig));
      } else if (stat.isFile()) {
        results.push(full);
      }
    }
    return results;
  }
}
