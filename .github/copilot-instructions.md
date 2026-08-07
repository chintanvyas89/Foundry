# Copilot instructions

## Mandatory workflow for implementation tasks

For any task that involves implementing, changing, debugging, or extending
existing behavior, resolve code questions through this workspace's **local Foundry
index FIRST** — it is faster and uses **far fewer tokens** than reading or
searching files directly.

In **agent mode** these are the `foundry_*` Language Model tools; in `@codebase`
chat / MCP they are the bare names shown in parentheses. Same index either way.

Required behavior:
1. Understand existing implementation by MEANING with `foundry_semanticSearch`
   (`#foundryCodebase` / `semantic_search`) — "where is X handled", "what does Y".
   Already know the exact symbol name (function/class/type/const)? Use
   `foundry_searchSymbol` (`search_symbol`) instead — it's an exact lookup.
2. For execution flow and change impact, use `foundry_traceCalls` (`trace_calls`),
   `foundry_showExecutionFlow`, and `foundry_findUsages` (`find_usages`) to see
   callers/callees and every use site BEFORE editing — not a text search for the name.
3. To read code, use `foundry_readFile` (`read_file`) TWO-PASS — outline first
   (pass just `file`), then the specific body you need (`symbol=`) — rather than
   reading whole files.
4. For config in `.yml`/`.json` (routes, fields, services, module dependencies)
   use `foundry_searchConfig` (`search_config`) — config is never embedded, so it
   is NOT in semantic search.
5. Only open a file directly when you are about to EDIT it. Reading a file you are
   editing is fine; using direct file reads or the built-in codebase/text search
   to EXPLORE the codebase is **not** — route exploration through the tools above.

This applies even when the user asks for a direct implementation request such as
"implement X" or "fix Y"; in those cases, still inspect the current code paths
through the Foundry tools before editing. Need to (re)plan a change first? Use
`foundry_plan` — it returns a grounded context pack plus a plan template.

## Finding code in this workspace

When you need to locate code, understand where functionality lives, or find code
related to a request — e.g. "where is X handled?", "what code does Y?", or "find
something similar to Z" — **use the semantic-search workflow first**, before
reading files individually or grepping.

Default workflow for workspace exploration:
1. Use semantic_search to find the most relevant symbols or functions by meaning.
2. If the request is about execution flow, call trace_calls on the relevant symbol
   to see callers and callees.
3. Only after that, read the specific files or use targeted text search when the
   semantic results are too broad or incomplete.

Semantic search does a local, offline search over this workspace and returns the
most relevant functions/classes ranked by meaning, each with its file path and
line range. Use its results to jump straight to the right files, then open only
those files for detail. Fall back to reading/searching files directly only if the
semantic-search workflow does not surface what you need.

This is faster and uses far less context than scanning the codebase file by file.

## Looking up a known symbol

When you already know the exact identifier — a specific function, class, method,
or a non-callable declaration like an interface/enum/type/constant name (e.g.
`VectorStore`, `getUserById`, `CallGraphNode`) — use **search_symbol** (a direct
name lookup, ranked exact > prefix > substring) instead of semantic_search, which
is weaker at exact names. It covers callables (with their code) and, once the
symbol table is built, non-callable declarations (shown with their kind and
location). Use semantic_search when you know *what the code does* but not what
it's called; use search_symbol when you know the name. The two already
complement each other: semantic_search auto-probes the symbol table for
compound-identifier candidates in a multi-word query (e.g. "xyz block" also
checks for `xyzBlock`), so a query mixing meaning with a likely identifier
benefits from both without you calling search_symbol separately — and a
multi-word query is no longer diluted by a common word one part of it happens
to share with thousands of other chunks.

For a naming-CONVENTION query you can't express as one fragment — "every
`get*Async` method", "all `legacy_` handlers" — pass **`regex`** instead of
`name` (exactly one of the two; matched case-insensitively against every
indexed symbol name, e.g. `^get.*Async$`, `^legacy_`).

## Reading results efficiently

`semantic_search` returns **compact signatures by default** — each hit is a
symbol, `file:line` range, score, and one-line signature, not the whole function.
Triage from these: they're usually enough to know which hit you want. When you
need a hit's actual code, do NOT re-read the file blindly — call semantic_search
again with `expand=[n,…]` using the result NUMBERS (no need to repeat the query);
it returns just those full bodies. Use `detail="full"` only when you genuinely
need every result's body. This keeps context small.

When you need to know how a hit fits into the codebase — its enclosing type, who
calls it, what it calls, which tests cover it — pass **`context=true`** to
`semantic_search`. Each hit is then annotated with a one-line summary
(`in ParentClass · calls: … · called by: … · tests: …`) drawn from the persisted
graph/symbol/usages indexes, so you get structural context inline without separate
`trace_calls`/`find_usages` calls. It's opt-in (adds a few tokens per hit) and uses
whichever indexes are built; leave it off for plain "where is X" lookups.

## Drilling down

If the first results are close but not exact, don't give up or start reading
files — **call semantic_search again to refine**:

- Set mode to "refine" to narrow to the strongest matches, or "expand" to broaden
  when nothing looks right.
- Add a note to sharpen intent (e.g. "the retry/backoff logic").
- Pass pinResults with the numbers of the results that were on-target to steer the
  next search toward them. The server remembers your previous results, so you only
  pass the numbers — no ids.

Iterate this way a couple of times before falling back to reading files.

## Tracing execution flow

Once semantic_search locates a function, use trace_calls to follow the call graph
instead of reading files to find callers/callees. Pass the result's file and
startLine (and symbol if known); it returns the functions it calls and the
functions that call it, each with a file:line you can trace_calls again to walk
further. Good for "who calls X", "what does X call", "trace the checkout/auth
flow".

Trace calls uses the live language server when the VS Code LSP bridge is running,
and otherwise falls back to the persisted call graph if it has been built (pass
the symbol name so the offline lookup can find it). It can't resolve dynamic
dispatch (interfaces/callbacks/DI), cross-language calls, or data flow — for
those, fall back to semantic_search (it finds likely candidates by meaning).

To follow a chain several levels deep in one call — "trace the checkout/auth
flow", "what does X eventually call/what eventually calls X" — use
**show_execution_flow** (pass file + symbol, direction "callees"/"callers", and a
depth) instead of calling trace_calls repeatedly. It walks the persisted call
graph (works offline once built) with cycle/size guards, returning an indented
tree.

Related bridge-backed tools (same file/line inputs): **find_usages** lists every
reference to a symbol across the workspace (use for "where is X used?" and impact
analysis before a change) — it uses the live language server when the bridge is
running, otherwise the persisted usages index if it has been built (pass the
symbol name so the offline lookup can find it). **find_implementations** finds the
concrete implementations of an interface/abstract member — same live-then-persisted
fallback (pass the symbol name for the offline lookup).

For a quick read on an unfamiliar workspace — its size, main languages, and which
code-intelligence indexes are available — call **repo_overview** (no inputs). It's
a cheap orientation summary; use it before deciding whether to lean on
trace_calls/find_usages offline.

To understand how the codebase is *organized* — its modules, how they depend on
each other, where the entry points are, and which symbols are hotspots — call
**architecture_overview**. With no argument it returns a whole-repo module map
(modules = directories, ranked by size, each with its dependencies/dependents,
call-graph entry points, and reference hotspots); pass `module="<path or name>"`
(e.g. `"src/storage"` or `"storage"`) to drill into one module. It's a
deterministic, offline aggregation of the persisted symbols/usages/call-graph
indexes — no LLM and no re-index — so narrate its output rather than expecting
prose from it, and build those three indexes first for full detail. Use it for
"how is this organized / what are the main pieces / what depends on what".

## When Copilot's workspace index is unavailable

If this workspace's built-in semantic index / `#codebase` is disabled (common on
locked-down setups), use **`#foundryCodebase`** to pull code context from the
local, offline Foundry index instead — it's the drop-in replacement, backed by the
same `semantic_search` above. The deeper `foundry_*` Language Model tools
(`foundry_traceCalls`, `foundry_findUsages`, `foundry_architectureOverview`,
`foundry_readFile`, `foundry_listDirectory`, `foundry_projectStandards`,
`foundry_searchConfig`, `foundry_plan`, …) expose the
rest of the toolset for agent mode. Route by what you're given: a known **symbol name**
→ `foundry_searchSymbol`; a named **module / directory / file** →
`foundry_architectureOverview(module=…)` to locate it, then `foundry_readFile` to read
its actual source; described **behaviour** with no name → `foundry_semanticSearch`;
a question about **config** — any structured config file (`.yml`/`.json`, and whatever a
project declares in `.foundry/config.json`), e.g. Drupal views/fields/displays, routes,
permissions, services, or a module's dependencies → `foundry_searchConfig` — structured
config is **never embedded**, so it isn't in `semantic_search`; this is how you reach it,
then `foundry_readFile` for the raw file. Then
drill into the concrete hits (read the file, or `semantic_search` `expand=[…]`) rather
than re-searching with reworded queries. On a **PHP/Composer** repo, `foundry_readFile`
accepts a **fully-qualified class name** (e.g. `Acme\Module\Entity\Foo`) and resolves it
to the file via the project's auto-detected standards (Composer PSR-4, plus a framework-
specific reader like Drupal's runtime module namespaces when present); `foundry_projectStandards`
reports the detected framework + PSR-4 namespace→directory map + coding standard. Need a
plan for a change (scope, files to touch, steps, risks,
verify commands) grounded in this workspace? → `foundry_plan` — it returns a deterministic
context pack (overview, most-relevant code with full bodies, relevant config, call-sites,
build/test manifests) plus a plan template; it does not edit files.

There's also a `@codebase` chat participant that answers workspace questions — and, when asked,
makes actual changes — by driving these tools itself. For a visual overview, `@codebase /arch`
renders a Mermaid module dependency graph and `@codebase /graph <symbol>` renders a Mermaid call
graph (both offline, no model call). When a `@codebase` answer is a plan/finding with no changes
made, it ends with **⚡ Continue in agent mode** as a manual escape.

## `@codebase`: one mode, model decides

`@codebase` has **no separate `/plan` or `/implement` command** — every message goes through ONE
continuous agentic loop (see `execution-v2.md`) with the `foundry_*` lookup tools **and** the edit
tools (`apply_edit`, `create_file`, `delete_file`, `replace_symbol`, `insert_near_symbol`,
`rename_symbol`, `add_import`, `remove_import`, `move_file`) always available together — no built-in
VS Code tools. The model itself decides, from what was actually asked, whether to just answer,
propose a plan (and stop), or ground itself and make the change:
- "what does X do" / "how is Y handled" → answers directly, no edits.
- "how would I…" / "what would it take to…" → answers with a structured plan, no edits.
- "fix X" / "implement Y" / "add Z" → grounds via `foundry_*`, then edits directly using whichever
  edit tool fits: `apply_edit` for a small known-text tweak; `replace_symbol`/`insert_near_symbol`
  for a whole function/method/class (resolved by NAME via the language server, not text matching —
  more robust than reproducing exact current text); `rename_symbol` for a true cross-reference
  rename via the language server's own rename provider.
Edits are validated + applied + checkpointed by a headless `ExecutionService`
(`{ok, reason, diagnostics}`); a failure reason flows back to the model, which self-corrects (e.g. a
stale `apply_edit` `find` → "no match" → re-read + retry; an ambiguous symbol name → an error
listing every match → retry with `container`/`index`/`signature`).

**No mid-run checkpoints** — once the model decides to edit, it runs autonomously to completion (or
until genuinely stuck, `[BLOCKED: …]`) in one pass; there's no per-step pause to approve. Review
happens **once, at the end**: **🔍 Review all changes** opens every changed file in one multi-file
changes editor (not a picker), then **✓ Keep** / **↩ Undo all**. If blocked, partial edits are kept
for inspection with **↻ Retry** / **⤼ Skip & finish** / **↩ Undo all**. All UI is in the chat — no
separate view. There is no separate "Foundry" custom agent — the `foundry_*` tools / `#foundryCodebase`
work in normal agent mode too.
