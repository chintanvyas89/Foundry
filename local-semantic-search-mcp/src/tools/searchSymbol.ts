import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VectorStore } from '../storage/store.js';
import type { Config } from '../config.js';

// A merged symbol match: from the chunk index (has `text`/`id`), the standalone
// symbols table (has `kind`), or both.
export interface SymbolHit {
  id?: string;
  file: string;
  symbol: string;
  kind?: string;
  startLine: number;
  endLine: number;
  text?: string;
  score: number;
}

// Exact-NAME symbol lookup over the stored index — the shared logic behind the
// search_symbol tool AND semantic_search's auto-inject (queries share this so
// the two tools complement rather than duplicate each other; see
// semanticSearch.ts's use of this for compound/vocab candidates). Purely local
// (no embedder, no bridge). Ranks exact > prefix > substring.
export function findSymbolMatches(store: VectorStore, name: string, limit: number): SymbolHit[] {
  const q = name.trim().toLowerCase();
  const scoreOf = (n: string): number => {
    const s = n.toLowerCase();
    return s === q ? 1 : s.startsWith(q) ? 0.9 : 0.75;
  };

  // Union two sources, keyed by name+file+line so a symbol present in both is
  // merged (not duplicated): chunk symbols carry the code body; the standalone
  // symbols table carries the kind and the non-callable declarations that
  // never became chunks. The table may be empty (not built) — then this is
  // exactly the old chunk-only behaviour.
  const key = (file: string, sym: string, line: number): string => `${sym}|${file}|${line}`;
  const byKey = new Map<string, SymbolHit>();

  for (const r of store.searchSymbols(name.trim())) {
    byKey.set(key(r.file, r.symbol, r.startLine), {
      id: r.id,
      file: r.file,
      symbol: r.symbol,
      startLine: r.startLine,
      endLine: r.endLine,
      text: r.text,
      score: scoreOf(r.symbol),
    });
  }
  for (const r of store.searchSymbolsTable(name.trim())) {
    const k = key(r.file, r.name, r.startLine);
    const existing = byKey.get(k);
    if (existing) {
      existing.kind = r.kind; // annotate the callable chunk with its kind
    } else {
      byKey.set(k, {
        file: r.file,
        symbol: r.name,
        kind: r.kind,
        startLine: r.startLine,
        endLine: r.endLine,
        score: scoreOf(r.name),
      });
    }
  }

  return [...byKey.values()]
    .sort((a, b) => b.score - a.score || a.symbol.length - b.symbol.length)
    .slice(0, limit);
}

// Find a symbol by NAME (exact or partial) — the complement to semantic_search
// (meaning-based). Purely local over the stored index, so it works instantly
// and offline.
export function registerSearchSymbolTool(
  server: McpServer,
  store: VectorStore,
  config: Config,
  workspaceRoot: string,
): void {
  server.tool(
    'search_symbol',
    'Find a symbol by NAME (exact or partial) — not by meaning. Use this when you ' +
      'already know the identifier, e.g. "getUserById", "VectorStore", or an ' +
      'interface/enum/type/constant name, where semantic_search (meaning-based) is ' +
      'weaker. Covers callables (with their code) AND non-callable declarations ' +
      '(interfaces, enums, type aliases, constants) once the symbol table is built. ' +
      'Returns matches ranked exact > prefix > substring, each with its file:line, ' +
      'kind, and (for callables) code. For "what does X do" or "where is Y handled", ' +
      'prefer semantic_search — though semantic_search now also auto-probes this same ' +
      'index for compound-identifier candidates in multi-word queries, so the two ' +
      'complement each other automatically for queries that mix meaning and a ' +
      'likely identifier (e.g. "xyz block").',
    {
      name: z
        .string()
        .describe('Symbol name or fragment, e.g. "cosineSimilarity" or just "cosine".'),
      limit: z.number().int().positive().optional().describe('Max results (default 8).'),
    },
    async ({ name, limit }) => {
      const ranked = findSymbolMatches(store, name, limit ?? config.topKDefault);

      if (ranked.length === 0) {
        return {
          content: [{ type: 'text', text: `No symbol matching "${name}".` }],
          structuredContent: { results: [] },
        };
      }

      // Same result shape as semantic_search so UI clients can reuse it; `kind`
      // is added, and `text` may be absent for non-callable declarations.
      const resolved = ranked.map((r) => ({
        id: r.id ?? null,
        file: join(workspaceRoot, r.file),
        symbol: r.symbol,
        kind: r.kind ?? null,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        text: r.text ?? null,
      }));

      const text = resolved
        .map((r, i) => {
          const head = `${i + 1}. ${r.symbol} (${r.file}:${r.startLine}-${r.endLine})${r.kind ? ` — ${r.kind}` : ''}`;
          // Callable hits carry code; non-callable declarations show location +
          // kind only (open the file at the line for detail).
          return r.text ? `${head}\n\`\`\`\n${r.text}\n\`\`\`` : head;
        })
        .join('\n\n');

      return { content: [{ type: 'text', text }], structuredContent: { results: resolved } };
    },
  );
}
