import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Chunk } from '../types.js';

// Final fallback tier, always available: fixed-size, line-based windows
// with overlap, for file types neither the LSP bridge nor tree-sitter
// understand (config files, markdown, unsupported languages).
const WINDOW_LINES = 60;
const OVERLAP_LINES = 10;

export function chunkByFixedWindow(filePath: string): Chunk[] {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (/\x00/.test(source)) return []; // Skip binary files (null byte present).

  const lines = source.split('\n');
  if (lines.length === 0 || (lines.length === 1 && !lines[0].trim())) return [];

  const chunks: Chunk[] = [];
  const step = WINDOW_LINES - OVERLAP_LINES;
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + WINDOW_LINES, lines.length);
    const text = lines.slice(start, end).join('\n');
    if (text.trim()) {
      chunks.push({
        file: filePath,
        startLine: start + 1,
        endLine: end,
        text,
        contentHash: createHash('sha1').update(text).digest('hex'),
      });
    }
    if (end === lines.length) break;
  }
  return chunks;
}
