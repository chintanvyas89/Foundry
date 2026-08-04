import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VectorStore } from '../storage/store.js';

// A cheap, offline orientation summary of the indexed workspace — file/chunk
// counts, a language breakdown, and which of the optional indexes (symbols,
// call graph, usages, implementations) have been built. Reads only what's
// already stored; no embedder, no bridge, no re-index.
export function registerRepoOverviewTool(server: McpServer, store: VectorStore): void {
  server.tool(
    'repo_overview',
    'Get a quick orientation summary of the indexed workspace: how many files and ' +
      'chunks are indexed, the language breakdown (by file extension), and which ' +
      'optional indexes (symbols, call graph, usages, implementations) are built. ' +
      'Use FIRST on an unfamiliar codebase to gauge its size and shape, or to check ' +
      'what code-intelligence data is available before relying on trace_calls / ' +
      'find_usages offline.',
    { _: z.string().optional().describe('Ignored — this tool takes no input.') },
    async () => {
      const r = store.repoStats();
      const s = store.symbolStats();
      const g = store.graphStats();
      const u = store.usageStats();
      const im = store.implStats();

      const langs = r.languages.slice(0, 12).map((l) => `${l.ext}×${l.files}`).join(', ');
      const built = (n: number, filesBuilt: number, label: string): string =>
        filesBuilt === 0 ? `${label}: not built` : `${label}: ${n} (${filesBuilt} files scanned)`;

      const text = [
        `Workspace index overview:`,
        `- ${r.files} files indexed, ${r.chunks} chunks`,
        `- languages (by extension): ${langs || '(none)'}`,
        `- ${built(s.symbols, s.filesBuilt, 'symbols')}`,
        `- ${built(g.edges, g.filesBuilt, 'call graph edges')}`,
        `- ${built(u.refs, u.filesBuilt, 'usages/references')}`,
        `- ${built(im.impls, im.filesBuilt, 'implementations')}`,
      ].join('\n');

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          files: r.files,
          chunks: r.chunks,
          languages: r.languages,
          symbols: s.symbols,
          edges: g.edges,
          refs: u.refs,
          impls: im.impls,
        },
      };
    },
  );
}
