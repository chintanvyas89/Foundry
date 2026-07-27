import chokidar, { type FSWatcher } from 'chokidar';
import { buildIgnoreMatcher, isIgnored } from '../ignore/ignoreMatcher.js';
import type { Indexer } from './indexer.js';

const DEBOUNCE_MS = 300; // collapse editor save-storms into one re-index
const MAX_CONCURRENT = 4; // cap parallel re-indexes (e.g. a git checkout burst)

// Serializes and paces re-indexing driven by file events. Guarantees:
//   - a file is debounced, so rapid saves cause one re-index, not many;
//   - a file is never indexed by two tasks at once (no delete/upsert races) —
//     if it changes again mid-index, it's re-queued once and re-run after;
//   - at most MAX_CONCURRENT files index in parallel, so a large batch change
//     doesn't spawn hundreds of competing embed jobs.
class IndexQueue {
  private debounceTimers = new Map<string, NodeJS.Timeout>();
  private pending: string[] = [];
  private pendingSet = new Set<string>();
  private inflight = new Set<string>();
  private dirty = new Set<string>();
  private active = 0;

  constructor(
    private indexer: Indexer,
    private concurrency = MAX_CONCURRENT,
    private debounceMs = DEBOUNCE_MS,
  ) {}

  change(path: string): void {
    const existing = this.debounceTimers.get(path);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      path,
      setTimeout(() => {
        this.debounceTimers.delete(path);
        this.enqueue(path);
      }, this.debounceMs),
    );
  }

  remove(path: string): void {
    const timer = this.debounceTimers.get(path);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(path);
    }
    // Deletion is a cheap synchronous DB op; no need to queue it.
    this.indexer.removeFile(path);
  }

  private enqueue(path: string): void {
    if (this.inflight.has(path)) {
      // Changed again while we're indexing it — mark for a re-run afterward.
      this.dirty.add(path);
      return;
    }
    if (!this.pendingSet.has(path)) {
      this.pendingSet.add(path);
      this.pending.push(path);
    }
    this.drain();
  }

  private drain(): void {
    while (this.active < this.concurrency && this.pending.length > 0) {
      const path = this.pending.shift()!;
      this.pendingSet.delete(path);
      this.inflight.add(path);
      this.active++;
      void this.indexer
        .indexFile(path)
        .catch((err) => console.error(`[watcher] failed to index ${path}:`, err))
        .finally(() => {
          this.active--;
          this.inflight.delete(path);
          if (this.dirty.delete(path)) this.enqueue(path); // re-run for a change that arrived mid-index
          this.drain();
        });
    }
  }
}

// Runs continuously after the initial full build (§5.3): re-indexes only the
// files that change, no periodic full rescans.
export function startWatcher(workspaceRoot: string, indexer: Indexer): FSWatcher {
  const ig = buildIgnoreMatcher(workspaceRoot);
  const queue = new IndexQueue(indexer);

  const watcher = chokidar.watch(workspaceRoot, {
    ignoreInitial: true,
    ignored: (path: string) => isIgnored(ig, workspaceRoot, path),
  });

  watcher
    .on('add', (path) => queue.change(path))
    .on('change', (path) => queue.change(path))
    .on('unlink', (path) => queue.remove(path))
    .on('error', (err) => console.error('[watcher] error:', err));

  return watcher;
}
