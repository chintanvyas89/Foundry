import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { embed } from '../embedding/embedder.js';
import type { VectorStore } from '../storage/store.js';
import type { Config } from '../config.js';

export function registerSemanticSearchTool(
  server: McpServer,
  store: VectorStore,
  config: Config,
  ready: Promise<void>,
): void {
  server.tool(
    'semantic_search',
    'Search this workspace for code semantically related to a natural-language or code query. ' +
      'Returns the top matching chunks with file path, line range, and similarity score.',
    {
      query: z.string().describe('Natural-language or code description of what to find'),
      topK: z.number().int().positive().optional().describe('Number of results to return'),
    },
    async ({ query, topK }) => {
      // Block until the background model load + initial index have finished.
      // A query that arrives during startup waits here rather than running
      // against a not-yet-loaded embedder or an empty store.
      await ready;
      const queryEmbedding = await embed(query);
      const results = store.search(queryEmbedding, topK ?? config.topKDefault);

      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No matching code found.' }] };
      }

      const text = results
        .map((r, i) => {
          const location = `${r.file}:${r.startLine}-${r.endLine}`;
          const label = r.symbol ? `${r.symbol} (${location})` : location;
          return `${i + 1}. ${label} — score ${r.score.toFixed(3)}\n\`\`\`\n${r.text}\n\`\`\``;
        })
        .join('\n\n');

      return { content: [{ type: 'text', text }] };
    },
  );
}
