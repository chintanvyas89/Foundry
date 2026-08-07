import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeFileArg } from './pathArg.js';
import { outlineWithTreeSitter, supportsTreeSitter, type OutlineSymbol } from '../chunking/treeSitterChunker.js';
import { isConfigExtension } from '../config-index/settings.js';
import { detectStandards } from '../standards/registry.js';
import { resolveFqcn, looksLikeFqcn } from '../standards/resolve.js';
import { resolveSymbolViaBridge } from '../chunking/lspBridgeClient.js';

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
      'absolute or workspace-relative path. Reads real source, not the semantic index. ' +
      'STRUCTURED CONFIG (.yml/.json/...) has no symbols/outline — for a big config ' +
      'file, prefer search_config for a compact id/type/label summary over reading it ' +
      'whole; `symbol=` is a no-op for these and will just error.',
    {
      file: z
        .string()
        .describe(
          'File to read — absolute or workspace-relative (e.g. "src/storage/store.ts"), ' +
            'OR a fully-qualified/namespaced class name (e.g. "Acme\\Module\\Entity\\Foo"), ' +
            'which is resolved to its file via the language server / the project\'s detected PSR-4 map.',
        ),
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
      // A fully-qualified class name is resolved to its file (LSP first, then the
      // PSR-4 map); a normal path is used as-is.
      const target = await resolveReadTarget(file, workspaceRoot);
      if (!target) {
        return err(
          `Could not resolve "${file}" — not a readable path, and no class matched via the ` +
            'language server or the project PSR-4 map. Try project_standards for the namespace map.',
          'unresolved',
          file,
        );
      }
      const { abs, rel } = target;

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
      // Structured config (.yml/.json/...) has no function/class outline —
      // trying to force one wastes a round-trip. It's already summarized by
      // the config index, so point there for a big file instead of dumping/
      // capping raw text (see search_config).
      const isConfig = isConfigExtension(rel);

      // ---- pass 2: a specific symbol's body ----------------------------------
      if (symbol && symbol.trim()) {
        if (!canOutline) {
          return err(
            isConfig
              ? `${rel} is structured config, not code — it has no symbols. Use search_config for a ` +
                `compact summary, or read_file with startLine/endLine for a specific range.`
              : `Can't resolve symbols in ${rel} (no tree-sitter grammar for ${ext || 'this type'}). ` +
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
        return sliceResult(rel, lines, total, from, to, undefined, isConfig);
      }

      // ---- pass 1: outline (explicit, or the default for a large file) -------
      // Structured config never has an outline (canOutline is false for it), so
      // this never fires for .yml/.json — it falls straight to the capped read
      // below, which carries the search_config hint via `isConfig`.
      const wantOutline = outline || total > MAX_LINES;
      if (wantOutline && canOutline) {
        const syms = await outlineWithTreeSitter(abs, ext);
        if (syms.length > 0) return outlineResult(rel, total, syms);
        // No symbols parsed (e.g. a config/data file) — fall through to a capped read.
      }

      // ---- whole (small) file, or capped read when no outline available ------
      const to = Math.min(total, MAX_LINES);
      return sliceResult(rel, lines, total, 1, to, undefined, isConfig);
    },
  );
}

// Turn the `file` arg into a concrete { abs, rel }. A normal path is used directly;
// a fully-qualified class name is resolved LSP-first (the language server's own
// PSR-4/namespace knowledge), then via the offline PSR-4 map. Null if unresolvable.
async function resolveReadTarget(
  file: string,
  workspaceRoot: string,
): Promise<{ abs: string; rel: string } | null> {
  if (!looksLikeFqcn(file)) return normalizeFileArg(file, workspaceRoot);

  const viaLsp = await resolveFqcnViaLsp(file, workspaceRoot);
  if (viaLsp) return normalizeFileArg(viaLsp, workspaceRoot);

  const off = resolveFqcn(file, detectStandards(workspaceRoot), workspaceRoot);
  return off ? { abs: off.abs, rel: off.rel } : null;
}

// Ask the language server (via the bridge) for the class by short name, then pick the
// hit whose enclosing namespace matches the FQCN. Returns an absolute path or null.
async function resolveFqcnViaLsp(fqcn: string, workspaceRoot: string): Promise<string | null> {
  const clean = fqcn.replace(/^\\+/, '');
  const shortName = clean.split('\\').pop() ?? clean;
  const ns = clean.slice(0, clean.length - shortName.length).replace(/\\+$/, '');

  const hits = await resolveSymbolViaBridge(workspaceRoot, shortName);
  if (!hits || hits.length === 0) return null;
  const named = hits.filter((h) => h.name === shortName);
  if (named.length === 0) return null;
  const exact = named.find((h) => h.container.replace(/^\\+/, '') === ns);
  return (exact ?? named[0]).file;
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
  isConfig?: boolean,
) {
  const slice = lines.slice(from - 1, to);
  const truncated = to < total;
  const width = String(to).length;
  const body = slice.map((l, i) => `${String(from + i).padStart(width)}  ${l}`).join('\n');
  const header = `${rel}${label ? ` · ${label}` : ''} (lines ${from}-${to} of ${total})`;
  // A symbol read (label present) is complete by definition — the file continuing
  // past it isn't "truncation". Only nudge for capped range/whole reads. Structured
  // config has no symbols, so its nudge points to search_config instead — "or a
  // symbol" would send the model into a guaranteed no-outline error round-trip.
  const note =
    truncated && !label
      ? isConfig
        ? `\n\n… ${total - to} more line(s). This is structured config — try search_config for a compact ` +
          `summary (ids/types/labels) instead of reading it whole, or request a specific range ` +
          `(startLine/endLine).`
        : `\n\n… ${total - to} more line(s). Request a range (startLine/endLine) or a symbol to read further.`
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
