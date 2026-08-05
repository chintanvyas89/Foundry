import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { VectorStore } from '../storage/store.js';

// architecture_overview — a deterministic, offline architecture map assembled
// from the already-built indexes (symbols, usages, call graph). No embedder, no
// bridge, no schema change, no re-index: it aggregates persisted tables into a
// module-level view (modules = directories) and hands the LLM a structured map
// to narrate.
//
//   - No `module` argument → whole-repo map: modules by size, each module's
//     dependencies / dependents, call-graph entry points, reference hotspots.
//   - `module="<path>"` → drill into one module: its files, key symbols, entry
//     points, which modules it depends on / is used by, and its local hotspots.

// Non-callable/leaf kinds rank below structural ones when picking "key symbols".
const KIND_RANK: Record<string, number> = {
  Class: 0,
  Interface: 0,
  Struct: 0,
  Enum: 1,
  Namespace: 1,
  Module: 1,
  Function: 2,
  Method: 3,
  Constructor: 3,
  Constant: 4,
  Variable: 5,
  Field: 5,
  Property: 5,
  TypeParameter: 6,
};

// A light, generic role hint from the module's directory basename. Purely a
// heuristic to seed the LLM's narration — omitted when nothing matches.
const ROLE_HINTS: Record<string, string> = {
  tools: 'tool handlers',
  tool: 'tool handlers',
  handlers: 'request handlers',
  controllers: 'request handlers',
  routes: 'routing',
  middleware: 'middleware',
  storage: 'storage / persistence',
  store: 'storage / persistence',
  db: 'database access',
  database: 'database access',
  models: 'data models',
  services: 'services',
  indexing: 'indexing pipeline',
  index: 'indexing',
  embedding: 'embeddings',
  embeddings: 'embeddings',
  chunking: 'chunking',
  search: 'search / retrieval',
  retrieval: 'search / retrieval',
  api: 'API layer',
  cli: 'command-line entry',
  server: 'server',
  client: 'client',
  config: 'configuration',
  utils: 'utilities',
  util: 'utilities',
  lib: 'library code',
  components: 'UI components',
  test: 'tests',
  tests: 'tests',
  __tests__: 'tests',
};

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '(root)' : path.slice(0, i);
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

// Short label for a module (its directory basename), used in dep/used-by lists
// so they read as "storage, chunking" instead of full paths.
function shortName(module: string): string {
  return module === '(root)' ? '(root)' : baseName(module);
}

interface ModuleInfo {
  module: string;
  files: string[];
  dependsOn: Map<string, number>; // provider module → total refs into it
  usedBy: Set<string>; // consumer modules
}

interface ArchMap {
  modules: ModuleInfo[];
  entryPoints: string[]; // "name (file)" call-graph roots
  hotspots: Array<{ name: string; file: string; refs: number }>;
  hasSymbols: boolean;
  hasUsages: boolean;
  hasGraph: boolean;
}

function buildMap(store: VectorStore): ArchMap {
  const hasSymbols = store.symbolStats().symbols > 0;
  const hasUsages = store.usageStats().refs > 0;
  const hasGraph = store.graphStats().edges > 0;

  // Modules = directories of every indexed file.
  const filesByModule = new Map<string, string[]>();
  for (const f of store.listIndexedFiles()) {
    const m = dirOf(f);
    const arr = filesByModule.get(m);
    if (arr) arr.push(f);
    else filesByModule.set(m, [f]);
  }

  const info = new Map<string, ModuleInfo>();
  for (const [module, files] of filesByModule) {
    files.sort();
    info.set(module, { module, files, dependsOn: new Map(), usedBy: new Set() });
  }

  // Module → module edges from the usages index: a reference in refFile that
  // resolves to a definition in defFile means module(refFile) depends on
  // module(defFile). Roll cross-module edges up with reference counts.
  if (hasUsages) {
    for (const e of store.refEdges()) {
      const from = dirOf(e.refFile); // consumer
      const to = dirOf(e.defFile); // provider
      if (from === to) continue;
      const consumer = info.get(from);
      const provider = info.get(to);
      if (!consumer || !provider) continue;
      consumer.dependsOn.set(to, (consumer.dependsOn.get(to) ?? 0) + e.count);
      provider.usedBy.add(from);
    }
  }

  // Entry points = call-graph roots: symbols that call others but are never
  // called themselves.
  const entryPoints: string[] = [];
  if (hasGraph) {
    const edges = store.callEdges();
    const callees = new Set<string>();
    for (const e of edges) callees.add(`${e.toFile}|${e.toName}`);
    const seen = new Set<string>();
    for (const e of edges) {
      const key = `${e.fromFile}|${e.fromName}`;
      if (callees.has(key) || seen.has(key)) continue;
      seen.add(key);
      entryPoints.push(`${e.fromName} (${e.fromFile})`);
    }
    entryPoints.sort();
  }

  const hotspots = hasUsages
    ? store.symbolHotspots(200).map((h) => ({ name: h.name, file: h.file, refs: h.refs }))
    : [];

  const modules = [...info.values()].sort((a, b) => b.files.length - a.files.length);
  return { modules, entryPoints, hotspots, hasSymbols, hasUsages, hasGraph };
}

// Rank a module's declared symbols by (inbound refs desc, structural kind,
// name) and return the top few as "key symbols".
function keySymbols(
  store: VectorStore,
  files: Set<string>,
  refsByKey: Map<string, number>,
  limit: number,
): Array<{ name: string; kind: string; refs: number }> {
  const rows = store.allSymbolRows().filter((r) => files.has(r.file));
  const best = new Map<string, { name: string; kind: string; refs: number }>();
  for (const r of rows) {
    const refs = refsByKey.get(`${r.file}|${r.name}`) ?? 0;
    const prev = best.get(r.name);
    if (!prev || refs > prev.refs || (refs === prev.refs && rank(r.kind) < rank(prev.kind))) {
      best.set(r.name, { name: r.name, kind: r.kind, refs });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.refs - a.refs || rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function rank(kind: string): number {
  return KIND_RANK[kind] ?? 4;
}

function roleHint(module: string): string | null {
  return ROLE_HINTS[shortName(module).toLowerCase()] ?? null;
}

function cap<T>(items: T[], n: number, render: (x: T) => string): string {
  if (items.length === 0) return '(none)';
  const shown = items.slice(0, n).map(render).join(', ');
  return items.length > n ? `${shown} (+${items.length - n} more)` : shown;
}

function renderRepo(map: ArchMap): string {
  const lines: string[] = [];
  lines.push(
    `Architecture overview — ${map.modules.length} module(s), from the persisted ` +
      `symbols/usages/call-graph indexes.`,
  );
  if (!map.hasSymbols || !map.hasUsages || !map.hasGraph) {
    const missing = [
      !map.hasSymbols ? 'symbols' : null,
      !map.hasUsages ? 'usages' : null,
      !map.hasGraph ? 'call graph' : null,
    ].filter(Boolean);
    lines.push(
      `(partial — not built: ${missing.join(', ')}. ` +
        `Dependencies/hotspots need usages; entry points need the call graph.)`,
    );
  }

  lines.push('', 'Modules (by file count):');
  for (const m of map.modules.slice(0, 20)) {
    const role = roleHint(m.module);
    const deps = [...m.dependsOn.entries()].sort((a, b) => b[1] - a[1]).map(([mod]) => shortName(mod));
    const used = [...m.usedBy].map(shortName).sort();
    const parts = [
      `${m.module} (${m.files.length} file${m.files.length === 1 ? '' : 's'})`,
      role ? `· ${role}` : '',
      deps.length ? `· depends on: ${cap(deps, 5, (x) => x)}` : '',
      used.length ? `· used by: ${cap(used, 5, (x) => x)}` : '',
    ].filter(Boolean);
    lines.push(`- ${parts.join(' ')}`);
  }
  if (map.modules.length > 20) lines.push(`  … and ${map.modules.length - 20} more modules.`);

  if (map.hasGraph) {
    lines.push('', `Entry points (call-graph roots): ${cap(map.entryPoints, 12, (e) => e.split(' (')[0])}`);
  }
  if (map.hasUsages) {
    lines.push(`Hotspots (most-referenced symbols): ${cap(map.hotspots, 10, (h) => `${h.name} (${h.refs})`)}`);
  }
  lines.push('', 'Pass module="<path or name>" to drill into one module.');
  return lines.join('\n');
}

function renderModule(store: VectorStore, map: ArchMap, m: ModuleInfo, label = 'module'): string {
  const files = new Set(m.files);
  const refsByKey = new Map<string, number>();
  for (const h of store.symbolHotspots(5000)) refsByKey.set(`${h.file}|${h.name}`, h.refs);

  const keys = keySymbols(store, files, refsByKey, 12);
  const localHot = map.hotspots.filter((h) => files.has(h.file)).slice(0, 8);

  // Entry points that live in this module.
  const entries = map.entryPoints
    .filter((e) => {
      const file = e.slice(e.indexOf('(') + 1, e.length - 1);
      return files.has(file);
    })
    .map((e) => e.split(' (')[0]);

  const deps = [...m.dependsOn.entries()].sort((a, b) => b[1] - a[1]);
  const used = [...m.usedBy].sort();
  const role = roleHint(m.module);

  const lines: string[] = [];
  lines.push(`## ${m.module} — ${label}${role ? ` · ${role}` : ''}`);
  lines.push('', `Files (${m.files.length}): ${cap(m.files.map(baseName), 12, (x) => x)}`);
  if (map.hasSymbols) {
    lines.push(
      `Key symbols: ${cap(keys, 12, (k) => `${k.name} (${k.kind}${k.refs ? `, ${k.refs} refs` : ''})`)}`,
    );
  }
  if (map.hasGraph) lines.push(`Entry points: ${cap(entries, 10, (x) => x)}`);
  if (map.hasUsages) {
    lines.push(
      `Depends on (modules): ${cap(deps, 8, ([mod, c]) => `${shortName(mod)} (${c})`)}`,
      `Used by (modules): ${cap(used, 8, shortName)}`,
      `Hotspots here: ${cap(localHot, 8, (h) => `${h.name} (${h.refs})`)}`,
    );
  }
  return lines.join('\n');
}

type ResolveResult = {
  match?: ModuleInfo; // a single leaf module
  subtree?: ModuleInfo[]; // a directory with sub-modules (recursive drilldown)
  subtreeRoot?: string;
  candidates: string[];
};

// Resolve a user-supplied module argument to known module(s). Handles:
//   - a directory path (relative OR fully-qualified/absolute — index paths are
//     workspace-relative, so we peel leading segments until a relative suffix
//     matches the index);
//   - a file path (its directory is used);
//   - a parent directory that only contains sub-directories → its whole SUBTREE
//     (recursive drilldown), not "not found";
//   - a bare directory name (partial match).
// Returns a single match, a subtree, or candidates when ambiguous/unknown.
function resolveModule(map: ArchMap, raw: string): ResolveResult {
  const q = raw.replace(/\\/g, '/').replace(/\/+$/, '').trim();
  if (!q) return { candidates: [] };

  // Peel leading path segments so an absolute/fully-qualified path
  // (/home/dev/proj/modules/custom/market) reduces to the relative key the index
  // stores (modules/custom/market). The full path is tried first (i=0), so the
  // longest — most specific — matching suffix wins.
  const segs = q.split('/').filter(Boolean);
  for (let i = 0; i < Math.max(segs.length, 1); i++) {
    const rel = segs.slice(i).join('/');
    if (!rel) break;
    const direct = resolveRelative(map, rel);
    if (direct.match || direct.subtree) return direct;
    // A file path: fall back to its directory.
    const asDir = dirOf(rel);
    if (asDir !== rel && asDir !== '(root)') {
      const viaDir = resolveRelative(map, asDir);
      if (viaDir.match || viaDir.subtree) return viaDir;
    }
  }

  return resolveByName(map, q);
}

// Match a workspace-relative directory against the module keys: an exact leaf, a
// single descendant, or a parent whose subtree spans several modules.
function resolveRelative(map: ArchMap, rel: string): ResolveResult {
  const under = map.modules.filter((m) => m.module === rel || m.module.startsWith(`${rel}/`));
  if (under.length === 0) return { candidates: [] };
  if (under.length === 1) return { match: under[0], candidates: [] };
  return { subtree: under, subtreeRoot: rel, candidates: [] };
}

// Last-resort name match (a bare directory name like "storage").
function resolveByName(map: ArchMap, q: string): ResolveResult {
  const ql = q.toLowerCase();
  const partial = map.modules.filter(
    (m) => m.module.toLowerCase().endsWith(`/${ql}`) || shortName(m.module).toLowerCase() === ql,
  );
  if (partial.length === 1) return { match: partial[0], candidates: [] };
  if (partial.length > 1) return { candidates: partial.map((m) => m.module) };

  const contains = map.modules.filter((m) => m.module.toLowerCase().includes(ql));
  if (contains.length === 1) return { match: contains[0], candidates: [] };
  return { candidates: contains.map((m) => m.module) };
}

// Roll a subtree of modules up into one aggregate: union of files, and cross-module
// edges that leave the subtree (intra-subtree edges are internal, so dropped).
function aggregateSubtree(root: string, modules: ModuleInfo[]): ModuleInfo {
  const inSubtree = new Set(modules.map((m) => m.module));
  const agg: ModuleInfo = { module: root, files: [], dependsOn: new Map(), usedBy: new Set() };
  for (const m of modules) {
    agg.files.push(...m.files);
    for (const [dep, c] of m.dependsOn) {
      if (!inSubtree.has(dep)) agg.dependsOn.set(dep, (agg.dependsOn.get(dep) ?? 0) + c);
    }
    for (const u of m.usedBy) if (!inSubtree.has(u)) agg.usedBy.add(u);
  }
  agg.files.sort();
  return agg;
}

// Recursive drilldown: an aggregated summary of the whole subtree, then the list
// of child sub-modules to drill into further.
function renderSubtree(store: VectorStore, map: ArchMap, root: string, modules: ModuleInfo[]): string {
  const agg = aggregateSubtree(root, modules);
  const summary = renderModule(store, map, agg, `subtree · ${modules.length} submodules`);

  const children = [...modules].sort((a, b) => b.files.length - a.files.length);
  const lines = [summary, '', `### Submodules (${modules.length})`];
  for (const c of children.slice(0, 30)) {
    const rel = c.module === root ? '(files directly here)' : c.module.slice(root.length + 1);
    const extDeps = [...c.dependsOn.keys()].filter((d) => !d.startsWith(`${root}/`) && d !== root).length;
    lines.push(
      `- ${rel} (${c.files.length} file${c.files.length === 1 ? '' : 's'})` +
        (extDeps ? ` · depends on ${extDeps} external module(s)` : ''),
    );
  }
  if (modules.length > 30) lines.push(`  … and ${modules.length - 30} more submodules.`);
  return lines.join('\n');
}

export function registerArchitectureOverviewTool(server: McpServer, store: VectorStore): void {
  server.tool(
    'architecture_overview',
    'Get a deterministic, offline architecture map of the workspace, assembled from ' +
      'the persisted symbols/usages/call-graph indexes (no LLM, no re-index). With no ' +
      'argument it returns a whole-repo map: modules (directories) ranked by size, each ' +
      "module's dependencies and dependents, call-graph entry points, and reference " +
      'hotspots. Pass module="<path or name>" to drill into one module (its files, key ' +
      'symbols, entry points, dependencies, dependents, and local hotspots). Use it to ' +
      'orient on an unfamiliar codebase or to answer "how is this organized / what are ' +
      'the main pieces / what depends on what". Build the symbols, usages, and call-graph ' +
      'indexes first for full detail (see repo_overview for what is built).',
    {
      module: z
        .string()
        .optional()
        .describe(
          'Optional module to drill into: a directory path (e.g. "src/storage"), a ' +
            'file path (its directory is used), or just a directory name (e.g. "storage").',
        ),
    },
    async ({ module }) => {
      const map = buildMap(store);

      if (map.modules.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No files are indexed yet, so there is no architecture to summarize.',
            },
          ],
          structuredContent: { modules: [], scope: 'repo' },
        };
      }

      if (module && module.trim()) {
        const { match, subtree, subtreeRoot, candidates } = resolveModule(map, module);

        // Recursive drilldown: a parent directory spanning several sub-modules.
        if (subtree && subtreeRoot) {
          const agg = aggregateSubtree(subtreeRoot, subtree);
          const text = renderSubtree(store, map, subtreeRoot, subtree);
          return {
            content: [{ type: 'text', text }],
            structuredContent: {
              scope: 'module',
              matched: true,
              subtree: true,
              module: subtreeRoot,
              files: agg.files,
              submodules: subtree.map((m) => ({ module: m.module, files: m.files.length })),
              dependsOn: [...agg.dependsOn.entries()].map(([mod, count]) => ({ module: mod, count })),
              usedBy: [...agg.usedBy],
            },
          };
        }

        if (!match) {
          const hint = candidates.length
            ? `Did you mean: ${candidates.slice(0, 10).join(', ')}?`
            : `Known modules include: ${map.modules.slice(0, 10).map((m) => m.module).join(', ')}.`;
          return {
            content: [{ type: 'text', text: `No module matched "${module}". ${hint}` }],
            structuredContent: { scope: 'module', matched: false, candidates },
          };
        }
        const text = renderModule(store, map, match);
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            scope: 'module',
            matched: true,
            module: match.module,
            files: match.files,
            dependsOn: [...match.dependsOn.entries()].map(([mod, count]) => ({ module: mod, count })),
            usedBy: [...match.usedBy],
          },
        };
      }

      const text = renderRepo(map);
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          scope: 'repo',
          moduleCount: map.modules.length,
          modules: map.modules.map((m) => ({
            module: m.module,
            files: m.files.length,
            dependsOn: [...m.dependsOn.keys()],
            usedBy: [...m.usedBy],
          })),
          entryPoints: map.entryPoints.slice(0, 30),
          hotspots: map.hotspots.slice(0, 20),
          built: { symbols: map.hasSymbols, usages: map.hasUsages, graph: map.hasGraph },
        },
      };
    },
  );
}
