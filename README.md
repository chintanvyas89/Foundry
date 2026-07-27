# Foundry — Local Semantic Code Search

Offline, local-only semantic code search for VS Code + Copilot agent mode. No
network calls at query time, no open ports, no native compilation — designed to
run on locked-down corporate machines.

It has two parts:

| Project | What it is |
|---|---|
| [`local-semantic-search-mcp/`](local-semantic-search-mcp/) | The MCP server. Walks the workspace, chunks code, embeds each chunk in-process (ONNX), stores vectors in SQLite, and answers a `semantic_search` tool over stdio. |
| [`lsp-bridge-extension/`](lsp-bridge-extension/) | An optional VS Code extension that feeds the server real language-server symbols over a local named pipe, for better chunk boundaries. Falls back to tree-sitter if absent. |

Chunking is three-tiered, richest source first: **LSP bridge** → **tree-sitter**
→ **fixed-window**. Everything works with just the MCP server; the extension is a
quality upgrade. See [`local-semantic-search-mcp/implementation-spec.md`](local-semantic-search-mcp/implementation-spec.md)
for the full design.

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
`${workspaceFolder}`, so it works as-is when you open this repo in VS Code. To use
it in **another** repo, copy `.vscode/mcp.json` there and adjust the path in
`args` to wherever you built `local-semantic-search-mcp`.

Then in VS Code:

1. Open the folder — VS Code detects `.vscode/mcp.json` and shows a **Start**
   action on the server. Click it.
2. Open **Copilot Chat → Agent mode**; the `semantic_search` tool appears.
3. Ask something like *"find where cosine similarity is computed."*

> Requires a recent VS Code (~1.99+) with Copilot agent mode. The first index
> build runs in the background after the server starts — a query made during
> that window waits for it to finish. Subsequent restarts are near-instant
> (unchanged files are skipped).

### 3. (Optional) Install the LSP bridge extension

This turns on the top chunking tier — real editor-grade symbols instead of
tree-sitter. A prebuilt `.vsix` is committed at
[`lsp-bridge-extension/swe-search-lsp-bridge-0.1.0.vsix`](lsp-bridge-extension/swe-search-lsp-bridge-0.1.0.vsix):

```bash
code --install-extension lsp-bridge-extension/swe-search-lsp-bridge-0.1.0.vsix
```

Or, from VS Code: **Extensions view → “…” menu → Install from VSIX…** and pick that
file.

After installing, reload VS Code. The status bar shows **`LSP Bridge: listening`**
when it's active. No configuration is needed — the server and the extension derive
the same pipe name from the workspace path independently, so they just connect. If
the extension isn't running, the server silently falls back to tree-sitter.

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

Licensed MIT — see [LICENSE](LICENSE).
