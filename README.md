# Foundry — Local Semantic Code Search

Offline, local-only semantic code search for VS Code + Copilot agent mode. No
network calls at query time, no open ports, no native compilation — designed to
run on locked-down corporate machines.

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
> build runs in the background after the server starts — a query made during
> that window waits for it to finish. Subsequent restarts are near-instant
> (unchanged files are skipped).

### 3. (Optional) Install the VS Code extension

The extension adds two things — a no-LLM search UI and the top chunking tier —
and neither requires Copilot. A prebuilt `.vsix` is committed at
[`lsp-bridge-extension/swe-search-lsp-bridge-0.6.0.vsix`](lsp-bridge-extension/swe-search-lsp-bridge-0.6.0.vsix):

```bash
code --install-extension lsp-bridge-extension/swe-search-lsp-bridge-0.6.0.vsix
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
  exact identifier lookup; each result also has **Calls** (callers/callees — call
  graph) and **Uses** (references across the workspace) buttons, powered by the
  language server.

For Copilot, the server exposes five MCP tools: **`semantic_search`** (by
meaning), **`search_symbol`** (exact/partial name), **`trace_calls`** (call
graph), **`find_usages`** (references), and **`find_implementations`** (of an
interface). The last three take a result's `file`/`line`, so the agent can look up
identifiers and follow execution flow / impact instead of reading files. The
language-server-backed tools need the extension running and can't resolve dynamic
dispatch, cross-language calls, or data flow.

`semantic_search` uses **hybrid retrieval**: semantic (vector) ranking with a
bounded full-text (FTS5) bonus, so exact identifiers/tokens the embedding misses
still surface — capped so it never dethrones a clearly better semantic match,
i.e. it won't regress a natural-language query. FTS5 is optional (search falls
back to vector-only if the local sqlite lacks it) and needs no re-embedding — a
one-time lexical backfill reuses the text already indexed.

These spawn the server in **query-only** mode (reads the index, never builds or
modifies it), so they coexist with the Copilot-driven server on the same
`index.db`.

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
