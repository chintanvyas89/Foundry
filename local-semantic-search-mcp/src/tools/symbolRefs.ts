import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  getReferencesViaBridge,
  getImplementationsViaBridge,
  type BridgeRef,
} from '../chunking/lspBridgeClient.js';

// find_usages / find_implementations — like trace_calls, these need the live
// language server via the LSP bridge, so they return "unavailable" without it.
const params = {
  file: z
    .string()
    .describe('Absolute file path of the symbol (the "file" field from a search result).'),
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

export function registerSymbolRefTools(server: McpServer, workspaceRoot: string): void {
  server.tool(
    'find_usages',
    'Find all usages/references of a symbol across the workspace — everywhere a ' +
      'function/class/variable is called, imported, or referenced. Give its location ' +
      '(file + line, e.g. from a semantic_search or search_symbol result). Use for ' +
      '"where is X used?", "what would break if I change X?", impact analysis. ' +
      "Requires the VS Code LSP bridge; can't resolve dynamic dispatch or cross-language.",
    params,
    async ({ file, line, symbol }) => {
      const refs = await getReferencesViaBridge(workspaceRoot, file, line, symbol);
      if (!refs) return { content: [{ type: 'text', text: `Usages ${UNAVAILABLE}` }] };
      if (refs.length === 0) {
        return {
          content: [{ type: 'text', text: `No usages found for ${file}:${line}.` }],
          structuredContent: { results: [] },
        };
      }
      return {
        content: [{ type: 'text', text: `Usages (${refs.length}):\n${fmt(refs)}` }],
        structuredContent: { results: refs },
      };
    },
  );

  server.tool(
    'find_implementations',
    'Find concrete implementations of an interface, abstract method, or type at a ' +
      'location (file + line). Use for "what implements this interface?", "which ' +
      'classes implement X?". Requires the VS Code LSP bridge to be running.',
    params,
    async ({ file, line, symbol }) => {
      const refs = await getImplementationsViaBridge(workspaceRoot, file, line, symbol);
      if (!refs) return { content: [{ type: 'text', text: `Implementations ${UNAVAILABLE}` }] };
      if (refs.length === 0) {
        return {
          content: [{ type: 'text', text: `No implementations found for ${file}:${line}.` }],
          structuredContent: { results: [] },
        };
      }
      return {
        content: [{ type: 'text', text: `Implementations (${refs.length}):\n${fmt(refs)}` }],
        structuredContent: { results: refs },
      };
    },
  );
}
