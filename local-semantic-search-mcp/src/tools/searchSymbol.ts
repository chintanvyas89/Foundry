import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VectorStore } from '../storage/store.js';
import type { Config } from '../config.js';

// Exact/partial symbol-NAME lookup — the complement to semantic_search. Purely
// local over the stored index (no embedder, no bridge), so it works instantly
// and offline. Ranks exact > prefix > substring.
export function registerSearchSymbolTool(
  server: McpServer,
  store: VectorStore,
  config: Config,
  workspaceRoot: string,
): void {
  server.tool(
    'search_symbol',
    'Find a function/class/method by NAME (exact or partial) — not by meaning. Use ' +
      'this when you already know the identifier, e.g. "getUserById" or "VectorStore", ' +
      'where semantic_search (meaning-based) is weaker. Returns matching symbols ranked ' +
      'exact > prefix > substring, each with its file:line and code. For "what does X ' +
      'do" or "where is Y handled", prefer semantic_search.',
    {
      name: z
        .string()
        .describe('Symbol name or fragment, e.g. "cosineSimilarity" or just "cosine".'),
      limit: z.number().int().positive().optional().describe('Max results (default 8).'),
    },
    async ({ name, limit }) => {
      const q = name.trim().toLowerCase();
      const ranked = store
        .searchSymbols(name.trim())
        .map((r) => {
          const s = r.symbol.toLowerCase();
          const score = s === q ? 1 : s.startsWith(q) ? 0.9 : 0.75;
          return { ...r, score };
        })
        .sort((a, b) => b.score - a.score || a.symbol.length - b.symbol.length)
        .slice(0, limit ?? config.topKDefault);

      if (ranked.length === 0) {
        return {
          content: [{ type: 'text', text: `No symbol matching "${name}".` }],
          structuredContent: { results: [] },
        };
      }

      // Same result shape as semantic_search so UI clients can reuse it.
      const resolved = ranked.map((r) => ({
        id: r.id,
        file: join(workspaceRoot, r.file),
        symbol: r.symbol,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        text: r.text,
      }));

      const text = resolved
        .map(
          (r, i) =>
            `${i + 1}. ${r.symbol} (${r.file}:${r.startLine}-${r.endLine})\n\`\`\`\n${r.text}\n\`\`\``,
        )
        .join('\n\n');

      return { content: [{ type: 'text', text }], structuredContent: { results: resolved } };
    },
  );
}
