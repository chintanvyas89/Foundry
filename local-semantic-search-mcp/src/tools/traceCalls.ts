import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getCallHierarchyViaBridge, type BridgeCallNode } from '../chunking/lspBridgeClient.js';

// Call-graph / execution-flow tool. Unlike semantic_search this needs the live
// language server, which only exists inside VS Code via the LSP bridge — so it
// returns "unavailable" when run without the bridge (e.g. a bare CLI).
export function registerTraceCallsTool(server: McpServer, workspaceRoot: string): void {
  server.tool(
    'trace_calls',
    'Trace the call graph / execution flow around a function. Given its location ' +
      '(file + line — e.g. straight from a semantic_search result), returns the ' +
      'functions it CALLS (callees) and the functions that CALL it (callers), via ' +
      'the language server. Use after semantic_search to follow execution flow — ' +
      '"who calls X", "what does X call", "trace the checkout flow". Each result ' +
      'includes a file:line you can trace_calls again to walk further. Requires the ' +
      'VS Code LSP bridge to be running (returns unavailable otherwise), and cannot ' +
      'resolve dynamic dispatch (interfaces/callbacks/DI), cross-language calls, or ' +
      'data flow — use semantic_search for those.',
    {
      file: z
        .string()
        .describe('Absolute file path of the function (the "file" field from a semantic_search result).'),
      line: z
        .number()
        .int()
        .positive()
        .describe("1-based line where the function is defined (a result's startLine)."),
      symbol: z
        .string()
        .optional()
        .describe('The function/method name, if known — improves which symbol is picked on that line.'),
    },
    async ({ file, line, symbol }) => {
      const calls = await getCallHierarchyViaBridge(workspaceRoot, file, line, symbol);

      if (!calls) {
        return {
          content: [
            {
              type: 'text',
              text:
                "Call hierarchy unavailable — the VS Code LSP bridge isn't running for " +
                'this workspace. Open the workspace in VS Code with the Local Semantic ' +
                'Search extension active, then retry. (semantic_search still works without it.)',
            },
          ],
        };
      }
      if (!calls.root) {
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
      }

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
        },
      };
    },
  );
}
