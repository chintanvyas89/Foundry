# Local Semantic Search — LSP Bridge

A thin VS Code extension with one job: answer "what are the symbols in this
file" using VS Code's own language servers, over a local-only named
pipe/socket, for the `local-semantic-search-mcp` server to consume.

**Status:** first pass, not yet build-tested — same caveat as the MCP server
project (see its `implementation-spec.md` §9).

## What this is (and isn't)

- **Is:** a background bridge. No chat UI, no commands beyond a status bar
  indicator, no `languageModelTools` contribution.
- **Isn't:** the `registerTool` approach discussed and deliberately deferred —
  this extension never talks to Copilot directly. It only answers symbol
  queries from the MCP server. Full `registerTool` integration stays a
  future option, not built here.

## Why a named pipe, not a localhost port

A loopback TCP port is still a listening network socket a security scanner
will flag and someone has to explain — the same objection raised earlier
about Ollama's `localhost:11434`. A Unix domain socket (or a Windows named
pipe) never touches the network stack at all, and the socket file is
chmod'd to the current user only. This was a deliberate choice, not an
oversight.

## Zero runtime dependencies, by design

Check `package.json` — there is nothing under `dependencies`, only
`devDependencies` for building. That means there's nothing to audit for
telemetry or supply-chain risk in this extension at all, which matters more
here than usual since this code runs inside the shared VS Code extension
host process, not in its own isolated process like the MCP server.

## Build & run locally (development)

```bash
npm install
npm run build
```

Then press `F5` in VS Code with this folder open to launch an Extension
Development Host with the bridge active. Watch the status bar for
`LSP Bridge: listening`.

## Installing the prebuilt extension

A ready-to-install package is committed alongside this README:
`swe-search-lsp-bridge-0.1.0.vsix`. Install it directly:

```bash
code --install-extension swe-search-lsp-bridge-0.1.0.vsix
```

Or in VS Code: **Extensions view → “…” menu → Install from VSIX…**. Reload the
window afterward and watch the status bar for `LSP Bridge: listening`.

## Rebuilding the package yourself

```bash
npm install
npm run build
npx @vscode/vsce package
```

Produces a fresh `.vsix` — install as above, or publish through an internal
extension marketplace if your org runs one.

## Pairing with the MCP server

No configuration needed on either side beyond both being pointed at the same
workspace — the pipe name is derived deterministically from the workspace
root path independently by both projects (see `src/pipeName.ts` here and
the matching file in `local-semantic-search-mcp`). If the extension isn't
running, the MCP server's chunker silently falls back to tree-sitter — check
`local-semantic-search-mcp`'s logs (stderr) if you expect the bridge to be
in use and it doesn't seem to be.

## Verifying it end to end

1. Open the target repo in VS Code with this extension active (status bar
   shows "listening").
2. Run the MCP server's indexer against the same workspace root.
3. Check the indexer's chunk output for `symbol` fields populated with real
   function/class/method names matching what the editor's own outline view
   shows for those files — that's the signal the bridge tier is actually
   being used, not the tree-sitter fallback.
