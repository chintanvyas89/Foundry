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

function renderModule(store: VectorStore, map: ArchMap, m: ModuleInfo): string {
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
  lines.push(`## ${m.module} — module${role ? ` · ${role}` : ''}`);
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

// Resolve a user-supplied module argument (a directory path, a partial path, or
// just a directory name) to one of the known modules. Returns the match, or a
// list of candidates when it's ambiguous / unknown.
function resolveModule(
  map: ArchMap,
  raw: string,
): { match?: ModuleInfo; candidates: string[] } {
  const q = raw.replace(/\\/g, '/').replace(/\/+$/, '').trim();
  const byKey = map.modules.find((m) => m.module === q);
  if (byKey) return { match: byKey, candidates: [] };

  // If they passed a file path, try its directory.
  const asDir = dirOf(q);
  const byDir = map.modules.find((m) => m.module === asDir);
  if (byDir) return { match: byDir, candidates: [] };

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
        const { match, candidates } = resolveModule(map, module);
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
