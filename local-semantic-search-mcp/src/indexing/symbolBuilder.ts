import { join } from 'node:path';
import type { VectorStore, SymbolRow } from '../storage/store.js';
import { getAllSymbolsViaBridge } from '../chunking/lspBridgeClient.js';

// Builds the standalone symbol index (`symbols`) from the LSP bridge's document
// symbols — ALL declaration kinds, including the non-callable ones (interfaces,
// enums, type aliases, constants, …) that never became chunks. This is
// EMBEDDING-FREE: it reads the language server and writes a metadata table,
// never touching chunks or vectors. It needs the VS Code LSP bridge running;
// with the bridge down it aborts cleanly and reports so. Paths are stored
// workspace-relative, so the table rides inside a shared `index.db`.

export interface SymbolBuildStats {
  files: number; // indexed files to scan
  filesProcessed: number; // files (re)scanned this run
  filesSkipped: number; // files already scanned at the current hash (resumable)
  symbols: number; // symbols written this run
  bridgeDown: boolean; // true if the pass aborted because the bridge wasn't reachable
}

export interface SymbolBuildProgress {
  doneFiles: number;
  totalFiles: number;
  symbols: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How many times to retry a single file whose bridge request comes back null
// before giving up on THAT file — absorbs a language server that's still warming
// up right after a window reload, so one slow request doesn't look like an
// outage.
const FILE_RETRIES = 3;
const RETRY_DELAY_MS = 400;

// Scan and persist symbols for one file. Returns the number written, or null if
// the bridge stayed unreachable across retries. Replaces the file's rows and
// stamps the build marker so the pass is resumable and incremental.
async function buildForFile(
  workspaceRoot: string,
  store: VectorStore,
  relFile: string,
): Promise<number | null> {
  const absFile = join(workspaceRoot, relFile);
  let symbols = await getAllSymbolsViaBridge(workspaceRoot, absFile);
  for (let attempt = 0; symbols === null && attempt < FILE_RETRIES; attempt++) {
    await sleep(RETRY_DELAY_MS);
    symbols = await getAllSymbolsViaBridge(workspaceRoot, absFile);
  }
  if (symbols === null) return null; // still unreachable after retries

  const rows: SymbolRow[] = symbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    startLine: s.startLine,
    endLine: s.endLine,
  }));
  store.upsertSymbols(relFile, rows);
  const idxHash = store.getFileHash(relFile);
  if (idxHash) store.setSymbolFileHash(relFile, idxHash);
  return rows.length;
}

// One-time (resumable) whole-repo build. Skips files already scanned at the
// current index hash, so re-running continues where it left off.
export async function buildSymbols(
  workspaceRoot: string,
  store: VectorStore,
  opts: { onProgress?: (p: SymbolBuildProgress) => void; delayMs?: number } = {},
): Promise<SymbolBuildStats> {
  const delayMs = opts.delayMs ?? 0;
  const files = store.listIndexedFiles();

  const stats: SymbolBuildStats = {
    files: files.length,
    filesProcessed: 0,
    filesSkipped: 0,
    symbols: 0,
    bridgeDown: false,
  };
  // Only conclude the bridge is actually DOWN (vs one flaky/slow file) after
  // several files in a row fail — otherwise skip the file and press on, so a
  // near-complete pass isn't thrown away by a single bad request.
  const CONSECUTIVE_ABORT = 5;
  let consecutiveNull = 0;
  let done = 0;
  for (const relFile of files) {
    done++;
    const idxHash = store.getFileHash(relFile);
    if (idxHash && store.getSymbolFileHash(relFile) === idxHash) {
      stats.filesSkipped++;
      opts.onProgress?.({ doneFiles: done, totalFiles: files.length, symbols: stats.symbols });
      continue;
    }
    const written = await buildForFile(workspaceRoot, store, relFile);
    if (written === null) {
      consecutiveNull++;
      if (consecutiveNull >= CONSECUTIVE_ABORT) {
        stats.bridgeDown = true;
        return stats;
      }
      continue; // skip this file (left unstamped, so a later run retries it)
    }
    consecutiveNull = 0;
    stats.symbols += written;
    stats.filesProcessed++;
    opts.onProgress?.({ doneFiles: done, totalFiles: files.length, symbols: stats.symbols });
    if (delayMs > 0) await sleep(delayMs);
  }
  return stats;
}

// Incremental update for a single file (called from the watcher after a
// re-index). No-ops unless the symbol table has already been built. Returns what
// happened, for optional logging.
export async function updateFileSymbols(
  workspaceRoot: string,
  store: VectorStore,
  relFile: string,
): Promise<'updated' | 'bridge-down' | 'skip'> {
  // Only maintain the table once it exists; don't build it lazily one file at a
  // time (that's what the explicit whole-repo pass is for).
  if (store.symbolStats().filesBuilt === 0) return 'skip';
  const written = await buildForFile(workspaceRoot, store, relFile);
  return written === null ? 'bridge-down' : 'updated';
}
