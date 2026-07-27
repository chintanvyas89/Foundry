# Local Semantic Code Search — Implementation Spec

**Version:** 0.1
**Parent:** `local-semantic-search-spec.md` (pilot spec)
**Status:** First implementation pass, not yet build-tested (see §9)

---

## 1. Purpose

This is the concrete engineering plan behind the code in this folder: module layout, exact dependency choices, and — importantly — the reasoning behind each, so nothing here is a silent decision.

## 2. Architecture Correction: Chunking Cannot Use VS Code's LSP Directly

This corrects §5.1 of the pilot spec, which assumed chunking would use "VS Code's LSP integration."

An MCP server is a standalone OS process. Copilot's agent mode spawns it as a child process and talks to it over stdio using the MCP protocol only — it does not run inside the VS Code extension host, and has no access to `vscode.*` APIs, including `vscode.languages.getDocumentSymbols`.

So chunking needs its own, independent parsing capability. This implementation uses **tree-sitter**, via its WASM bindings (`web-tree-sitter`), for symbol-boundary chunking. It's language-agnostic, has no VS Code dependency, and behaves identically whether the server is invoked by Copilot, run from the command line, or exercised in a test.

## 3. Dependency Choices, and Why

| Concern | Choice | Why |
|---|---|---|
| MCP protocol | `@modelcontextprotocol/sdk` | Official TypeScript SDK |
| Chunking | `web-tree-sitter` + `tree-sitter-wasms` (prebuilt grammars) | WASM, not native — no C++ build toolchain required on the developer's machine |
| Embedding | `@huggingface/transformers` + `onnx-community/embeddinggemma-300m-ONNX` | Confirmed ready-to-use ONNX export; runs in-process, no separate server or open port |
| Metadata storage | `node:sqlite` (Node's own built-in module) | No native compilation, ships with Node itself |
| Vector storage | Float32Array BLOBs in the same SQLite file; brute-force cosine similarity at query time | Avoids `sqlite-vec`/native vector extensions for MVP scale (tens of thousands of chunks per repo); revisit only if scale demands it |
| File watching | `chokidar` | Standard, reliable, well-understood failure modes |
| Ignore handling | `ignore` (gitignore-pattern matcher), applied to `.gitignore` and `.sweignore` | Reuses a pattern format developers already know |
| Input validation | `zod` | Matches the MCP SDK's schema conventions |

Every storage/chunking choice here was made **specifically to avoid native compilation** — a real constraint on IT-locked-down corporate laptops, not a style preference.

## 4. Module Layout

```
src/
  index.ts                    — MCP server entry point
  config.ts                   — loads .swe-search.config.json, applies defaults
  types.ts                    — shared types
  ignore/ignoreMatcher.ts     — .gitignore + .sweignore matching
  chunking/
    chunker.ts                — picks tree-sitter or fallback per file
    treeSitterChunker.ts      — symbol-boundary chunking
    fallbackChunker.ts        — fixed-window chunking for unsupported file types
  embedding/embedder.ts       — wraps @huggingface/transformers
  storage/
    store.ts                  — SQLite metadata + brute-force vector search
    similarity.ts             — cosine similarity
  indexing/
    indexer.ts                — full build + per-file re-index
    watcher.ts                — chokidar-driven incremental updates
  tools/semanticSearch.ts     — the MCP tool itself
```

## 5. Data Flow

1. Server starts → loads config → builds ignore matcher → loads embedding model.
2. Full index build: walk the workspace (respecting ignore rules) → tree-sitter chunk each file (fallback to fixed-window if unsupported) → embed each chunk → write to SQLite.
3. Watcher runs continuously: on save/create/delete, re-index only the changed file — delete its old chunks, chunk and embed fresh, write back. No full rescans after startup.
4. On a `semantic_search` tool call: embed the query string, load stored vectors, score by cosine similarity, return the top-k.

## 6. Configuration

`.swe-search.config.json` at the workspace root (optional — sensible defaults apply if absent):

```json
{
  "model": "onnx-community/embeddinggemma-300m-ONNX",
  "dtype": "q8",
  "topKDefault": 8,
  "maxChunkTokens": 512
}
```

## 7. Recommended Build Order

Don't build this end to end before testing anything — validate the riskiest pieces first:

1. Chunking + embedding as a standalone script against a handful of real files, no MCP/storage involved yet.
2. Storage layer + full indexer, exercised via a small CLI script that builds an index and prints chunk counts.
3. MCP server wiring + the `semantic_search` tool — test with an MCP inspector or directly from Copilot.
4. The watcher, for incremental updates.
5. The network-boundary verification from §7 of the pilot spec — block outbound access and confirm the whole pipeline still completes.

## 7a. Addendum: the LSP Bridge (hybrid addition)

Chunking is now three-tiered, not two:

1. **LSP bridge** — a separate, thin companion VS Code extension
   (`lsp-bridge-extension/`, sibling project) that answers "what are the
   symbols in this file" using VS Code's real language servers, over a
   local-only named pipe (Unix domain socket / Windows named pipe — not a
   TCP port, deliberately, to avoid an open localhost port a security
   scanner would flag). This is real LSP data, the same the editor's own
   outline view uses — strictly better than tree-sitter's hardcoded
   per-language node-type list.
2. **tree-sitter** — falls back here if the bridge extension isn't
   installed, no VS Code window has the workspace open, or the request
   times out. Unchanged from §2.
3. **Fixed-window** — final fallback, always available.

This is deliberately *not* the `vscode.lm.registerTool()` approach discussed
and set aside — the bridge extension has no chat integration at all; it only
answers symbol queries from the MCP server over the pipe. Full `registerTool`
integration (which would also move embedding/storage into the shared
extension host, with the resource tradeoffs that implies) remains a future
option, not built here.

The MCP server's chunking pipeline stays the primary owner of embedding,
storage, and search — this hybrid only upgrades where chunk boundaries come
from, without moving any of the resource-heavy work into VS Code's process.

## 8. Deliberately Out of Scope (matches the pilot spec's MVP)

`find_similar_code` tool, cross-repo search, `sqlite-vec`/native vector indexing, any UI beyond what Copilot's agent mode already renders for tool calls.

## 9. Known Gap — Read Before Running

This code was written but **not executed or compiled** in the environment that produced it — there's no network access there to install npm dependencies. Treat everything in `src/` as a first draft to build and debug locally, not a verified-working artifact. Package API surfaces (the MCP SDK, `node:sqlite`, `web-tree-sitter`) move quickly enough that some adjustment against current docs should be expected, particularly:

- `node:sqlite` — confirm it's stable (not behind a flag) on whatever Node version is standard on developer machines. If it isn't available, the fallback is `sql.js` (WASM, still no native compile) rather than `better-sqlite3`.
- `web-tree-sitter` — confirm the exact API shape (`Parser.init()`, `Language.load()`) against the installed version; this has shifted across major versions.
- `@modelcontextprotocol/sdk` — confirm `McpServer` and `.tool()` registration match the current SDK release.
