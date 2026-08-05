import * as vscode from 'vscode';
import type { SearchClient } from './searchClient';

// Deterministic plan-context builder shared by the @codebase /plan command
// (chatParticipant.ts) and the model-invoked foundry_plan Language Model tool
// (languageModelTools.ts). Lives in its own module so both can import it without
// a circular dependency (languageModelTools ↔ chatParticipant). It depends only
// on vscode + SearchClient — no participant internals — and makes NO model call:
// it assembles a read-only context pack the caller's model reasons over.

// The instruction preamble that turns the gathered context into a plan. Shared so
// the /plan command and the foundry_plan tool produce the same shape of plan.
export const PLAN_PREAMBLE = [
  'You are @codebase, planning an implementation change for the user’s CURRENT VS',
  'Code workspace. Workspace context is provided below: an index overview, the',
  'module architecture, the project’s own docs, the MOST RELEVANT CODE WITH FULL',
  'BODIES, the CALL SITES / USAGES of the key symbols (use these to list every',
  'file the change impacts — clients, UI, other callers — not just the definition',
  'site), any RELEVANT CONFIG (structured .yml/.json — routes, fields, services,',
  'module dependencies — authoritative facts that are NOT in the code search), and',
  'the project’s build/test manifests. Base every claim on that context',
  'and the actual code — do not guess from memory. If a detail (a function’s',
  'determinants, a runtime mode) is not shown in the context, say so rather than',
  'inventing it. Use ONLY the build/test commands evidenced by the provided',
  'manifests, scripts, and test files (whatever the ecosystem — npm, pytest, go',
  'test, cargo, make, gradle, …); NEVER invent a build or test command that is not',
  'shown. Reason about the runtime/process model, config, and concurrency from the',
  'code and docs, not just individual functions.',
  '\n\nRespond with ONLY the following markdown, filling every section:',
  '\n## Plan',
  '\n**Context:** current state in 1–2 lines.',
  '\n**Assumptions & open questions:** anything inferred or needing confirmation.',
  '\n**Files to change:** a bullet per file as `path` — what changes and why.',
  '\n**Steps:** a numbered, ordered list of concrete edits.',
  '\n**Risks / staleness:** what could break or go stale — concurrency, caching,',
  'invalidation, cross-process/query-only state, re-index coupling.',
  '\n**Alternatives / existing mechanisms:** simpler options or existing features',
  'that may already cover this; say plainly if the change may be unnecessary.',
  '\n**Verify:** the exact test/build commands (from the real conventions above) and a manual check.',
  '\n\nDo NOT write the full code or edit files, and do NOT call any tools — propose',
  'the plan only, grounded in the provided context.',
].join(' ');

// Assemble a rich, deterministic context pack for /plan. Everything here is
// language-agnostic: index overview, module architecture, the most relevant code
// with FULL bodies, the project's OWN docs (README/ARCHITECTURE — where any repo
// describes how it builds/runs), and its build/test manifests. All read-only, no
// project-specific assumptions — the model adapts to whatever ecosystem it finds.
export async function gatherPlanContext(
  client: SearchClient,
  prompt: string,
  output: vscode.OutputChannel,
): Promise<{ seed: string; target: SearchHit | null }> {
  const parts: string[] = [];

  const add = async (label: string, mcpName: string, args: Record<string, unknown>): Promise<void> => {
    try {
      const { text } = await client.callTool(mcpName, args);
      if (text && text.trim()) parts.push(`#### ${label}\n${text.trim()}`);
    } catch (err) {
      output.appendLine(`[chat/plan] ${mcpName} failed: ${String(err)}`);
    }
  };

  await add('Index overview', 'repo_overview', {});
  await add('Architecture (modules)', 'architecture_overview', {});

  const docs = await gatherProjectDocs(output);
  if (docs) parts.push(docs);

  // FULL bodies of the most relevant code — the key upgrade over lean signatures.
  // Capture the structured hits so the call-site pass can trace their consumers.
  let hits: SearchHit[] = [];
  try {
    const { text, structured } = await client.callTool('semantic_search', {
      query: prompt,
      detail: 'full',
      topK: 6,
      context: true,
    });
    if (text && text.trim()) parts.push(`#### Most relevant code (full bodies)\n${text.trim()}`);
    const results = (structured as { results?: SearchHit[] } | undefined)?.results;
    if (Array.isArray(results)) hits = results;
  } catch (err) {
    output.appendLine(`[chat/plan] semantic_search failed: ${String(err)}`);
  }

  // Call-site / impact pass: usages of the top matched symbols, so the plan
  // covers downstream consumers (clients, UI) — not just the definition site.
  // find_usages runs against the local bridge/index: zero model credits.
  const callSites = await gatherCallSites(client, hits, output);
  if (callSites) parts.push(callSites);

  // Relevant config: structured config facts (routes, fields, services, module
  // dependencies — any .yml/.json) matching the request. Config is embedding-free,
  // so it's absent from the semantic_search above; this grounds plans that touch
  // config. Only included when there are actual hits (so an unbuilt config index
  // or a code-only request adds nothing). Runs against the local index — no credits.
  try {
    const { text, structured } = await client.callTool('search_config', {
      query: prompt,
      limit: 8,
    });
    const cfg = (structured as { results?: unknown[] } | undefined)?.results;
    if (Array.isArray(cfg) && cfg.length > 0 && text && text.trim()) {
      parts.push(`#### Relevant config\n${text.trim()}`);
    }
  } catch (err) {
    output.appendLine(`[chat/plan] search_config failed: ${String(err)}`);
  }

  const conventions = await gatherConventions(output);
  if (conventions) parts.push(conventions);

  // The top hit with a concrete symbol is the change target — used to draw the
  // change-impact (callers) diagram after the plan.
  const target = hits.find((h) => h?.symbol && h.file && h.startLine) ?? null;

  const seed =
    parts.length === 0
      ? ''
      : 'Auto-gathered workspace context for planning (read before proposing changes):\n\n' +
        parts.join('\n\n');
  return { seed, target };
}

// A structured hit from semantic_search (the fields we use to trace usages).
export interface SearchHit {
  file?: string;
  symbol?: string | null;
  startLine?: number;
}

// Trace who consumes the top matched symbols via find_usages, so a plan accounts
// for downstream impact (clients, UI, other call sites) rather than only the
// definition file. Runs entirely against the local bridge/persisted index — no
// model calls, so it adds impact coverage without extra credits.
async function gatherCallSites(
  client: SearchClient,
  hits: SearchHit[],
  output: vscode.OutputChannel,
): Promise<string> {
  const blocks: string[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (blocks.length >= 3) break; // cap: top few symbols keep tokens bounded
    if (!h || !h.symbol || !h.file || !h.startLine) continue;
    if (seen.has(h.symbol)) continue;
    seen.add(h.symbol);
    try {
      const { text } = await client.callTool('find_usages', {
        file: h.file,
        line: h.startLine,
        symbol: h.symbol,
      });
      // Skip the "bridge/index unavailable" message and empty results.
      if (text && text.trim() && !/unavailable/i.test(text) && !/\(none\)/.test(text)) {
        blocks.push(`\`${h.symbol}\` (defined in ${baseName(h.file)}):\n${head(text.trim(), 1500)}`);
      }
    } catch (err) {
      output.appendLine(`[chat/plan] find_usages(${h.symbol}) failed: ${String(err)}`);
    }
  }
  return blocks.length
    ? '#### Call sites / usages of key symbols (downstream impact)\n' + blocks.join('\n\n')
    : '';
}

// Directories that never hold source worth reading — excluded from every scan.
const SCAN_EXCLUDE = '**/{node_modules,dist,build,out,target,.venv,venv,vendor,.git,bin,obj}/**';

// Pull the top of the project's own docs — README / ARCHITECTURE / CONTRIBUTING.
// Every repo, in any language, documents how it builds, runs, and is structured
// here; this is where process/runtime facts live, so the model learns them from
// the project itself rather than any hardcoded, repo-specific knowledge.
async function gatherProjectDocs(output: vscode.OutputChannel): Promise<string> {
  try {
    const uris = await vscode.workspace.findFiles(
      '**/{README.md,README.rst,README.txt,README,ARCHITECTURE.md,CONTRIBUTING.md}',
      SCAN_EXCLUDE,
      10,
    );
    // Prefer shallow (repo-root) docs, and lead with the README.
    const sorted = uris
      .map((u) => ({ uri: u, rel: vscode.workspace.asRelativePath(u) }))
      .sort((a, b) => {
        const depth = a.rel.split('/').length - b.rel.split('/').length;
        if (depth !== 0) return depth;
        const ar = /readme/i.test(a.rel) ? 0 : 1;
        const br = /readme/i.test(b.rel) ? 0 : 1;
        return ar - br;
      });
    const chosen = sorted.slice(0, 2);
    const blocks: string[] = [];
    for (const { uri, rel } of chosen) {
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        blocks.push(`\`${rel}\` (excerpt):\n${head(raw, 1800)}`);
      } catch {
        /* skip unreadable doc */
      }
    }
    return blocks.length ? '#### Project docs\n' + blocks.join('\n\n') : '';
  } catch (err) {
    output.appendLine(`[chat/plan] docs scan failed: ${String(err)}`);
    return '';
  }
}

// Common build/test manifest filenames across ecosystems. Their presence + a
// short excerpt tells the model the real build/test commands to use, whatever
// the language — no assumption of npm/Node.
const MANIFEST_GLOB =
  '**/{package.json,pyproject.toml,setup.cfg,setup.py,tox.ini,pytest.ini,noxfile.py,' +
  'go.mod,Cargo.toml,pom.xml,build.gradle,build.gradle.kts,build.sbt,Gemfile,' +
  'composer.json,mix.exs,Makefile,justfile,Taskfile.yml,Taskfile.yaml,CMakeLists.txt}';

// Read the workspace's real build/test conventions so the plan uses actual
// commands (npm / pytest / go test / cargo / make / …) instead of inventing one,
// plus a language-neutral sample of test-file paths to reveal the runner.
async function gatherConventions(output: vscode.OutputChannel): Promise<string> {
  const sections: string[] = [];
  const seen = new Set<string>();

  const collect = async (pattern: string): Promise<void> => {
    try {
      const uris = await vscode.workspace.findFiles(pattern, SCAN_EXCLUDE, 12);
      for (const uri of uris) {
        const rel = vscode.workspace.asRelativePath(uri);
        if (seen.has(rel) || sections.length >= 10) continue;
        seen.add(rel);
        try {
          const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
          const excerpt = manifestExcerpt(rel, raw);
          if (excerpt) sections.push(`\`${rel}\`:\n${excerpt}`);
        } catch {
          /* skip unreadable/malformed manifest */
        }
      }
    } catch (err) {
      output.appendLine(`[chat/plan] manifest scan failed (${pattern}): ${String(err)}`);
    }
  };

  await collect(MANIFEST_GLOB);
  await collect('**/*.csproj');

  // Test files — language-neutral: common test dirs, plus name patterns that
  // cover pytest (test_*.py), Go (*_test.go), JS/TS (*.test.ts), JUnit (*Test.java), etc.
  try {
    const tests = await vscode.workspace.findFiles(
      '**/{test,tests,__tests__,spec,specs,e2e}/**/*.*',
      SCAN_EXCLUDE,
      60,
    );
    const byName = await vscode.workspace.findFiles(
      '**/{test_*,*_test,*.test,*.spec,*_spec,*Test,*Tests,*Spec}.*',
      SCAN_EXCLUDE,
      60,
    );
    const names = [...tests, ...byName]
      .map((u) => vscode.workspace.asRelativePath(u))
      .filter((p) => /(^|\/)(tests?|specs?|e2e)(\/|$)|[._-](test|spec)s?\.|(^|\/)test_/i.test(p));
    const unique = [...new Set(names)].sort().slice(0, 20);
    if (unique.length) sections.push('Test files (naming / runner convention):\n  ' + unique.join('\n  '));
  } catch (err) {
    output.appendLine(`[chat/plan] test scan failed: ${String(err)}`);
  }

  return sections.length ? '#### Build / test conventions\n' + sections.join('\n\n') : '';
}

// Ecosystem-aware excerpt of a manifest: pull the build/test-relevant bit
// (package.json scripts, Makefile/Taskfile targets) or a truncated head.
function manifestExcerpt(rel: string, raw: string): string {
  const base = baseName(rel).toLowerCase();
  if (base === 'package.json') {
    try {
      const json = JSON.parse(raw) as { scripts?: Record<string, string> };
      const scripts = json.scripts ? Object.entries(json.scripts) : [];
      return scripts.length ? 'scripts:\n  ' + scripts.map(([k, v]) => `${k}: ${v}`).join('\n  ') : '(no scripts)';
    } catch {
      return head(raw, 600);
    }
  }
  if (base === 'makefile' || base === 'justfile' || base.startsWith('taskfile')) {
    const targets = raw
      .split('\n')
      .filter((l) => /^[A-Za-z0-9][\w.\/-]*:\s*(#.*)?$|^[A-Za-z0-9][\w.\/-]*:\s+[^=]/.test(l))
      .slice(0, 30);
    return targets.length ? 'targets:\n  ' + targets.map((t) => t.trim()).join('\n  ') : head(raw, 800);
  }
  return head(raw, 900);
}

export function baseName(path: string): string {
  const i = path.replace(/\\/g, '/').lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

// Truncate to n chars on a line boundary, marking the cut. Shared with the
// participant's tool-result trimming.
export function head(text: string, n: number): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= n) return trimmed;
  const cut = trimmed.slice(0, n);
  const lastNl = cut.lastIndexOf('\n');
  return (lastNl > n * 0.5 ? cut.slice(0, lastNl) : cut) + '\n… (truncated)';
}
