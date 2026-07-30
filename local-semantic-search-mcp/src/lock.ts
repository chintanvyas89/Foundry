import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';

// File-based single-instance lock, keyed on <workspace>/.swe-search/lock.
// Prevents two MCP server processes from running a full index build against
// the same SQLite store at the same time — the failure mode is doubled
// embedder memory, halved throughput, and racing writes on the shared DB.
//
// Search tools can still run in the loser process (WAL lets it read
// concurrently); only the build + watcher are gated on holding the lock.
export function acquireLock(lockPath: string): boolean {
  // Two attempts: if the first fails with EEXIST but the recorded pid is
  // dead, reclaim the stale file and retry once.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      registerCleanup(lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      if (!isStale(lockPath)) return false;
      try {
        unlinkSync(lockPath);
      } catch {
        // Raced with another reclaimer — fall through and let the retry
        // decide.
      }
    }
  }
  return false;
}

function isStale(lockPath: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(lockPath, 'utf-8').trim());
  } catch {
    return true;
  }
  if (!Number.isFinite(pid) || pid <= 0) return true;
  try {
    // Signal 0 is an existence probe — no signal is delivered.
    process.kill(pid, 0);
    return false;
  } catch (err) {
    // ESRCH: no such process → stale. EPERM: alive but not ours → not stale.
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

let cleanupRegistered = false;
function registerCleanup(lockPath: string): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const release = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone (raced with reclaim, or manually removed) — nothing to do.
    }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      release();
      process.exit(0);
    });
  }
}
