import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getCallHierarchyViaBridge, type BridgeCallNode } from '../chunking/lspBridgeClient.js';
import type { VectorStore, CallGraphNode } from '../storage/store.js';
import { normalizeFileArg } from './pathArg.js';

// Call-graph / execution-flow tool. Prefers the live language server (via the
// LSP bridge) but falls back to the persisted call graph (`call_edges`) when the
// bridge isn't running — so once the graph has been built (and it's shareable
// with the index), callers/callees work fully offline.
export function registerTraceCallsTool(
  server: McpServer,
  store: VectorStore,
  workspaceRoot: string,
): void {
  const toAbs = (rel: string) => join(workspaceRoot, rel);

  server.tool(
    'trace_calls',
    'Trace the call graph / execution flow around a function. Given its location ' +
      '(file + line — e.g. straight from a semantic_search result), returns the ' +
      'functions it CALLS (callees) and the functions that CALL it (callers). Uses ' +
      'the live language server when the VS Code LSP bridge is running, otherwise ' +
      'the persisted call graph (if it has been built). Use after semantic_search to ' +
      'follow execution flow — "who calls X", "what does X call", "trace the checkout ' +
      'flow". Each result includes a file:line you can trace_calls again to walk ' +
      'further. Cannot resolve dynamic dispatch (interfaces/callbacks/DI), ' +
      'cross-language calls, or data flow — use semantic_search for those.',
    {
      file: z
        .string()
        .describe('File path of the function (the "file" field from a search result) — absolute or workspace-relative.'),
      line: z
        .number()
        .int()
        .positive()
        .describe("1-based line where the function is defined (a result's startLine)."),
      symbol: z
        .string()
        .optional()
        .describe(
          'The function/method name. Improves which symbol is picked on that line, ' +
            'and is REQUIRED for the offline (persisted-graph) fallback.',
        ),
    },
    async ({ file, line, symbol }) => {
      const { abs, rel } = normalizeFileArg(file, workspaceRoot);
      const calls = await getCallHierarchyViaBridge(workspaceRoot, abs, line, symbol);

      // Live path: language server answered with a real root.
      if (calls && calls.root) {
        const fmt = (nodes: BridgeCallNode[]) =>
          nodes.length ? nodes.map((n) => `  - ${n.name} (${n.file}:${n.line})`).join('\n') : '  (none)';
        const text =
          `Call hierarchy for ${calls.root.name} (${calls.root.file}:${calls.root.line})\n\n` +
          `Calls (outgoing):\n${fmt(calls.outgoing)}\n\n` +
          `Called by (incoming):\n${fmt(calls.incoming)}`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            root: calls.root,
            outgoing: calls.outgoing,
            incoming: calls.incoming,
            source: 'live',
          },
        };
      }

      // Fallback: the persisted graph. Needs the symbol name (the graph is keyed
      // by name, not the caller-supplied line which may differ from the stored
      // definition line).
      if (symbol) {
        const callees = store.getCallees(rel, symbol);
        const callers = store.getCallers(rel, symbol);
        if (callees.length > 0 || callers.length > 0) {
          const fmt = (nodes: CallGraphNode[]) =>
            nodes.length
              ? nodes.map((n) => `  - ${n.name} (${toAbs(n.file)}:${n.line})`).join('\n')
              : '  (none)';
          const text =
            `Call hierarchy for ${symbol} (${abs}:${line}) — from the saved call graph ` +
            `(LSP bridge not running)\n\n` +
            `Calls (outgoing):\n${fmt(callees)}\n\n` +
            `Called by (incoming):\n${fmt(callers)}`;
          return {
            content: [{ type: 'text', text }],
            structuredContent: {
              root: { name: symbol, file: abs, line },
              outgoing: callees.map((n) => ({ name: n.name, file: toAbs(n.file), line: n.line })),
              incoming: callers.map((n) => ({ name: n.name, file: toAbs(n.file), line: n.line })),
              source: 'persisted',
            },
          };
        }
      }

      // Nothing live and nothing stored.
      if (!calls) {
        return {
          content: [
            {
              type: 'text',
              text:
                "Call hierarchy unavailable — the VS Code LSP bridge isn't running and this " +
                'symbol has no entry in the saved call graph. Open the workspace in VS Code ' +
                'with the Local Semantic Search extension active (or build/share the call ' +
                'graph), then retry. Pass the symbol name to enable the offline lookup. ' +
                '(semantic_search still works without any of this.)',
            },
          ],
        };
      }
      return {
        content: [
          {
            type: 'text',
            text:
              `No call hierarchy for ${file}:${line} — the language server may not support ` +
              "call hierarchy for this file, or the position isn't on a function/method.",
          },
        ],
      };
    },
  );
}
