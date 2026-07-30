import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { embed } from '../embedding/embedder.js';
import type { VectorStore } from '../storage/store.js';
import type { Config } from '../config.js';

export function registerSemanticSearchTool(
  server: McpServer,
  store: VectorStore,
  config: Config,
  workspaceRoot: string,
  ready: Promise<void>,
): void {
  server.tool(
    'semantic_search',
    'Find code in the current workspace by meaning/intent. USE THIS FIRST — before ' +
      'reading files or grepping — to answer "where is X implemented?", "what code ' +
      'handles Y?", or "find code similar to Z" across this codebase. It ranks the ' +
      'most relevant functions/classes by semantic similarity to a natural-language ' +
      'or code query (not keyword match) and returns each with its file path, line ' +
      'range, and the code itself, so you can jump straight to the right place ' +
      'instead of scanning files one by one. Prefer this over file-reading for ' +
      'locating or exploring unfamiliar code.',
    {
      query: z
        .string()
        .describe('What to find, in natural language or code, e.g. "where JWT tokens are validated"'),
      topK: z.number().int().positive().optional().describe('How many results to return (default 8)'),
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

      // Stored paths are workspace-relative for portability; resolve each to an
      // absolute path against THIS machine's workspace root so callers (the
      // human-readable text and structured clients like the editor search
      // panel) can open the file directly.
      const resolved = results.map((r) => ({
        file: join(workspaceRoot, r.file),
        symbol: r.symbol ?? null,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        text: r.text,
      }));

      const text = resolved
        .map((r, i) => {
          const location = `${r.file}:${r.startLine}-${r.endLine}`;
          const label = r.symbol ? `${r.symbol} (${location})` : location;
          return `${i + 1}. ${label} — score ${r.score.toFixed(3)}\n\`\`\`\n${r.text}\n\`\`\``;
        })
        .join('\n\n');

      // `content` is what an LLM reads; `structuredContent` is the same result
      // set as machine-readable JSON for non-LLM UI clients.
      return { content: [{ type: 'text', text }], structuredContent: { results: resolved } };
    },
  );
}
