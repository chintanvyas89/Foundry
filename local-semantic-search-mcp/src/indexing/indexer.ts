import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
  prunedFiles: number; // stale files removed (deleted / newly ignored)
}

export interface BuildProgress {
  done: number; // files processed so far
  total: number; // total files to process
  chunks: number; // chunks in the index so far
  embedded: number; // chunks embedded so far this run
  skippedFiles: number; // files skipped as unchanged so far
}

export interface BuildOptions {
  onProgress?: (p: BuildProgress) => void;
  lazy?: boolean; // open search after the hot set instead of the whole repo
  hotSet?: number; // files to embed before firing onSearchable (lazy only)
  onSearchable?: () => void; // fired once search can return useful results
}

export class Indexer {
  constructor(
    private workspaceRoot: string,
    private store: VectorStore,
    private excludePatterns: string[] = [],
  ) {}

  // Workspace-relative, forward-slash path — the key everything is stored under,
  // so the index is portable across machines/checkouts (see store.ts).
  private toRel(absPath: string): string {
    return relative(this.workspaceRoot, absPath).split(sep).join('/');
  }

  // onProgress is called once before the loop (done=0, so the total is known
  // immediately) and after each file. The caller decides how often to actually
  // log — reporting every file keeps the indexer decoupled from output policy.
  //
  // Lazy indexing: files are embedded most-recently-modified first (the hot set),
  // and `onSearchable` fires once the first `hotSet` files are done so the caller
  // can open search while the rest streams in. When `lazy` is false, `onSearchable`
  // fires only after the whole workspace is embedded (block-until-complete).
  async buildFull(opts: BuildOptions = {}): Promise<BuildStats> {
    const { onProgress, lazy = false, hotSet = 64, onSearchable } = opts;
    const ig = buildIgnoreMatcher(this.workspaceRoot, this.excludePatterns);
    // Most-recently-modified first, so the developer's active area indexes first.
    const files = this.walk(this.workspaceRoot, ig)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((f) => f.path);
    const total = files.length;
    const stats: BuildStats = {
      files: total,
      chunks: 0,
      embedded: 0,
      skippedFiles: 0,
      prunedFiles: 0,
    };
    const seen = new Set<string>();
    let searchableFired = false;
    const fireSearchable = (): void => {
      if (!searchableFired) {
        searchableFired = true;
        onSearchable?.();
      }
    };

    onProgress?.({ done: 0, total, chunks: 0, embedded: 0, skippedFiles: 0 });
    const hotCount = Math.min(hotSet, total);
    for (let i = 0; i < total; i++) {
      seen.add(this.toRel(files[i]));
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
      if (lazy && i + 1 >= hotCount) fireSearchable();
    }
    // Non-lazy (or empty repo): search opens only now, once everything is done.
    fireSearchable();
    // Remove index entries for files that no longer exist / are now ignored.
    // Runs at the end of a full walk, when `seen` is the authoritative set of
    // files currently in the workspace.
    stats.prunedFiles = this.store.pruneMissing(seen);
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
    const relPath = this.toRel(absPath);

    if (this.store.getFileHash(relPath) === fileHash) {
      return { total: this.store.countByFile(relPath), embedded: 0, skipped: true };
    }

    const chunks = await chunkFile(absPath, this.workspaceRoot);
    if (chunks.length === 0) {
      this.store.deleteByFile(relPath);
      this.store.setFileHash(relPath, fileHash);
      return { total: 0, embedded: 0, skipped: false };
    }

    // Reuse embeddings for chunks whose text is unchanged; collect the rest to
    // embed in one batched call. Paths are relativized here, at the storage
    // boundary — chunkers still work in absolute paths to read files.
    const existing = this.store.getEmbeddingsByFile(relPath);
    const indexed: IndexedChunk[] = new Array(chunks.length);
    const toEmbed: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const id = `${relPath}:${c.startLine}:${c.endLine}`;
      const reused = existing.get(c.contentHash);
      if (reused) {
        indexed[i] = { ...c, file: relPath, id, embedding: reused };
      } else {
        toEmbed.push(i);
      }
    }

    if (toEmbed.length > 0) {
      // All indexer embedding is background work — 'low' priority so a live
      // search query's embed always jumps ahead of the build.
      const embeddings = await embedBatch(
        toEmbed.map((i) => chunks[i].text),
        { priority: 'low' },
      );
      for (let j = 0; j < toEmbed.length; j++) {
        const i = toEmbed[j];
        const c = chunks[i];
        indexed[i] = {
          ...c,
          file: relPath,
          id: `${relPath}:${c.startLine}:${c.endLine}`,
          embedding: embeddings[j],
        };
      }
    }

    this.store.deleteByFile(relPath);
    this.store.upsertChunks(indexed);
    this.store.setFileHash(relPath, fileHash);
    return { total: indexed.length, embedded: toEmbed.length, skipped: false };
  }

  removeFile(absPath: string): void {
    const relPath = this.toRel(absPath);
    this.store.deleteByFile(relPath);
    this.store.deleteFileHash(relPath);
  }

  private walk(dir: string, ig: Ignore): Array<{ path: string; mtimeMs: number }> {
    const results: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (isIgnored(ig, this.workspaceRoot, full)) continue;
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...this.walk(full, ig));
      } else if (stat.isFile()) {
        results.push({ path: full, mtimeMs: stat.mtimeMs });
      }
    }
    return results;
  }
}
