import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeFileArg } from './pathArg.js';
import { outlineWithTreeSitter, supportsTreeSitter, type OutlineSymbol } from '../chunking/treeSitterChunker.js';

// Reads an actual file from the workspace (index-free) so an agent can read the
// EXACT module/file it located — the drill step after semantic_search/searchSymbol
// /architecture_overview identify a named target. This is the capability a
// third-party chat participant otherwise lacks (unlike built-in Copilot, which
// can open files), and it's what lets "how does the <X> module work" be answered
// from real code rather than fuzzy snippets. Local-only; no network, no index.
//
// TWO-PASS to stay token-lean on big files:
//   pass 1  read_file(file)              → an OUTLINE (symbols + line ranges only)
//   pass 2  read_file(file, symbol="fn") → just that symbol's body
// A small file with no args is returned whole; an explicit startLine/endLine reads
// a slice. This avoids dumping a whole large file into the model's context.
const MAX_LINES = 400; // cap a single body/slice read so a huge file can't blow up context

export function registerReadFileTool(server: McpServer, workspaceRoot: string): void {
  server.tool(
    'read_file',
    'Read a workspace file, two-pass to stay token-lean. Call with just `file` to get ' +
      'an OUTLINE first (the file\'s symbols — functions/classes/methods — with line ' +
      'ranges, no bodies); then call again with `symbol="name"` to read just that ' +
      'symbol\'s code, or `startLine`/`endLine` for a specific range. Small files are ' +
      'returned whole. Use this to read the EXACT file/module you located via ' +
      'search_symbol / architecture_overview / a semantic_search hit. Accepts an ' +
      'absolute or workspace-relative path. Reads real source, not the semantic index.',
    {
      file: z
        .string()
        .describe('File to read — absolute or workspace-relative (e.g. "src/storage/store.ts").'),
      symbol: z
        .string()
        .optional()
        .describe('Read just this symbol\'s body (from the outline). Pass this in pass 2.'),
      outline: z
        .boolean()
        .optional()
        .describe('Force outline-only (symbols + line ranges, no bodies), even for a small file.'),
      startLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('1-based first line to read (a specific slice).'),
      endLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('1-based last line to read (inclusive).'),
    },
    async ({ file, symbol, outline, startLine, endLine }) => {
      const { abs, rel } = normalizeFileArg(file, workspaceRoot);

      // Keep reads inside the workspace — refuse path traversal / absolute paths
      // that resolve outside the indexed root.
      if (rel.startsWith('..') || rel === '' || rel.startsWith('/')) {
        return err(`Refusing to read "${file}" — it resolves outside the workspace root.`, 'outside-workspace', file);
      }

      let source: string;
      try {
        source = readFileSync(abs, 'utf8');
      } catch {
        return err(`Could not read ${rel} — file not found or unreadable.`, 'unreadable', rel);
      }
      if (source.includes('\0')) return err(`${rel} looks binary — not reading.`, 'binary', rel);

      const lines = source.split('\n');
      const total = lines.length;
      const ext = extname(rel);
      const canOutline = supportsTreeSitter(ext);

      // ---- pass 2: a specific symbol's body ----------------------------------
      if (symbol && symbol.trim()) {
        if (!canOutline) {
          return err(
            `Can't resolve symbols in ${rel} (no tree-sitter grammar for ${ext || 'this type'}). ` +
              `Read a line range instead (startLine/endLine).`,
            'no-outline',
            rel,
          );
        }
        const syms = await outlineWithTreeSitter(abs, ext);
        const want = symbol.trim();
        const hit =
          syms.find((s) => s.name === want) ??
          syms.find((s) => s.name.toLowerCase() === want.toLowerCase());
        if (!hit) {
          const names = syms.slice(0, 25).map((s) => s.name).join(', ');
          return err(
            `No symbol "${symbol}" in ${rel}.` + (names ? ` Available: ${names}.` : ''),
            'symbol-not-found',
            rel,
          );
        }
        return sliceResult(rel, lines, total, hit.startLine, hit.endLine, `${hit.kind} ${hit.name}`);
      }

      // ---- explicit line range -----------------------------------------------
      if (startLine || endLine) {
        const from = Math.max(1, startLine ?? 1);
        const to = Math.min(endLine ?? from + MAX_LINES - 1, total, from + MAX_LINES - 1);
        return sliceResult(rel, lines, total, from, to);
      }

      // ---- pass 1: outline (explicit, or the default for a large file) -------
      const wantOutline = outline || total > MAX_LINES;
      if (wantOutline && canOutline) {
        const syms = await outlineWithTreeSitter(abs, ext);
        if (syms.length > 0) return outlineResult(rel, total, syms);
        // No symbols parsed (e.g. a config/data file) — fall through to a capped read.
      }

      // ---- whole (small) file, or capped read when no outline available ------
      const to = Math.min(total, MAX_LINES);
      return sliceResult(rel, lines, total, 1, to);
    },
  );
}

function err(text: string, code: string, file: string) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { error: code, file },
  };
}

function outlineResult(rel: string, total: number, syms: OutlineSymbol[]) {
  const lines = syms.map((s) => `  ${s.startLine}-${s.endLine}  ${s.kind} ${s.name}`);
  const text =
    `${rel} — outline (${syms.length} symbols, ${total} lines). ` +
    `Call read_file again with symbol="<name>" for a body, or startLine/endLine for a range.\n` +
    lines.join('\n');
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: {
      file: rel,
      mode: 'outline',
      totalLines: total,
      symbols: syms,
    },
  };
}

function sliceResult(
  rel: string,
  lines: string[],
  total: number,
  from: number,
  to: number,
  label?: string,
) {
  const slice = lines.slice(from - 1, to);
  const truncated = to < total;
  const width = String(to).length;
  const body = slice.map((l, i) => `${String(from + i).padStart(width)}  ${l}`).join('\n');
  const header = `${rel}${label ? ` · ${label}` : ''} (lines ${from}-${to} of ${total})`;
  // A symbol read (label present) is complete by definition — the file continuing
  // past it isn't "truncation". Only nudge for capped range/whole reads.
  const note =
    truncated && !label
      ? `\n\n… ${total - to} more line(s). Request a range (startLine/endLine) or a symbol to read further.`
      : '';
  return {
    content: [{ type: 'text' as const, text: `${header}\n\`\`\`\n${body}\n\`\`\`${note}` }],
    structuredContent: {
      file: rel,
      mode: 'body',
      startLine: from,
      endLine: to,
      totalLines: total,
      truncated,
      content: slice.join('\n'),
    },
  };
}
