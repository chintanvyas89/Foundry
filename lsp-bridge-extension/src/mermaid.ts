// Mermaid diagram builders for the @codebase visualizations (Ph15). Pure — no
// vscode dependency — so the participant emits Mermaid text that VS Code chat
// renders natively (no bundled charting library), and these stay unit-testable.

export interface ModuleNode {
  module: string;
  files: number;
  dependsOn?: string[];
}

export interface FlowNodeLite {
  name: string;
  file?: string;
  line?: number;
  children?: FlowNodeLite[];
  truncated?: string;
}

const MAX_NODES = 40;

function baseName(path: string): string {
  const i = path.replace(/\\/g, '/').replace(/\/+$/, '').lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

// Mermaid node ids must be alphanumeric — assign a stable `nN` per key.
function makeIdFn(): (key: string) => string {
  const map = new Map<string, string>();
  return (key: string) => {
    let v = map.get(key);
    if (!v) {
      v = `n${map.size}`;
      map.set(key, v);
    }
    return v;
  };
}

// Quote a label and neutralize characters that break Mermaid.
function mermaidLabel(text: string): string {
  return '"' + text.replace(/"/g, "'").replace(/[\r\n]+/g, ' ').replace(/[<>|{}]/g, '') + '"';
}

// Module dependency graph (`graph LR`): directories as nodes (sized label by file
// count), edges = depends-on. Caps the largest N modules for readability.
export function moduleGraphMermaid(modules: ModuleNode[]): string {
  const sorted = [...modules].sort((a, b) => (b.files ?? 0) - (a.files ?? 0));
  const shown = sorted.slice(0, MAX_NODES);
  const inScope = new Set(shown.map((m) => m.module));
  const id = makeIdFn();
  const lines: string[] = ['graph LR'];
  for (const m of shown) {
    lines.push(`  ${id(m.module)}[${mermaidLabel(`${baseName(m.module) || m.module} (${m.files})`)}]`);
  }
  let edges = 0;
  for (const m of shown) {
    for (const dep of m.dependsOn ?? []) {
      if (!inScope.has(dep) || dep === m.module) continue;
      lines.push(`  ${id(m.module)} --> ${id(dep)}`);
      edges += 1;
    }
  }
  let caption = '';
  if (sorted.length > MAX_NODES) {
    caption += `\n\n> Showing the ${MAX_NODES} largest of ${sorted.length} modules.`;
  }
  if (edges === 0) {
    caption += '\n\n> No dependency edges yet — build the usages index (`SWE_BUILD_USAGES`) to draw them.';
  }
  return '```mermaid\n' + lines.join('\n') + '\n```' + caption;
}

// Call graph (`graph TD`) from a bounded execution-flow tree. Arrows always point
// caller → callee; for a `callers` tree the child calls the parent, so the edge
// is reversed. Dedupes nodes/edges and caps size.
export function callGraphMermaid(root: FlowNodeLite, direction: 'callers' | 'callees'): string {
  const id = makeIdFn();
  const keyOf = (n: FlowNodeLite) => `${n.name}@${n.file ?? ''}:${n.line ?? 0}`;
  const lines: string[] = ['graph TD'];
  const nodes = new Set<string>();
  const seenEdges = new Set<string>();
  let truncated = Boolean(root.truncated);

  const emit = (n: FlowNodeLite): boolean => {
    const k = keyOf(n);
    if (nodes.has(k)) return true;
    if (nodes.size >= MAX_NODES) {
      truncated = true;
      return false;
    }
    nodes.add(k);
    lines.push(`  ${id(k)}[${mermaidLabel(n.name)}]`);
    return true;
  };

  emit(root);
  const walk = (n: FlowNodeLite): void => {
    for (const child of n.children ?? []) {
      if (child.truncated) truncated = true;
      if (!emit(child)) return;
      const [from, to] = direction === 'callers' ? [child, n] : [n, child];
      const e = `${id(keyOf(from))}->${id(keyOf(to))}`;
      if (!seenEdges.has(e)) {
        seenEdges.add(e);
        lines.push(`  ${id(keyOf(from))} --> ${id(keyOf(to))}`);
      }
      walk(child);
    }
  };
  walk(root);

  const caption = truncated ? '\n\n> Graph truncated for readability.' : '';
  return '```mermaid\n' + lines.join('\n') + '\n```' + caption;
}
