import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VectorStore } from '../storage/store.js';
import {
  getReferencesViaBridge,
  getImplementationsViaBridge,
  type BridgeRef,
} from '../chunking/lspBridgeClient.js';
import { normalizeFileArg } from './pathArg.js';

// find_usages / find_implementations. find_usages prefers the live language
// server (via the LSP bridge) but falls back to the persisted usages index
// (`symbol_refs`) when the bridge is down — so once usages have been built (and
// they're shareable with the index), it works fully offline. find_implementations
// stays bridge-only (implementations aren't persisted).
const params = {
  file: z
    .string()
    .describe('File path of the symbol (the "file" field from a search result) — absolute or workspace-relative.'),
  line: z
    .number()
    .int()
    .positive()
    .describe("1-based line where the symbol is defined (a result's startLine)."),
  symbol: z.string().optional().describe('The symbol name, if known — improves accuracy.'),
};

const UNAVAILABLE =
  "unavailable — the VS Code LSP bridge isn't running for this workspace. Open the " +
  'workspace in VS Code with the Local Semantic Search extension active, then retry.';

function fmt(nodes: BridgeRef[]): string {
  return nodes.length
    ? nodes.map((n) => `  - ${n.file}:${n.line}${n.text ? `  ${n.text}` : ''}`).join('\n')
    : '  (none)';
}

export function registerSymbolRefTools(
  server: McpServer,
  store: VectorStore,
  workspaceRoot: string,
): void {
  const toAbs = (rel: string) => join(workspaceRoot, rel);

  server.tool(
    'find_usages',
    'Find all usages/references of a symbol across the workspace — everywhere a ' +
      'function/class/variable is called, imported, or referenced. Give its location ' +
      '(file + line, e.g. from a semantic_search or search_symbol result). Use for ' +
      '"where is X used?", "what would break if I change X?", impact analysis. ' +
      'Uses the live language server when the VS Code LSP bridge is running, otherwise ' +
      'the persisted usages index (if built — pass the symbol name so the offline ' +
      "lookup can find it). Can't resolve dynamic dispatch or cross-language.",
    params,
    async ({ file, line, symbol }) => {
      const { abs, rel } = normalizeFileArg(file, workspaceRoot);
      const refs = await getReferencesViaBridge(workspaceRoot, abs, line, symbol);

      // Live path: the language server answered.
      if (refs) {
        if (refs.length === 0) {
          return {
            content: [{ type: 'text', text: `No usages found for ${abs}:${line}.` }],
            structuredContent: { results: [], source: 'live' },
          };
        }
        return {
          content: [{ type: 'text', text: `Usages (${refs.length}):\n${fmt(refs)}` }],
          structuredContent: { results: refs, source: 'live' },
        };
      }

      // Fallback: the persisted usages index. Keyed by name, like the call graph.
      if (symbol) {
        const usages = store.getUsages(rel, symbol);
        if (usages.length > 0) {
          const nodes: BridgeRef[] = usages.map((u) => ({
            file: toAbs(u.file),
            line: u.line,
            text: u.text,
          }));
          return {
            content: [
              {
                type: 'text',
                text:
                  `Usages of ${symbol} (${usages.length}) — from the saved usages index ` +
                  `(LSP bridge not running):\n${fmt(nodes)}`,
              },
            ],
            structuredContent: { results: nodes, source: 'persisted' },
          };
        }
      }

      return { content: [{ type: 'text', text: `Usages ${UNAVAILABLE}` }] };
    },
  );

  server.tool(
    'find_implementations',
    'Find concrete implementations of an interface, abstract method, or type at a ' +
      'location (file + line). Use for "what implements this interface?", "which ' +
      'classes implement X?". Uses the live language server when the VS Code LSP ' +
      'bridge is running, otherwise the persisted implementations index (if built — ' +
      'pass the symbol name so the offline lookup can find it).',
    params,
    async ({ file, line, symbol }) => {
      const { abs, rel } = normalizeFileArg(file, workspaceRoot);
      const impls = await getImplementationsViaBridge(workspaceRoot, abs, line, symbol);

      // Live path: the language server answered.
      if (impls) {
        if (impls.length === 0) {
          return {
            content: [{ type: 'text', text: `No implementations found for ${abs}:${line}.` }],
            structuredContent: { results: [], source: 'live' },
          };
        }
        return {
          content: [{ type: 'text', text: `Implementations (${impls.length}):\n${fmt(impls)}` }],
          structuredContent: { results: impls, source: 'live' },
        };
      }

      // Fallback: the persisted implementations index (keyed by name).
      if (symbol) {
        const stored = store.getImplementations(rel, symbol);
        if (stored.length > 0) {
          const nodes: BridgeRef[] = stored.map((s) => ({ file: toAbs(s.file), line: s.line, text: s.text }));
          return {
            content: [
              {
                type: 'text',
                text:
                  `Implementations of ${symbol} (${stored.length}) — from the saved index ` +
                  `(LSP bridge not running):\n${fmt(nodes)}`,
              },
            ],
            structuredContent: { results: nodes, source: 'persisted' },
          };
        }
      }

      return { content: [{ type: 'text', text: `Implementations ${UNAVAILABLE}` }] };
    },
  );
}
