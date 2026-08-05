import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VectorStore } from '../storage/store.js';

// Keyword lookup over the embedding-free config index — the config counterpart of
// search_symbol. Structured YAML config (Drupal views/fields/services/routing/
// permissions/info, and any other `.yml`) is NEVER embedded; this queries the
// parsed facts by id/label/keyword, ranked exact-id > id/label substring > facts.
// Purely local (no embedder, no bridge). Needs the config index to have been
// built (SWE_BUILD_CONFIG / SWE_BUILD_ALL).
export function registerSearchConfigTool(
  server: McpServer,
  store: VectorStore,
  workspaceRoot: string,
): void {
  server.tool(
    'search_config',
    'Search the project CONFIG index — structured YAML config (Drupal config/sync ' +
      'views, fields, form/view displays, and *.services.yml / *.routing.yml / ' +
      '*.permissions.yml / *.info.yml, plus any other .yml). Use for questions like ' +
      '"which view lists published articles", "what fields does the Article type have", ' +
      '"what handles the /market/activity route", "what does the market module depend ' +
      'on". Config is NOT in semantic_search (it is never embedded) — this is how you ' +
      'reach it. Returns items ranked exact-id > id/label > keyword, each with its ' +
      'id, type, file:line and a facts summary; open the file for the raw YAML. ' +
      'Optionally filter by `type` (view, field, service, route, permission, module_info, …).',
    {
      query: z
        .string()
        .describe('Config id, label, or keywords, e.g. "frontpage", "article body", "activity route".'),
      type: z
        .string()
        .optional()
        .describe('Restrict to one config type, e.g. "view", "field", "service", "route", "permission".'),
      limit: z.number().int().positive().optional().describe('Max results (default 10).'),
    },
    async ({ query, type, limit }) => {
      const rows = store.searchConfig(query, { type, cap: limit ?? 10 });

      if (rows.length === 0) {
        const hint = store.configStats().items === 0
          ? ' The config index is not built — run SWE_BUILD_CONFIG=1 (or SWE_BUILD_ALL=1).'
          : '';
        return {
          content: [{ type: 'text', text: `No config matching "${query}"${type ? ` (type: ${type})` : ''}.${hint}` }],
          structuredContent: { results: [] },
        };
      }

      const resolved = rows.map((r) => ({
        id: r.id,
        type: r.type,
        label: r.label ?? null,
        deps: r.deps ?? null,
        file: join(workspaceRoot, r.file),
        startLine: r.startLine,
        facts: r.facts,
      }));

      const text = resolved
        .map((r, i) => {
          const head = `${i + 1}. ${r.id} [${r.type}] (${r.file}:${r.startLine})`;
          return `${head}\n${r.facts}`;
        })
        .join('\n\n');

      return { content: [{ type: 'text', text }], structuredContent: { results: resolved } };
    },
  );
}
