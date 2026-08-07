import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildIgnoreMatcher } from '../ignore/ignoreMatcher.js';
import { normalizeFileArg } from './pathArg.js';

// Recursive directory structure of the workspace — a filesystem `tree`, respecting
// only .gitignore/.sweignore/defaults (so no node_modules/.git noise) —
// DELIBERATELY NOT the embed index's config.exclude, which controls what's kept
// out of the SEARCH index (e.g. "vendor/", "config/sync/**") and is a different
// concern from "does this exist on disk". Complements read_file (one file) and
// architecture_overview (index-level module map): this is the raw layout, works for
// UNindexed AND excluded-from-embedding files, and answers "what's in this repo /
// where does X live".
//
// Depth-limited so it's token-lean and drill-friendly (like read_file's two pass):
// a shallow tree first; the model calls again with path="<subdir>" (and/or a larger
// depth) to expand a branch. Directories cut off by the depth limit are marked "/…".
const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 10;
const DEFAULT_MAX_ENTRIES = 400;

interface TreeNode {
  name: string;
  type: 'dir' | 'file';
  children?: TreeNode[];
  more?: boolean; // a dir cut off by the depth limit that still has (non-ignored) children
}

export function registerListDirectoryTool(server: McpServer, workspaceRoot: string): void {
  server.tool(
    'list_directory',
    'List the workspace directory STRUCTURE recursively — a file/folder tree that ' +
      'respects .gitignore/.sweignore (no node_modules/.git noise). Use to orient on ' +
      'an unfamiliar repo, see how it is laid out, or find where files/dirs live ' +
      '(it covers unindexed files too, unlike architecture_overview). Call with no ' +
      'path for the repo root; it is depth-limited, so drill into a branch by calling ' +
      'again with path="<subdir>" and/or a larger depth. Folders cut off by the depth ' +
      'limit are marked "/…".',
    {
      path: z
        .string()
        .optional()
        .describe('Directory to list — absolute or workspace-relative. Omit for the repo root.'),
      depth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`How many levels deep to walk (default ${DEFAULT_DEPTH}, max ${MAX_DEPTH}).`),
      maxEntries: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`Cap on total entries returned (default ${DEFAULT_MAX_ENTRIES}).`),
    },
    async ({ path, depth, maxEntries }) => {
      // Deliberately only .gitignore/.sweignore/defaults — NOT the embed-index's
      // exclude list (config.exclude). That list controls what's kept out of the
      // SEARCH index (e.g. "vendor/", "config/sync/**"); list_directory's whole
      // point is to show the real on-disk layout including files excluded from
      // embedding, so it must not inherit that config.
      const ig = buildIgnoreMatcher(workspaceRoot);
      const { abs, rel } = normalizeFileArg(path && path.trim() ? path : '.', workspaceRoot);

      if (rel.startsWith('..')) {
        return {
          content: [{ type: 'text', text: `Refusing to list "${path}" — it resolves outside the workspace root.` }],
          structuredContent: { error: 'outside-workspace', path },
        };
      }

      const maxDepth = Math.min(depth ?? DEFAULT_DEPTH, MAX_DEPTH);
      const cap = maxEntries ?? DEFAULT_MAX_ENTRIES;

      // An entry is ignored if it matches the ignore rules. Directory patterns like
      // `dist/` only match with a trailing slash in the `ignore` lib, so test dirs
      // both ways — otherwise an ignored dir shows up (empty, its files filtered).
      const entryIgnored = (abs: string, isDir: boolean): boolean => {
        const r = relative(workspaceRoot, abs).split(sep).join('/');
        if (!r || r.startsWith('..')) return false;
        return ig.ignores(r) || (isDir && ig.ignores(`${r}/`));
      };

      // Non-ignored dir/file entries of a directory, dirs first then files, sorted.
      const listing = (absDir: string) => {
        let entries;
        try {
          entries = readdirSync(absDir, { withFileTypes: true });
        } catch {
          return [];
        }
        return entries
          .filter(
            (e) =>
              (e.isDirectory() || e.isFile()) &&
              !entryIgnored(join(absDir, e.name), e.isDirectory()),
          )
          .sort((a, b) =>
            a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
          );
      };

      let count = 0;
      let hitCap = false;

      const walk = (absDir: string, level: number): TreeNode[] => {
        const nodes: TreeNode[] = [];
        for (const e of listing(absDir)) {
          if (count >= cap) {
            hitCap = true;
            break;
          }
          count++;
          const full = join(absDir, e.name);
          if (e.isDirectory()) {
            const node: TreeNode = { name: e.name, type: 'dir' };
            if (level < maxDepth) node.children = walk(full, level + 1);
            else if (listing(full).length > 0) node.more = true;
            nodes.push(node);
          } else {
            nodes.push({ name: e.name, type: 'file' });
          }
        }
        return nodes;
      };

      const tree = walk(abs, 1);

      if (tree.length === 0) {
        return {
          content: [{ type: 'text', text: `${rel || '.'} is empty or entirely ignored.` }],
          structuredContent: { path: rel, tree: [], entries: 0 },
        };
      }

      const lines: string[] = [];
      const render = (nodes: TreeNode[], prefix: string) => {
        for (const n of nodes) {
          if (n.type === 'dir') {
            lines.push(`${prefix}${n.name}/${n.more ? '…' : ''}`);
            if (n.children) render(n.children, `${prefix}  `);
          } else {
            lines.push(`${prefix}${n.name}`);
          }
        }
      };
      render(tree, '');

      const header = `${rel || '.'}/ — directory tree (depth ${maxDepth}, ${count} entries)`;
      const note = hitCap
        ? `\n\n… truncated at ${cap} entries — narrow with path="<subdir>" or a smaller depth.`
        : '';

      return {
        content: [{ type: 'text', text: `${header}\n${lines.join('\n')}${note}` }],
        structuredContent: {
          path: rel,
          depth: maxDepth,
          entries: count,
          truncated: hitCap,
          tree,
        },
      };
    },
  );
}
