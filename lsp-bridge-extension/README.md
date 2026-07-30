# Local Semantic Search — VS Code extension

A local, offline, **no-LLM** semantic code search for VS Code, in two parts:

1. **Search UI** — the `Search by meaning` and `Find similar code` commands.
   They query the `local-semantic-search-mcp` server (spawned in read-only
   query mode) and show ranked results you can jump to. No Copilot, no API
   key, no network.
2. **LSP bridge** — a background socket that answers "what are the symbols in
   this file" using VS Code's own language servers, so the MCP server's
   indexer can chunk on real symbol boundaries. Falls back to tree-sitter if
   the bridge isn't running.

Both talk to the MCP server over a local-only named pipe/socket; neither opens
a network port.

## Using the search commands

Two commands (Command Palette, or right-click):

- **Semantic Search: Search by meaning** — type a natural-language query
  (`where JWT tokens are validated`) and get ranked functions/classes. Arrow
  through the list to preview each in the editor; Enter jumps to the exact
  lines. Default keybinding: `Ctrl+Alt+S` (`Cmd+Alt+S` on macOS).
- **Semantic Search: Find similar code** — select a block of code, right-click
  → *Find similar code*. Uses the selection itself as the query to surface
  semantically similar code (great for spotting duplication).
- **Search panel** — the target icon in the activity bar opens a drilldown
  view. Pin any result (its stored vector, reused for free — no re-embedding)
  and/or add a note to build up a *context tray* that steers the next search,
  then **Refine** (narrow to high-confidence hits) or **Expand** (broaden). This
  is relevance-feedback search, still with no LLM.

### One-time setup

The commands need to know where the built search server lives. In Settings
(`sweSearch.*`):

| Setting | What it is |
|---|---|
| `sweSearch.serverEntry` | **Required.** Absolute path to `local-semantic-search-mcp/dist/index.js`. |
| `sweSearch.nodePath` | Node executable to run it with. Defaults to `node`; set an absolute path if VS Code can't find node (common with nvm). |
| `sweSearch.topK` | How many results per search (default 8). |

The first search after opening a workspace spins up the server and loads the
embedding model (a few seconds warm, longer on the very first model download);
subsequent searches are near-instant. The server runs in **query-only** mode —
it reads the existing index but never builds or modifies it, so it coexists
safely with the indexer VS Code runs for Copilot.

## Why a named pipe, not a localhost port

A loopback TCP port is still a listening network socket a security scanner will
flag. A Unix domain socket (or a Windows named pipe) never touches the network
stack, and the socket file is chmod'd to the current user only. Deliberate, not
an oversight.

## Zero runtime dependencies, by design

Check `package.json` — nothing under `dependencies`, only `devDependencies` for
building. The search client talks to the MCP server with a hand-rolled JSON-RPC
stdio client rather than pulling in the MCP SDK, so there's nothing to audit for
telemetry or supply-chain risk — which matters here since this code runs inside
the shared VS Code extension host.

## Installing the prebuilt extension

A ready-to-install package is committed alongside this README:
`swe-search-lsp-bridge-0.3.3.vsix`.

```bash
code --install-extension swe-search-lsp-bridge-0.3.3.vsix
```

Or in VS Code: **Extensions view → “…” menu → Install from VSIX…**. Reload the
window afterward. Set `sweSearch.serverEntry` (above), then try
**Search by meaning**.

## Build & run locally (development)

```bash
npm install
npm run build   # tsc
```

Press `F5` with this folder open to launch an Extension Development Host. To
rebuild the package: `npx @vscode/vsce package`.

## Pairing the bridge with the MCP server

No configuration needed for the bridge itself — the pipe name is derived
deterministically from the workspace root path by both projects (see
`src/pipeName.ts` here and its twin in `local-semantic-search-mcp`). If the
extension isn't running, the MCP server's chunker silently falls back to
tree-sitter. To confirm the bridge tier is live, check the indexer's chunk
output for `symbol` fields populated with real function/class names, or run
`node scripts/poke-pipe.mjs <workspaceRoot> <file>`.
