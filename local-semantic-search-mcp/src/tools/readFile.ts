import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { normalizeFileArg } from './pathArg.js';

// Reads an actual file from the workspace (index-free) so an agent can read the
// EXACT module/file it located — the drill step after semantic_search/searchSymbol
// /architecture_overview identify a named target. This is the capability a
// third-party chat participant otherwise lacks (unlike built-in Copilot, which
// can open files), and it's what lets "how does the <X> module work" be answered
// from real code rather than fuzzy snippets. Local-only; no network, no index.
const MAX_LINES = 400; // cap a single read so a huge file can't blow up context

export function registerReadFileTool(server: McpServer, workspaceRoot: string): void {
  server.tool(
    'read_file',
    'Read the actual contents of a file in the workspace (with line numbers). Use ' +
      'this to read the EXACT file/module you located via search_symbol, ' +
      'architecture_overview, or a semantic_search hit — e.g. to explain how a named ' +
      'module works. Accepts an absolute or workspace-relative path. Optionally pass ' +
      `startLine/endLine to read a slice; large files are capped at ${MAX_LINES} lines, ` +
      'so request a range for more. This reads the real source, not the semantic index.',
    {
      file: z
        .string()
        .describe('File to read — absolute or workspace-relative (e.g. "src/storage/store.ts").'),
      startLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('1-based first line to read (default 1).'),
      endLine: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('1-based last line to read (inclusive). Defaults to a bounded window from startLine.'),
    },
    async ({ file, startLine, endLine }) => {
      const { abs, rel } = normalizeFileArg(file, workspaceRoot);

      // Keep reads inside the workspace — refuse path traversal / absolute paths
      // that resolve outside the indexed root.
      if (rel.startsWith('..') || rel === '' || rel.startsWith('/')) {
        return {
          content: [
            {
              type: 'text',
              text: `Refusing to read "${file}" — it resolves outside the workspace root.`,
            },
          ],
          structuredContent: { error: 'outside-workspace', file },
        };
      }

      let source: string;
      try {
        source = readFileSync(abs, 'utf8');
      } catch {
        return {
          content: [{ type: 'text', text: `Could not read ${rel} — file not found or unreadable.` }],
          structuredContent: { error: 'unreadable', file: rel },
        };
      }

      // Skip binary blobs (null byte) — line output would be garbage.
      if (source.includes('\0')) {
        return {
          content: [{ type: 'text', text: `${rel} looks binary — not reading.` }],
          structuredContent: { error: 'binary', file: rel },
        };
      }

      const lines = source.split('\n');
      const total = lines.length;
      const from = Math.max(1, startLine ?? 1);
      const to = Math.min(endLine ?? from + MAX_LINES - 1, total, from + MAX_LINES - 1);
      const slice = lines.slice(from - 1, to);
      const truncated = to < total;

      const width = String(to).length;
      const body = slice
        .map((l, i) => `${String(from + i).padStart(width)}  ${l}`)
        .join('\n');

      const header = `${rel} (lines ${from}-${to} of ${total})`;
      const note = truncated
        ? `\n\n… ${total - to} more line(s). Request a range (startLine/endLine) to read further.`
        : '';

      return {
        content: [{ type: 'text', text: `${header}\n\`\`\`\n${body}\n\`\`\`${note}` }],
        structuredContent: {
          file: rel,
          startLine: from,
          endLine: to,
          totalLines: total,
          truncated,
          content: slice.join('\n'),
        },
      };
    },
  );
}
