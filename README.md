# Foundry — Local Semantic Code Search

**Search and understand your codebase by *meaning*, entirely on your machine.**
Foundry is an offline, local-only code-intelligence layer for VS Code and Copilot
agent mode: no network calls at query time, no open ports, no native compilation —
built to run on locked-down corporate machines where code indexing is forbidden.

## Why this exists

Modern AI coding assistants are powerful, but their code understanding usually
depends on **uploading your source to a cloud index** (`#codebase` / `@workspace`).
Many enterprises forbid that — so they disable the workspace index and lose
semantic search, "find where X is handled," and codebase-aware planning, keeping
only the raw LLM.

Foundry closes that gap. It builds the semantic index **on your own machine** and
exposes it to VS Code, Copilot Chat, and agent mode — so you keep meaning-based
search and code-aware answers **without a single line of source ever leaving your
laptop**. Only the small snippets the model actually retrieves reach the LLM,
exactly as they would in any normal chat turn.

## What it can do

| Capability | What you get |
|---|---|
| 🔎 **Semantic search** | Find code by *what it does*, not exact text — "where is cosine similarity computed?" Ranked hits with `file:line`, offline. |
| 🧬 **Hybrid retrieval** | Vector ranking + a bounded full-text (FTS5) bonus, so exact identifiers the embedding misses still surface — without regressing natural-language queries. |
| 🏷️ **Symbol lookup** | Exact/partial name search over callables *and* non-callable declarations (interfaces, enums, types, constants). |
| 🧭 **Call graph & flow** | Trace callers/callees one level or walk multi-level execution flow; an explorable call tree you expand node-by-node in the UI. |
| 🔗 **Usages & implementations** | "Where is X used?" and "what implements this interface?" — live via the language server, or offline from a persisted index. |
| 🗺️ **Architecture overview** | Deterministic module-level map: modules, dependencies, entry points, and reference hotspots — no LLM, no re-index. |
| 💬 **`@codebase` chat participant** | Ask the workspace anything inside Copilot Chat; it agentically drives the local tools and answers with grounded, clickable references. |
| 📋 **`/plan` & `/arch` & `/graph`** | Grounded implementation plans (with change-impact blast radius), plus native Mermaid module & call-graph diagrams. |
| 🧩 **`#foundryCodebase` LM tools** | Drop-in replacement for a disabled `#codebase` inside Copilot's own chat and agent mode. |
| ⚡ **Lazy indexing** | Search opens in seconds — recently-edited files embed first, partial results stream while the rest indexes. |
| 🤝 **Shareable index** | Build once, share the portable `index.db`; teammates reuse it offline with zero re-embedding. |

## Why you'd want it

- **🔒 Your code never leaves the machine.** No cloud upload, no open ports, no
  network calls at query time — safe for locked-down/air-gapped setups.
- **🧠 Keep AI code-awareness even with the cloud index disabled.** `@codebase`
  and `#foundryCodebase` restore semantic search and codebase-aware planning
  inside Copilot Chat.
- **🪶 Zero-friction deploy.** Pure JS/ONNX — no native compilation, no build
  toolchain. The extension ships with **zero runtime dependencies**.
- **💸 Token-lean & cheap.** Compact signature results and deterministic
  (0-model-request) `/arch` and `/graph` keep context — and cost — small.
- **🔁 Build once, share everywhere.** The index and all code-intelligence graphs
  are portable; teammates drop in one file and get everything offline.

## Who should use this — and when

| You are… | Situation | Why Foundry fits |
|---|---|---|
| **A dev at a security-conscious enterprise** | Copilot's cloud workspace index is banned, but the LLM is allowed | Restores semantic search + code-aware chat locally; source stays on-device |
| **Working in an air-gapped / offline environment** | No egress to cloud indexing services | Fully offline after a one-time model download |
| **On a large or unfamiliar codebase** | Need to find "where X is handled" and how things connect | Meaning-based search + call graph + architecture map, no manual grepping |
| **A team lead onboarding others** | Want everyone productive without each machine re-indexing | Build the portable index once, share `index.db`, teammates reuse it instantly |
| **Anyone who wants private, local code search** | Prefer not to send code to any third party | Local-only by design — no ports, no network at query time |

---

It has two parts:

| Project | What it is |
|---|---|
| [`local-semantic-search-mcp/`](local-semantic-search-mcp/) | The MCP server. Walks the workspace, chunks code, embeds each chunk in-process (ONNX), stores vectors in SQLite, and answers a `semantic_search` tool over stdio. |
| [`lsp-bridge-extension/`](lsp-bridge-extension/) | A VS Code extension with two roles: (1) **no-LLM search UI** — `Search by meaning` / `Find similar code` commands that query the server directly and jump to results; (2) an optional **LSP bridge** that feeds the server real language-server symbols over a local named pipe for better chunk boundaries (falls back to tree-sitter if absent). |

Chunking is three-tiered, richest source first: **LSP bridge** → **tree-sitter**
→ **fixed-window**. Everything works with just the MCP server; the extension is a
quality upgrade.

📐 **[ARCHITECTURE.md](ARCHITECTURE.md)** — full technical architecture: components,
data flow, storage schema, the locality/privacy model, token-cost analysis, and
performance characteristics. See also
[`local-semantic-search-mcp/implementation-spec.md`](local-semantic-search-mcp/implementation-spec.md)
for the original design rationale.

---

## Setup

### 1. Build the MCP server

```bash
cd local-semantic-search-mcp
npm install
npm run build
```

> First run of the server downloads the embedding model (~300 MB from
> Hugging Face) once, then caches it under `node_modules/@huggingface/transformers/.cache`.
> Everything after that is fully offline.

### 2. Point VS Code at the server

[`.vscode/mcp.json`](.vscode/mcp.json) is already committed and uses
`${workspaceFolder}`, so it works as-is when you open this repo in VS Code.

**To use it in every project (recommended):** register it once at the user level
instead of per-repo. Command Palette → **MCP: Open User Configuration**, and add:

```json
{
  "servers": {
    "local-semantic-search": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/local-semantic-search-mcp/dist/index.js"],
      "env": { "WORKSPACE_ROOT": "${workspaceFolder}" }
    }
  }
}
```

The server path is absolute (it's a one-time install), but `WORKSPACE_ROOT:
"${workspaceFolder}"` resolves to whatever project you open — so it indexes *that*
project, not this repo. One built server serves all your projects; you don't clone
or copy it per-project. (If `node` isn't found — see Troubleshooting — use the
absolute path to `node` as the `command`.)

Then in VS Code:

1. Open the folder — VS Code detects `.vscode/mcp.json` and shows a **Start**
   action on the server. Click it.
2. Open **Copilot Chat → Agent mode**; the `semantic_search` tool appears.
3. Ask something like *"find where cosine similarity is computed."*

> Requires a recent VS Code (~1.99+) with Copilot agent mode. The first index
> build runs in the background after the server starts. Thanks to **lazy
> indexing**, search opens within seconds — recently-modified files are embedded
> first, then `semantic_search` returns partial results (marked *"index N%
> building"*) while the rest streams in. Set `lazyIndex: false` in
> `.swe-search.config.json` to block until the whole workspace is embedded, and
> `lazyHotSet` to tune how many files open search. Subsequent restarts are
> near-instant (unchanged files are skipped — no re-embed).

### 3. (Optional) Install the VS Code extension

The extension adds two things — a no-LLM search UI and the top chunking tier —
and neither requires Copilot. A prebuilt `.vsix` is committed at
[`lsp-bridge-extension/swe-search-lsp-bridge-0.9.11.vsix`](lsp-bridge-extension/swe-search-lsp-bridge-0.9.11.vsix):

```bash
code --install-extension lsp-bridge-extension/swe-search-lsp-bridge-0.9.11.vsix
```

Or, from VS Code: **Extensions view → “…” menu → Install from VSIX…** and pick that
file. Reload the window afterward.

**Search without Copilot (no LLM).** Point the extension at the built server
once — Settings → `sweSearch.serverEntry` = the absolute path to
`local-semantic-search-mcp/dist/index.js` (and `sweSearch.nodePath` to an
absolute node path if VS Code can't find `node`). Then:

- **Semantic Search: Search by meaning** (`Ctrl/Cmd+Alt+S`) — type a query, arrow
  through ranked results with live preview, Enter to jump to the exact lines.
- **Semantic Search: Find similar code** — select code, right-click → *Find
  similar code*.
- **Search panel** (target icon in the activity bar) — a drilldown view for
  iterative search: **pin** any result to steer the next query, add a **note**,
  then **Refine** (narrow to high-confidence hits) or **Expand** (broaden). Pins
  reuse the result's stored vector, so refining costs no extra embedding — it's
  relevance feedback, still with no LLM. A **Symbol name** toggle switches to
  exact identifier lookup; each result also has **Calls** — which opens an
  **explorable call tree** you expand node by node (callers *and* callees at each
  step, click to open, cycle-guarded) — and **Uses** (references across the
  workspace), both powered by the language server.

For Copilot, the server exposes nine MCP tools: **`semantic_search`** (by
meaning), **`search_symbol`** (exact/partial name — callables *and* non-callable
declarations like interfaces/enums/types once the symbol table is built),
**`trace_calls`** (call graph, one level), **`show_execution_flow`** (multi-level
call-graph walk), **`find_usages`** (references), **`find_implementations`** (of an
interface), **`repo_overview`** (a quick orientation summary — file/chunk
counts, language breakdown, and which indexes are built),
**`architecture_overview`** (a deterministic module-level map — modules =
directories with their dependencies/dependents, call-graph entry points, and
reference hotspots; drill into one with `module="<path or name>"`), and
**`read_file`** (read a located file's actual source, with line numbers — the
drill step after search identifies a named module/file; absolute or relative path,
optional line range).
The graph/reference tools take a result's `file`/`line`, so the agent can look up
identifiers and follow execution flow / impact instead of reading files. The
language-server-backed tools need the extension running and can't resolve dynamic
dispatch, cross-language calls, or data flow — **except `trace_calls`,
`show_execution_flow`, `find_usages`, and `find_implementations`**, which also
answer from their **persisted indexes** (see below) when the bridge is down.

`semantic_search` uses **hybrid retrieval**: semantic (vector) ranking with a
bounded full-text (FTS5) bonus, so exact identifiers/tokens the embedding misses
still surface — capped so it never dethrones a clearly better semantic match,
i.e. it won't regress a natural-language query. FTS5 is optional (search falls
back to vector-only if the local sqlite lacks it) and needs no re-embedding — a
one-time lexical backfill reuses the text already indexed.

It is also **token-lean by default**: results come back as compact signatures
(symbol + `file:line` range + score + one-line signature), so an agent can pick
the right hit without pulling whole function bodies into context. To read a hit's
full code, call again with `expand=[n,…]` (the result numbers — no need to repeat
the query), or pass `detail="full"` for every body at once. UI clients still
receive full code via `structuredContent`.

For **structural context inline**, pass `context=true`: each hit is annotated with
a one-line summary — its enclosing parent (`in ClassName`), `calls:` / `called by:`
from the call graph, and related `tests:` — so an agent sees the flow around a
result without a separate `trace_calls`/`find_usages`. It's opt-in (a few extra
tokens per hit) and draws on whichever of the persisted
[graph](#persisted-call-graph-optional-shareable) /
[symbol](#persisted-symbol-table-optional-shareable) /
[usages](#persisted-usages-index-optional-shareable) indexes have been built.

These spawn the server in **query-only** mode (reads the index, never builds or
modifies it), so they coexist with the Copilot-driven server on the same
`index.db`.

## Chat participant (`@codebase`) & Copilot tools

For teams that **disable Copilot's cloud workspace index** (`#codebase` /
`@workspace`) so their source is never uploaded — but still use the Copilot LLM —
the extension makes Foundry's local index the code-aware layer *inside Copilot
Chat*. The codebase is never sent anywhere; only the small snippets the model
retrieves reach it, exactly like any Copilot chat.

Two surfaces, both reading the same local, query-only index:

- **`@codebase` chat participant.** Ask it anything about the workspace
  (`@codebase how does hybrid retrieval work?`, `@codebase who calls upsertChunks
  and is it safe to change?`). It runs an **agentic loop**: the model chooses which
  local tools to call (semantic search, trace calls, find usages, architecture
  overview…), and each call is shown as a progress line so the retrieval plan is
  visible; the answer ends with a *"Grounded via …"* trailer and clickable file
  references. Slash commands: **`/index`** (index overview); **`/arch`**
  (architecture map **+ a Mermaid module dependency diagram**); **`/graph
  <symbol>`** (a **Mermaid call graph** for a symbol — prefix `callers` to
  invert); and **`/plan <change>`** — a grounded, step-by-step implementation plan
  (it proposes, it doesn't edit) that also appends a **change-impact diagram**
  (callers of the target symbol) when there's a blast radius to show. The diagrams
  are plain Mermaid that VS Code chat renders natively — no bundled library — and
  `/arch`, `/graph` are deterministic (no model request).
- **Language Model tools.** The same capabilities are registered as Copilot
  *Language Model tools*, so Copilot's own chat and agent mode can call them.
  Type **`#foundryCodebase`** in any chat to pull local-index context (the drop-in
  for the disabled `#codebase`); in agent mode the model auto-invokes the deeper
  `foundry_*` tools (trace calls, usages, architecture) as needed.

Requirements: VS Code ≥ 1.95, the **GitHub Copilot Chat** extension present
(provides the chat view and the LLM), `sweSearch.serverEntry` configured, and a
built index. The extension still ships with **zero runtime dependencies** — the
participant and tools are hand-rolled on the VS Code API and reuse the existing
query-only search client.

### Persisted call graph (optional, shareable)

`trace_calls` normally asks the live language server, but the whole call graph can
also be **built once and persisted** so it works offline and can be shared. With
VS Code open and the extension active, start the server with `SWE_BUILD_GRAPH=1`:

```bash
SWE_BUILD_GRAPH=1 node local-semantic-search-mcp/dist/index.js
```

It walks the language server for every callable symbol and stores directed
caller→callee edges in `call_edges` inside `index.db`. The pass:

- **runs detached** — it never blocks search, and logs progress to stderr;
- is **resumable** (restart and it continues) and **incremental** (edits refetch
  just the changed file, via the watcher);
- takes minutes to ~an hour on large repos — it's a one-time LSP pass, **not a
  re-embed** (your vectors are reused untouched).

Because edges use workspace-relative paths, the graph rides inside the shared
`index.db`: build it once, share the file, and teammates get the full call graph
**offline — no bridge or language server needed**. `trace_calls` automatically
uses the persisted graph whenever the live bridge isn't running (pass the symbol
name so it can look the entry up).

### Persisted symbol table (optional, shareable)

`search_symbol` covers callables out of the box (from the chunk index). To also
find **non-callable declarations** — interfaces, enums, type aliases, constants —
build the standalone symbol table once, the same way as the call graph. With
VS Code open and the extension active:

```bash
SWE_BUILD_SYMBOLS=1 node local-semantic-search-mcp/dist/index.js
```

It walks the language server's document symbols (all kinds) for every indexed
file and stores them in a `symbols` table inside `index.db`. Like the graph build
it **runs detached**, is **resumable + incremental**, rides in the shared
`index.db` (works offline for teammates), and is **not a re-embed** — vectors are
untouched. Once built, `search_symbol` unions these with the callable symbols and
labels each hit with its kind.

### Persisted usages index (optional, shareable)

`find_usages` normally asks the live language server for a symbol's references,
but they can also be **built once and persisted** so it works offline. It builds
on the symbol table (references are collected for every declaration in it), so
build that first, then:

```bash
SWE_BUILD_SYMBOLS=1 node local-semantic-search-mcp/dist/index.js   # if not already built
SWE_BUILD_USAGES=1  node local-semantic-search-mcp/dist/index.js
```

It stores each reference (`symbol_refs`: where the symbol is used, plus the
source line) inside `index.db`. Like the other builds it **runs detached**, is
**resumable + incremental**, rides in the shared `index.db` (works offline for
teammates), and is **not a re-embed**. `find_usages` automatically uses the
persisted index whenever the live bridge isn't running (pass the symbol name so
it can look the entry up).

### Persisted implementations index (optional, shareable)

`find_implementations` works the same way: build it once (it also builds on the
symbol table) and it answers offline.

```bash
SWE_BUILD_IMPLS=1 node local-semantic-search-mcp/dist/index.js
```

It stores each concrete implementation (`symbol_impls`) inside `index.db` —
detached, resumable/incremental, shareable, not a re-embed — and
`find_implementations` falls back to it when the bridge is down.

### Build everything at once

Instead of setting each flag, use **`SWE_BUILD_ALL=1`** to build all four indexes
in dependency order (symbols → call graph → usages → implementations) in one run:

```bash
SWE_BUILD_ALL=1 node local-semantic-search-mcp/dist/index.js
```

Each stage is detached, resumable, and shareable; the pass stops early and
resumes on restart if the bridge drops. (All builds must run in the server that
holds the index lock — i.e. the one VS Code's `.vscode/mcp.json` starts — so set
the flag there and restart that server; a separate manual `node` invocation can't
acquire the lock while VS Code's server is running.)

**LSP bridge (better chunks).** With the extension running, the status bar shows
**`LSP Bridge: listening`** — the server then chunks on real editor symbols
instead of tree-sitter. No configuration needed; the server and extension derive
the same pipe name from the workspace path independently. If the extension isn't
running, the server silently falls back to tree-sitter.

To rebuild the `.vsix` yourself:

```bash
cd lsp-bridge-extension
npm install
npm run build
npx @vscode/vsce package
```

---

## Languages & targeted re-index

Symbol-boundary chunking (tree-sitter) covers TypeScript/JS(X), Python, Go, Rust,
Java, C/C++, and **PHP — including Drupal's PHP extensions** (`.module`, `.inc`,
`.install`, `.theme`, `.profile`, `.engine`). PHP classes, interfaces, traits, and
top-level functions (e.g. Drupal hooks like `mymodule_form_alter`) each become
their own **named** chunk, so `search_symbol` finds them offline and semantic
search ranks them precisely. Anything else falls back to fixed-window chunking,
which still indexes the file but without symbol names.

**Applying a chunker change to an existing index.** The indexer skips files whose
content is unchanged, so simply upgrading (e.g. gaining PHP support) does **not**
re-chunk already-indexed files. To re-chunk + re-embed **just** the affected
extensions — without a full re-embed of the whole repo — set **`SWE_REINDEX_EXT`**
(comma-separated) on the lock-holding server for one run:

```bash
SWE_REINDEX_EXT=.php,.module,.inc,.install,.theme,.profile,.engine \
  node local-semantic-search-mcp/dist/index.js
```

It drops the stored chunks + file-hash for matching files so the build re-embeds
only those (all other files keep their vectors). In VS Code, add it to
`.vscode/mcp.json`'s `env`, restart the MCP server, wait for `index ready`, then
remove it. (For richer PHP call graphs / usages, also install a PHP language
server extension in VS Code — see below.)

---

## Verifying it works

- **Quickest (no VS Code):** from `local-semantic-search-mcp/`, run
  `node scripts/query.mjs <workspaceRoot> "your query"` — spawns the server as a
  real MCP client and prints ranked results.
- **Is the LSP bridge actually being used?** Run
  `node lsp-bridge-extension/scripts/poke-pipe.mjs <workspaceRoot> <file>` while the
  extension is running; it should print real symbol names for that file.
- **Benchmark embedding throughput on your machine:**
  `node local-semantic-search-mcp/scripts/bench.mjs`.

---

## Excluding files & folders from the index

Anything excluded is never embedded — the fastest way to speed up a big repo and
keep results relevant. Three layers, all using gitignore syntax:

1. **Built-in defaults** (always on): `.git`, `node_modules`, `.swe-search`,
   lockfiles, `*.min.js`, `*.min.css`, `*.map`.
2. **The project's `.gitignore`** is respected automatically.
3. **Your own excludes**, via either:
   - a **`.sweignore`** file at the workspace root, or
   - an **`exclude`** array in `.swe-search.config.json`:
     ```json
     {
       "exclude": ["tests/", "vendor/", "docs/", "**/*.generated.ts"]
     }
     ```

Both accept the same gitignore-style patterns (`folder/`, `*.ext`, `**/glob`).
Use whichever you prefer — `exclude` keeps everything in one config file;
`.sweignore` is handy if you'd rather keep the ignore list separate. Excludes
apply to both the initial build and the live watcher.

## Setting up on a teammate's machine

Everything except the index file itself comes from the clone. Each dev does this
once:

1. **Build the MCP server:** `cd local-semantic-search-mcp && npm install && npm run build`.
   `npm install` downloads the embedding model (~1 GB) **once** over the network,
   then caches it under `node_modules`; everything is offline afterward. (`dist/`
   and `node_modules/` are gitignored, so this step is always local.)
2. **Install the extension** (needed to *build/refresh* indexes or use the search
   panel; not needed to just query a shared index): `code --install-extension
   lsp-bridge-extension/swe-search-lsp-bridge-0.9.11.vsix`. The `.vsix` **is**
   committed, so it's already in the clone.
3. **Config is committed.** `.vscode/mcp.json` uses `${workspaceFolder}`, so it
   works as-is — no per-machine edits.

Then pick one:

- **Build your own index** (self-contained): open the repo in VS Code, add
  `SWE_BUILD_ALL=1` to `.vscode/mcp.json`'s `env`, restart the MCP server, wait for
  the four `done` logs, then remove the flag. The first launch also embeds the
  workspace (the one heavy step).
- **Reuse a shared index** (skip building): get `index.db` from a teammate (see
  below) and drop it at `<workspace>/.swe-search/index.db`. Note `.swe-search/` is
  **gitignored**, so the DB is *not* in the clone — it must be shared out-of-band.

## Sharing the index between developers

The index (`.swe-search/index.db`) is **portable** — paths are stored relative to
the workspace root, and the DB is stamped with the model it was built with. So one
person can build it once and share it, and others skip re-indexing:

1. Build the index on a canonical checkout (e.g. `main`).
2. Share `<workspace>/.swe-search/index.db` — via a release artifact, shared drive,
   or git-LFS. **Don't** commit it to git normally (it's binary and can be hundreds
   of MB — roughly 3 KB per chunk).
3. Each dev drops it into their own `<workspace>/.swe-search/index.db` and starts
   the server. It reconciles against their working tree automatically:
   - identical files → **skipped** (no embedding),
   - files they added / changed → **embedded** (just those),
   - files they deleted / that differ from the shared checkout → **pruned**.

So a dev on a feature branch with a handful of extra files only pays to embed those
few — everything shared is reused instantly. Requirements: same `model`/`dtype`
(a mismatch triggers a clean rebuild automatically) and, for maximum reuse, a
similar code state.

**All the persisted indexes travel with `index.db` too.** Whichever were built —
call graph (`SWE_BUILD_GRAPH`), symbols (`SWE_BUILD_SYMBOLS`), usages
(`SWE_BUILD_USAGES`), implementations (`SWE_BUILD_IMPLS`), or all via
`SWE_BUILD_ALL` — store **relative-path, portable** rows, so recipients get
whole-repo `trace_calls` / `show_execution_flow` / `search_symbol` (non-callables
included) / `find_usages` / `find_implementations`, plus the deterministic
`architecture_overview` module map, **offline — without a language server or the
extension**. Locally changed files show stale rows until the watcher refetches
them (only if the bridge is running); everything else is exact. Tip: build with
`SWE_BUILD_ALL=1` before sharing so teammates get every code-intelligence feature
with zero setup beyond dropping in the file.

To share the one-time **model download** as well (useful for offline machines),
copy `local-semantic-search-mcp/node_modules/@huggingface/transformers/.cache` too —
that's a separate ~300 MB artifact and saves the download, independent of the index.

## Notes & constraints

- **One indexer per workspace at a time.** Both a running MCP Inspector and a VS
  Code MCP server point at the same `.swe-search/index.db`; don't run two against
  the same folder simultaneously.
- **First index of a large repo is slow** — the embedding model is accurate but
  CPU-bound. It's one-time; restarts reuse the stored index and only re-embed
  changed chunks. Tune `dtype`/`model` in a `.swe-search.config.json` at the
  workspace root if needed — changing the model auto-rebuilds the index (the DB
  is stamped with the model it was built with), so no manual cleanup required.
- **`dist/`, `node_modules/`, and `.swe-search/` are gitignored** — clone, then
  `npm install && npm run build` in each project.

## Troubleshooting

**`env: node: No such file or directory` during `npm install`**
Node isn't on `PATH`. Install Node **22.5+** (needed for the built-in `node:sqlite`;
24 is ideal). If it's installed as `nodejs` (Debian/Ubuntu), symlink it:
`sudo ln -s "$(which nodejs)" /usr/local/bin/node`. Don't run `npm install` under
`sudo` (it drops nvm from `PATH`).

**MCP server won't start: `spawn node ENOENT`**
VS Code launched from the GUI doesn't inherit your shell `PATH` (common with nvm),
so it can't find `node`. Fix by putting the **absolute** node path in `mcp.json`:
`"command": "/home/you/.nvm/versions/node/vXX/bin/node"` (find it with
`which node`). Or symlink node onto the system PATH:
`sudo ln -sf "$(which node)" /usr/local/bin/node` and keep `"command": "node"`.

**It indexed the wrong folder / far too few files**
`WORKSPACE_ROOT` is probably hardcoded. It must be `"${workspaceFolder}"` so it
follows the open project. Quick check: the `.swe-search/` folder is created at
whatever `WORKSPACE_ROOT` points to — if it appeared somewhere unexpected, that's
what got indexed. Fix the value and **Restart** the server.

**I can't find the server's log / Output channel**
Command Palette → **MCP: List Servers** → select `local-semantic-search` →
**Show Output**. (The channel only exists once the server has started.) The state
shown there — Running / Error / Stopped — also tells you if it failed to spawn.

**First start looks frozen at `loading embedding model...`**
On a fresh machine it's downloading the model (~300 MB) — watch the output for
`downloading … %`. It needs internet **once**, then runs offline. Don't close VS
Code *during the download* (a truncated cache fails to load; if that happens,
`rm -rf local-semantic-search-mcp/node_modules/@huggingface/transformers/.cache`
and restart). Closing *during indexing* (after download) is safe and resumable.

**A search errors out / times out right after starting**
The index builds in the background; a query made before it's ready waits, and a
long build can exceed the client's ~60s timeout. Wait for `index ready: …` in the
output, then query. (Restarts after the first build are near-instant.)

**Copilot reads files instead of calling `semantic_search`**
The tool is available but the model *chooses* not to use it — Copilot leans on its
own built-in file-reading/`#codebase` behavior by default (and may say "semantic
workspace search is not currently available", which refers to *its* built-in
feature, not this tool). Three ways to steer it:
- **Force it:** type `#semantic_search <query>` in the chat, or say "use the
  semantic_search tool to …".
- **Nudge it per-project:** add a [`.github/copilot-instructions.md`](.github/copilot-instructions.md)
  (see this repo's copy as a template) telling the agent to prefer `semantic_search`
  for locating code. VS Code reads it automatically.
- Autonomous selection is ultimately the model's call — these make it far more
  likely, but `#semantic_search` is the only guaranteed trigger.

**Indexing a huge repo is taking hours**
Trim it — exclude tests/vendored/generated dirs (see *Excluding files & folders*),
and/or switch to a smaller model like `Xenova/all-MiniLM-L6-v2` in
`.swe-search.config.json` (~10–20× faster). The build is resumable, so you can also
just let it run and reopen later — it continues where it stopped.

Licensed MIT — see [LICENSE](LICENSE).
