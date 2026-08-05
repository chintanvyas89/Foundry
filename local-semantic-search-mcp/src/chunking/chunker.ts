import { extname } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getSymbolsViaBridge } from './lspBridgeClient.js';
import { chunkWithTreeSitter, supportsTreeSitter } from './treeSitterChunker.js';
import { chunkByFixedWindow } from './fallbackChunker.js';
import { isConfigFile } from '../config-index/registry.js';
import type { Chunk } from '../types.js';

// Symbol kinds worth chunking on. Deliberately excludes variables,
// properties, etc. — matches the granularity the tree-sitter chunker uses.
const CHUNK_SYMBOL_KINDS = new Set(['Function', 'Method', 'Class', 'Constructor']);

/**
 * Three-tier chunking, richest source first:
 *   1. The companion LSP-bridge extension, when installed and running —
 *      real language-server symbol data, the same the editor's outline uses.
 *   2. tree-sitter, when the bridge isn't available (extension not
 *      installed, no workspace open, or the request timed out/failed).
 *   3. Fixed-window chunking, always available, for anything else.
 * Each tier is a soft fallback, not an error path — the bridge is an
 * optional enhancement, never a hard dependency of this server.
 */
export async function chunkFile(filePath: string, workspaceRoot: string): Promise<Chunk[]> {
  // Structured config (YAML) is NEVER embedded — it's handled by the separate,
  // embedding-free config index. Return no chunks so it can't enter the vector
  // store even if something calls the chunker on it directly.
  if (isConfigFile(filePath)) return [];

  const bridgeSymbols = await getSymbolsViaBridge(workspaceRoot, filePath);
  if (bridgeSymbols && bridgeSymbols.length > 0) {
    const chunks = chunksFromBridgeSymbols(filePath, bridgeSymbols);
    if (chunks.length > 0) return chunks;
  }

  const ext = extname(filePath);
  if (supportsTreeSitter(ext)) {
    const chunks = await chunkWithTreeSitter(filePath, ext);
    if (chunks.length > 0) return chunks;
  }

  return chunkByFixedWindow(filePath);
}

function chunksFromBridgeSymbols(
  filePath: string,
  symbols: Array<{ name: string; kind: string; startLine: number; endLine: number }>,
): Chunk[] {
  const source = readFileSync(filePath, 'utf-8');
  const lines = source.split('\n');
  const chunks: Chunk[] = [];

  for (const sym of symbols) {
    if (!CHUNK_SYMBOL_KINDS.has(sym.kind)) continue;
    const text = lines.slice(sym.startLine - 1, sym.endLine).join('\n');
    if (!text.trim()) continue;
    chunks.push({
      file: filePath,
      symbol: sym.name,
      startLine: sym.startLine,
      endLine: sym.endLine,
      text,
      contentHash: createHash('sha1').update(text).digest('hex'),
    });
  }
  return chunks;
}
