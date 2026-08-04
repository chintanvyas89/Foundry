import { join, relative, sep } from 'node:path';
import type { VectorStore, CallEdge } from '../storage/store.js';
import { getCallHierarchyViaBridge } from '../chunking/lspBridgeClient.js';

// Builds the persisted call graph (`call_edges`) from the LSP bridge's
// call-hierarchy data. This is EMBEDDING-FREE — it reuses the already-indexed
// symbols and never touches vectors. It needs the VS Code LSP bridge running
// (a live language server); with the bridge down it aborts cleanly and reports
// so. Paths are stored workspace-relative and edges to files outside the
// workspace are dropped, so the resulting graph is portable/shareable exactly
// like the vector index — a teammate can use it offline with no bridge.

export interface GraphBuildStats {
  files: number; // files with callable symbols
  filesProcessed: number; // files whose edges we (re)built this run
  filesSkipped: number; // files already built (resumable)
  edges: number; // edges written this run
  bridgeDown: boolean; // true if the pass aborted because the bridge wasn't reachable
}

export interface GraphBuildProgress {
  doneFiles: number;
  totalFiles: number;
  edges: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toRel(workspaceRoot: string, abs: string): string {
  return relative(workspaceRoot, abs).split(sep).join('/');
}

// A relativized path that escapes the workspace (dependency, stdlib) — excluded
// so the shared graph stays internal and portable.
function isExternal(rel: string): boolean {
  return rel === '' || rel.startsWith('..') || rel.startsWith('/');
}

// Fetch and persist edges for one file's symbols. Returns the number of edges
// written, or null if the bridge was unreachable (caller should stop). Commits
// per file (wipe old viaFile edges, insert fresh, stamp the build marker) so the
// pass is resumable and incremental.
async function buildForFile(
  workspaceRoot: string,
  store: VectorStore,
  relFile: string,
  symbols: Array<{ symbol: string; startLine: number }>,
  delayMs: number,
): Promise<number | null> {
  const absFile = join(workspaceRoot, relFile);
  const edges: CallEdge[] = [];

  for (const s of symbols) {
    const calls = await getCallHierarchyViaBridge(workspaceRoot, absFile, s.startLine, s.symbol);
    if (calls === null) return null; // bridge not reachable — abort the pass
    if (!calls.root) continue; // no call hierarchy for this position

    const rootRel = toRel(workspaceRoot, calls.root.file);
    if (isExternal(rootRel)) continue;
    const root = { file: rootRel, line: calls.root.line, name: calls.root.name };

    for (const o of calls.outgoing) {
      const oRel = toRel(workspaceRoot, o.file);
      if (isExternal(oRel)) continue;
      edges.push({
        fromFile: root.file, fromLine: root.line, fromName: root.name,
        toFile: oRel, toLine: o.line, toName: o.name,
        viaFile: relFile,
      });
    }
    for (const i of calls.incoming) {
      const iRel = toRel(workspaceRoot, i.file);
      if (isExternal(iRel)) continue;
      edges.push({
        fromFile: iRel, fromLine: i.line, fromName: i.name,
        toFile: root.file, toLine: root.line, toName: root.name,
        viaFile: relFile,
      });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  // Replace this file's contribution atomically, then stamp it as built at the
  // current index hash so a restart skips it and a later edit refetches it.
  store.deleteEdgesByViaFile(relFile);
  store.upsertEdges(edges);
  const idxHash = store.getFileHash(relFile);
  if (idxHash) store.setGraphFileHash(relFile, idxHash);
  return edges.length;
}

// One-time (resumable) whole-repo build. Skips files already built at the
// current index hash, so re-running continues where it left off.
export async function buildCallGraph(
  workspaceRoot: string,
  store: VectorStore,
  opts: { onProgress?: (p: GraphBuildProgress) => void; delayMs?: number } = {},
): Promise<GraphBuildStats> {
  const delayMs = opts.delayMs ?? 0;
  const symbols = store.listCallableSymbols();
  const byFile = new Map<string, Array<{ symbol: string; startLine: number }>>();
  for (const s of symbols) {
    const list = byFile.get(s.file) ?? [];
    list.push({ symbol: s.symbol, startLine: s.startLine });
    byFile.set(s.file, list);
  }

  const stats: GraphBuildStats = {
    files: byFile.size,
    filesProcessed: 0,
    filesSkipped: 0,
    edges: 0,
    bridgeDown: false,
  };
  let done = 0;
  for (const [relFile, syms] of byFile) {
    done++;
    const idxHash = store.getFileHash(relFile);
    if (idxHash && store.getGraphFileHash(relFile) === idxHash) {
      stats.filesSkipped++;
      opts.onProgress?.({ doneFiles: done, totalFiles: byFile.size, edges: stats.edges });
      continue;
    }
    const written = await buildForFile(workspaceRoot, store, relFile, syms, delayMs);
    if (written === null) {
      stats.bridgeDown = true;
      return stats;
    }
    stats.edges += written;
    stats.filesProcessed++;
    opts.onProgress?.({ doneFiles: done, totalFiles: byFile.size, edges: stats.edges });
  }
  return stats;
}

// Incremental update for a single file (called from the watcher after a
// re-index). No-ops unless the graph has already been built. Returns what
// happened, for optional logging.
export async function updateFileGraph(
  workspaceRoot: string,
  store: VectorStore,
  relFile: string,
): Promise<'updated' | 'bridge-down' | 'skip'> {
  // Only maintain the graph once it exists; don't build it lazily one file at a
  // time (that's what the explicit whole-repo pass is for).
  if (store.graphStats().filesBuilt === 0) return 'skip';

  const syms = store.listCallableSymbols(relFile).map((s) => ({ symbol: s.symbol, startLine: s.startLine }));
  if (syms.length === 0) {
    store.deleteEdgesByViaFile(relFile);
    store.deleteGraphFile(relFile);
    return 'skip';
  }
  const written = await buildForFile(workspaceRoot, store, relFile, syms, 0);
  return written === null ? 'bridge-down' : 'updated';
}
