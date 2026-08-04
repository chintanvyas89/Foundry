import { join, relative, sep } from 'node:path';
import type { VectorStore, SymbolRef } from '../storage/store.js';
import { getReferencesViaBridge } from '../chunking/lspBridgeClient.js';

// Builds the persisted usages/references index (`symbol_refs`) from the LSP
// bridge's reference provider. EMBEDDING-FREE — it reads the language server and
// writes a metadata table, never touching chunks or vectors. Iterates the
// standalone symbols table (so it covers all declaration kinds), so it needs
// that table built first (SWE_BUILD_SYMBOLS). Paths are workspace-relative;
// references outside the workspace are dropped, so the result is shareable and
// works offline for teammates.

export interface UsageBuildStats {
  files: number; // files with declarations to scan
  filesProcessed: number; // files whose refs we (re)built this run
  filesSkipped: number; // files already built (resumable)
  refs: number; // references written this run
  bridgeDown: boolean; // aborted because the bridge stayed unreachable
  noSymbols: boolean; // the symbols table hasn't been built yet
}

export interface UsageBuildProgress {
  doneFiles: number;
  totalFiles: number;
  refs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Absorb a language server that's still warming up: retry a null request a few
// times before giving up on the symbol.
const RETRIES = 3;
const RETRY_DELAY_MS = 400;

function toRel(workspaceRoot: string, abs: string): string {
  return relative(workspaceRoot, abs).split(sep).join('/');
}

function isExternal(rel: string): boolean {
  return rel === '' || rel.startsWith('..') || rel.startsWith('/');
}

// Fetch and persist references for one file's declarations. Returns the number
// of refs written, or null if the bridge stayed unreachable (caller decides
// whether that's a transient blip or a real outage). Commits per file (wipe old
// viaFile rows, insert fresh, stamp the marker) so the pass is resumable.
async function buildForFile(
  workspaceRoot: string,
  store: VectorStore,
  relFile: string,
  symbols: Array<{ name: string; startLine: number }>,
): Promise<number | null> {
  const absFile = join(workspaceRoot, relFile);
  const rows: SymbolRef[] = [];

  for (const s of symbols) {
    let refs = await getReferencesViaBridge(workspaceRoot, absFile, s.startLine, s.name);
    for (let attempt = 0; refs === null && attempt < RETRIES; attempt++) {
      await sleep(RETRY_DELAY_MS);
      refs = await getReferencesViaBridge(workspaceRoot, absFile, s.startLine, s.name);
    }
    if (refs === null) return null; // still unreachable after retries

    for (const r of refs) {
      const refRel = toRel(workspaceRoot, r.file);
      if (isExternal(refRel)) continue;
      rows.push({
        defFile: relFile,
        defName: s.name,
        refFile: refRel,
        refLine: r.line,
        refText: (r.text ?? '').trim().slice(0, 200),
        viaFile: relFile,
      });
    }
  }

  store.deleteRefsByViaFile(relFile);
  store.upsertRefs(rows);
  const idxHash = store.getFileHash(relFile);
  if (idxHash) store.setUsageFileHash(relFile, idxHash);
  return rows.length;
}

// One-time (resumable) whole-repo build. Skips files already built at the
// current index hash, so re-running continues where it left off.
export async function buildUsages(
  workspaceRoot: string,
  store: VectorStore,
  opts: { onProgress?: (p: UsageBuildProgress) => void; delayMs?: number } = {},
): Promise<UsageBuildStats> {
  const delayMs = opts.delayMs ?? 0;
  const symbols = store.listSymbols();
  const byFile = new Map<string, Array<{ name: string; startLine: number }>>();
  for (const s of symbols) {
    const list = byFile.get(s.file) ?? [];
    list.push({ name: s.name, startLine: s.startLine });
    byFile.set(s.file, list);
  }

  const stats: UsageBuildStats = {
    files: byFile.size,
    filesProcessed: 0,
    filesSkipped: 0,
    refs: 0,
    bridgeDown: false,
    noSymbols: byFile.size === 0,
  };
  if (stats.noSymbols) return stats;

  // Only declare the bridge down after several files in a row fail — otherwise
  // skip the file and continue, so one flaky request doesn't discard the run.
  const CONSECUTIVE_ABORT = 5;
  let consecutiveNull = 0;
  let done = 0;
  for (const [relFile, syms] of byFile) {
    done++;
    const idxHash = store.getFileHash(relFile);
    if (idxHash && store.getUsageFileHash(relFile) === idxHash) {
      stats.filesSkipped++;
      opts.onProgress?.({ doneFiles: done, totalFiles: byFile.size, refs: stats.refs });
      continue;
    }
    const written = await buildForFile(workspaceRoot, store, relFile, syms);
    if (written === null) {
      consecutiveNull++;
      if (consecutiveNull >= CONSECUTIVE_ABORT) {
        stats.bridgeDown = true;
        return stats;
      }
      continue; // skip (left unstamped, retried on the next run)
    }
    consecutiveNull = 0;
    stats.refs += written;
    stats.filesProcessed++;
    opts.onProgress?.({ doneFiles: done, totalFiles: byFile.size, refs: stats.refs });
    if (delayMs > 0) await sleep(delayMs);
  }
  return stats;
}

// Incremental update for a single file (called from the watcher after a
// re-index). No-ops unless usages have already been built. Returns what
// happened, for optional logging.
export async function updateFileUsages(
  workspaceRoot: string,
  store: VectorStore,
  relFile: string,
): Promise<'updated' | 'bridge-down' | 'skip'> {
  if (store.usageStats().filesBuilt === 0) return 'skip';
  const syms = store.listSymbols(relFile).map((s) => ({ name: s.name, startLine: s.startLine }));
  if (syms.length === 0) {
    store.deleteRefsByViaFile(relFile);
    store.deleteUsageFile(relFile);
    return 'skip';
  }
  const written = await buildForFile(workspaceRoot, store, relFile, syms);
  return written === null ? 'bridge-down' : 'updated';
}
