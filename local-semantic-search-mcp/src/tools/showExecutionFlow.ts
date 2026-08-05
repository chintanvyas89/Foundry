import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VectorStore } from '../storage/store.js';
import { normalizeFileArg } from './pathArg.js';

// Multi-level execution-flow walk over the PERSISTED call graph (`call_edges`).
// trace_calls is one level; this follows the chain to a bounded depth in one
// call — "trace the checkout flow", "what does handleRequest end up calling".
// It reads the persisted graph only (offline, cheap), so it needs the graph to
// have been built (SWE_BUILD_GRAPH=1); a live multi-level walk would be many
// slow bridge round-trips, which is exactly what persisting the graph avoids.

const MAX_DEPTH = 6;
const MAX_NODES = 200; // guard against fan-out/explosion on hub functions

interface FlowNode {
  name: string;
  file: string; // absolute, for display / re-tracing
  line: number;
  children: FlowNode[];
  truncated?: 'depth' | 'cycle' | 'cap';
}

export function registerExecutionFlowTool(
  server: McpServer,
  store: VectorStore,
  workspaceRoot: string,
): void {
  const toAbs = (rel: string) => join(workspaceRoot, rel);

  server.tool(
    'show_execution_flow',
    'Walk the call graph several levels deep from a function, in one call — the ' +
      'multi-level version of trace_calls. Give the function (file + name); it ' +
      'returns an indented tree of what it CALLS (direction="callees", default) or ' +
      'what CALLS it (direction="callers"), down to `depth` levels, with cycle and ' +
      'size guards. Use for "trace the checkout/auth flow" or "what does X ' +
      'eventually call". Reads the persisted call graph, so it works offline once ' +
      'the graph has been built (SWE_BUILD_GRAPH=1) — for a single live level ' +
      'without a built graph, use trace_calls.',
    {
      file: z
        .string()
        .describe('File path of the starting function (a search result\'s "file") — absolute or workspace-relative.'),
      symbol: z.string().describe('The starting function/method name (required — the graph is keyed by name).'),
      line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("1-based definition line, for display (a result's startLine)."),
      direction: z
        .enum(['callees', 'callers'])
        .optional()
        .describe('callees (default): what it calls, downstream. callers: what calls it, upstream.'),
      depth: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(`How many levels to walk (default 3, max ${MAX_DEPTH}).`),
    },
    async ({ file, symbol, line, direction, depth }) => {
      const dir = direction ?? 'callees';
      const maxDepth = Math.min(depth ?? 3, MAX_DEPTH);
      const { abs, rel: relFile } = normalizeFileArg(file, workspaceRoot);
      const step = (f: string, n: string) =>
        dir === 'callers' ? store.getCallers(f, n) : store.getCallees(f, n);

      let nodeCount = 0;
      const expanded = new Set<string>(); // nodes already expanded (DAG/cycle guard)

      const build = (nFile: string, nLine: number, nName: string, level: number): FlowNode => {
        const node: FlowNode = { name: nName, file: toAbs(nFile), line: nLine, children: [] };
        const key = `${nFile}|${nName}`;

        if (level >= maxDepth) {
          if (step(nFile, nName).length > 0) node.truncated = 'depth';
          return node;
        }
        if (expanded.has(key)) {
          node.truncated = 'cycle'; // already shown higher up — don't re-expand
          return node;
        }
        expanded.add(key);

        for (const next of step(nFile, nName)) {
          if (nodeCount >= MAX_NODES) {
            node.truncated = 'cap';
            break;
          }
          nodeCount++;
          node.children.push(build(next.file, next.line, next.name, level + 1));
        }
        return node;
      };

      const root = build(relFile, line ?? 0, symbol, 0);

      // Nothing to walk — distinguish "graph not built" from "leaf node".
      if (root.children.length === 0 && !root.truncated) {
        const built = store.graphStats().edges > 0;
        const verb = dir === 'callers' ? 'callers' : 'callees';
        const text = built
          ? `${symbol} has no ${verb} in the call graph (it may be a leaf, or its edges ` +
            `aren't built yet — edits refetch on save).`
          : `The call graph hasn't been built yet, so there's no execution flow to walk. ` +
            `Build it once with SWE_BUILD_GRAPH=1 (VS Code + the extension must be running), ` +
            `or use trace_calls for a single live level.`;
        return { content: [{ type: 'text', text }] };
      }

      const arrow = dir === 'callers' ? 'called by' : 'calls';
      const lines: string[] = [`${symbol} (${abs}) — ${arrow}, depth ${maxDepth}:`];
      const render = (n: FlowNode, level: number) => {
        if (level > 0) {
          // These markers describe the node itself not being expanded further.
          const mark =
            n.truncated === 'depth'
              ? '  … (depth limit)'
              : n.truncated === 'cycle'
                ? '  ↑ (shown above)'
                : '';
          lines.push(`${'  '.repeat(level)}↳ ${n.name} (${n.file}:${n.line})${mark}`);
        }
        for (const c of n.children) render(c, level + 1);
        // `cap` means this node had more children than the node budget allowed.
        if (n.truncated === 'cap') {
          lines.push(`${'  '.repeat(level + 1)}… (node limit ${MAX_NODES} reached)`);
        }
      };
      render(root, 0);

      return {
        content: [{ type: 'text', text: lines.join('\n') }],
        structuredContent: { direction: dir, depth: maxDepth, nodes: nodeCount, root },
      };
    },
  );
}
