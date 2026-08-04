import { join, relative, sep } from 'node:path';
import type { VectorStore, SymbolImpl } from '../storage/store.js';
import { getImplementationsViaBridge } from '../chunking/lspBridgeClient.js';

// Builds the persisted implementations index (`symbol_impls`) from the LSP
// bridge's implementation provider. EMBEDDING-FREE. Iterates the standalone
// symbols table (so it covers interfaces/abstract members regardless of kind),
// so it needs that table built first (SWE_BUILD_SYMBOLS). Most symbols have no
// implementations (concrete code) and simply produce no rows. Paths are stored
// workspace-relative, so the result is shareable and works offline.

export interface ImplBuildStats {
  files: number;
  filesProcessed: number;
  filesSkipped: number;
  impls: number;
  bridgeDown: boolean;
  noSymbols: boolean;
}

export interface ImplBuildProgress {
  doneFiles: number;
  totalFiles: number;
  impls: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RETRIES = 3;
const RETRY_DELAY_MS = 400;

function toRel(workspaceRoot: string, abs: string): string {
  return relative(workspaceRoot, abs).split(sep).join('/');
}
function isExternal(rel: string): boolean {
  return rel === '' || rel.startsWith('..') || rel.startsWith('/');
}

async function buildForFile(
  workspaceRoot: string,
  store: VectorStore,
  relFile: string,
  symbols: Array<{ name: string; startLine: number }>,
): Promise<number | null> {
  const absFile = join(workspaceRoot, relFile);
  const rows: SymbolImpl[] = [];

  for (const s of symbols) {
    let impls = await getImplementationsViaBridge(workspaceRoot, absFile, s.startLine, s.name);
    for (let attempt = 0; impls === null && attempt < RETRIES; attempt++) {
      await sleep(RETRY_DELAY_MS);
      impls = await getImplementationsViaBridge(workspaceRoot, absFile, s.startLine, s.name);
    }
    if (impls === null) return null; // still unreachable after retries

    for (const i of impls) {
      const implRel = toRel(workspaceRoot, i.file);
      if (isExternal(implRel)) continue;
      rows.push({
        defFile: relFile,
        defName: s.name,
        implFile: implRel,
        implLine: i.line,
        implText: (i.text ?? '').trim().slice(0, 200),
        viaFile: relFile,
      });
    }
  }

  store.deleteImplsByViaFile(relFile);
  store.upsertImpls(rows);
  const idxHash = store.getFileHash(relFile);
  if (idxHash) store.setImplFileHash(relFile, idxHash);
  return rows.length;
}

export async function buildImpls(
  workspaceRoot: string,
  store: VectorStore,
  opts: { onProgress?: (p: ImplBuildProgress) => void; delayMs?: number } = {},
): Promise<ImplBuildStats> {
  const delayMs = opts.delayMs ?? 0;
  const symbols = store.listSymbols();
  const byFile = new Map<string, Array<{ name: string; startLine: number }>>();
  for (const s of symbols) {
    const list = byFile.get(s.file) ?? [];
    list.push({ name: s.name, startLine: s.startLine });
    byFile.set(s.file, list);
  }

  const stats: ImplBuildStats = {
    files: byFile.size,
    filesProcessed: 0,
    filesSkipped: 0,
    impls: 0,
    bridgeDown: false,
    noSymbols: byFile.size === 0,
  };
  if (stats.noSymbols) return stats;

  const CONSECUTIVE_ABORT = 5;
  let consecutiveNull = 0;
  let done = 0;
  for (const [relFile, syms] of byFile) {
    done++;
    const idxHash = store.getFileHash(relFile);
    if (idxHash && store.getImplFileHash(relFile) === idxHash) {
      stats.filesSkipped++;
      opts.onProgress?.({ doneFiles: done, totalFiles: byFile.size, impls: stats.impls });
      continue;
    }
    const written = await buildForFile(workspaceRoot, store, relFile, syms);
    if (written === null) {
      consecutiveNull++;
      if (consecutiveNull >= CONSECUTIVE_ABORT) {
        stats.bridgeDown = true;
        return stats;
      }
      continue;
    }
    consecutiveNull = 0;
    stats.impls += written;
    stats.filesProcessed++;
    opts.onProgress?.({ doneFiles: done, totalFiles: byFile.size, impls: stats.impls });
    if (delayMs > 0) await sleep(delayMs);
  }
  return stats;
}

export async function updateFileImpls(
  workspaceRoot: string,
  store: VectorStore,
  relFile: string,
): Promise<'updated' | 'bridge-down' | 'skip'> {
  if (store.implStats().filesBuilt === 0) return 'skip';
  const syms = store.listSymbols(relFile).map((s) => ({ name: s.name, startLine: s.startLine }));
  if (syms.length === 0) {
    store.deleteImplsByViaFile(relFile);
    store.deleteImplFile(relFile);
    return 'skip';
  }
  const written = await buildForFile(workspaceRoot, store, relFile, syms);
  return written === null ? 'bridge-down' : 'updated';
}
