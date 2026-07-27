# Architecture

Technical design of the Foundry local semantic code search system: components,
data flow, storage, the locality/privacy model, and a token-cost analysis.

For setup and usage see [README.md](README.md). For the original design rationale
see [`local-semantic-search-mcp/implementation-spec.md`](local-semantic-search-mcp/implementation-spec.md).

---

## 1. Overview

The system answers one question well: *"where in this codebase is the code that
means X?"* — by natural-language or code intent, not keyword match. It does this
entirely **on the developer's machine**: code never leaves the box, there is no
open network port at query time, and nothing requires a C++ build toolchain.

It has two independently-installed processes:

```
┌─────────────────────────── VS Code ────────────────────────────┐
│                                                                  │
│   Copilot Chat (Agent mode)                                      │
│        │  calls tool "semantic_search"                           │
│        ▼                                                          │
│   MCP client  ──spawns (stdio)──►  local-semantic-search-mcp     │
│                                       (separate Node process)    │
│                                                                  │
│   lsp-bridge-extension (optional, in the extension host)         │
│        ▲   answers "symbols in this file"                        │
└────────┼─────────────────────────────────────────────────────────┘
         │ local named pipe / unix socket (no TCP port)
         └───────────────────────────  local-semantic-search-mcp
```

| Process | Runs where | Job |
|---|---|---|
| **local-semantic-search-mcp** | Standalone Node child process, spawned by VS Code's MCP client over stdio | Walk → chunk → embed → store → search. Owns all heavy work. |
| **lsp-bridge-extension** | Inside VS Code's extension host | *Optional.* Answers "what symbols are in this file" from VS Code's real language servers, over a local pipe, to improve chunk boundaries. |

The MCP server is fully functional alone; the extension only upgrades where chunk
boundaries come from.

---

## 2. Why an MCP server (and not a VS Code extension doing everything)

An MCP server is a standalone OS process. Copilot's agent mode spawns it as a child
and talks **only** the MCP protocol over stdio — it has no access to `vscode.*`
APIs. So the server cannot use VS Code's symbol providers directly; it needs its
own parsing (tree-sitter) and its own embedding/storage. This is deliberate: the
same server behaves identically whether invoked by Copilot, from the CLI, or in a
test, and the resource-heavy work (embedding, a ~300 MB model in memory) lives in
its own process rather than bloating the shared extension host.

The bridge extension exists precisely because the MCP server *can't* reach the
editor's language servers — so a thin companion extension relays that data over a
pipe. It has no chat integration; it only answers symbol queries.

---

## 3. Component breakdown (MCP server)

All paths under [`local-semantic-search-mcp/src/`](local-semantic-search-mcp/src/).

| Module | Responsibility |
|---|---|
| `index.ts` | Entry point. Startup ordering, background init, the `ready` gate, MCP wiring. |
| `config.ts` | Loads `.swe-search.config.json` (model, dtype, topKDefault, maxChunkTokens, `exclude`). Zod-validated with defaults. |
| `types.ts` | `Chunk`, `IndexedChunk`, `SearchResult`. |
| `ignore/ignoreMatcher.ts` | Combines built-in defaults + `.gitignore` + `.sweignore` + config `exclude` into a gitignore matcher. |
| `chunking/chunker.ts` | Three-tier chunk selection per file. |
| `chunking/treeSitterChunker.ts` | Symbol-boundary chunking via `web-tree-sitter` (WASM grammars). |
| `chunking/fallbackChunker.ts` | Fixed-window (60-line, 10-line overlap) chunking; skips binary. |
| `chunking/lspBridgeClient.ts` | Named-pipe client to the bridge extension; fails soft. |
| `chunking/pipeName.ts` | Deterministic pipe name from a hash of the workspace path. |
| `embedding/embedder.ts` | Wraps `@huggingface/transformers`; `embedBatch()` + progress logging. |
| `storage/store.ts` | `node:sqlite` metadata + Float32 BLOB vectors + brute-force cosine. |
| `storage/similarity.ts` | Cosine similarity. |
| `indexing/indexer.ts` | Full build + incremental per-file re-index; relative paths; prune. |
| `indexing/watcher.ts` | `chokidar` watcher + debounced/serialized/capped work queue. |
| `tools/semanticSearch.ts` | The `semantic_search` MCP tool. |

---

## 4. Data flow

### 4.1 Startup (index.ts)

```
spawn → create SQLite store → create McpServer
     → connect stdio transport IMMEDIATELY        ◄── answers MCP `initialize` at once
     → (background) load embedding model
                  → check model stamp (rebuild if model/dtype changed)
                  → buildFull(): walk → chunk → embed → store   [progress logged]
                  → prune stale entries
                  → start file watcher
     → resolve `ready`
```

**Why connect before indexing:** model load + a full index can take minutes. If
that sat in front of `server.connect()`, the MCP client's `initialize` request
would time out (~60s) before the server ever answered. So the transport connects
first and the heavy work runs in the background. The `ready` promise gates the
search tool, so a query arriving mid-build waits rather than racing an empty store.

### 4.2 Indexing one file (indexer.ts `indexFile`)

```
read file → sha1(content) = fileHash
   fileHash == stored?  ── yes ──► SKIP (no work)
        │ no
        ▼
   chunk the file (three-tier)
   load existing chunk embeddings for this file (by contentHash)
   for each chunk:
        contentHash seen before? ── reuse stored vector
                                  └ else → queue for embedding
   embedBatch(only the new/changed chunks)     ◄── batched, not one-at-a-time
   delete file's old rows → upsert new set → store new fileHash
```

Two levels of "don't redo work": **file-level** (unchanged file → skipped entirely)
and **chunk-level** (unchanged chunk within a changed file → vector reused).

### 4.3 Chunking tiers (chunker.ts)

Richest source first, each a soft fallback:

1. **LSP bridge** — real language-server symbols over the pipe (if the extension
   is running and answers in time).
2. **tree-sitter** — WASM grammar parse, symbol nodes (`function_declaration`,
   `class_declaration`, `method_definition`, …) for supported languages.
3. **Fixed-window** — 60-line windows with 10-line overlap, for everything else
   (config, markdown, unsupported languages). Skips binary (null-byte) files.

Chunk granularity is kept consistent across tiers: top-level symbols only, no
descent into a matched symbol's children.

### 4.4 Query (semanticSearch.ts)

```
semantic_search(query, topK?)
   → await ready
   → embed(query)                      ◄── same model as the index
   → load all stored vectors → cosine similarity vs query → sort → top-k
   → resolve each result's relative path to an absolute path for display
   → return { file:line, symbol, score, code } for each hit
```

### 4.5 Incremental updates (watcher.ts)

`chokidar` emits add/change/unlink. Events go through an `IndexQueue` that:
- **debounces** (300 ms) so editor save-storms collapse to one re-index;
- **serializes per file** — a file is never indexed by two tasks at once (no
  delete/upsert races); a change arriving mid-index re-queues it once;
- **caps concurrency** (4) so a `git checkout` touching hundreds of files doesn't
  spawn hundreds of competing embed jobs.

---

## 5. Storage

SQLite via Node's built-in `node:sqlite` (`DatabaseSync`) — no native module. One
file per workspace: `<workspace>/.swe-search/index.db`.

```sql
chunks(
  id TEXT PRIMARY KEY,        -- "<relPath>:<startLine>:<endLine>"
  file TEXT,                  -- workspace-relative, forward-slash
  symbol TEXT, startLine INT, endLine INT,
  text TEXT,                  -- the chunk source
  contentHash TEXT,           -- sha1(text) → chunk-level reuse key
  embedding BLOB              -- Float32Array, 768 dims → 3072 bytes
)
files(path TEXT PRIMARY KEY, fileHash TEXT)   -- file-level skip key
meta(key TEXT PRIMARY KEY, value TEXT)         -- "model", "dtype" stamp
```

- **Vectors as BLOBs:** each embedding is a `Float32Array` written as a raw little-
  endian BLOB. Search decodes them back to `Float32Array` views.
- **Brute-force cosine, deliberately:** no `sqlite-vec` / native vector index. The
  target is *tens of thousands* of chunks per repo, where scanning all vectors in
  memory is fine. This avoids a native dependency; revisit only if scale demands.
- **Transactions:** an index build wraps each file's inserts in a transaction —
  otherwise SQLite autocommits per row (an fsync per chunk), which is dramatically
  slower on a full build.
- **Relative paths → portable:** because `file`/`id`/`files.path` are workspace-
  relative, the whole `.db` can be copied to another machine/checkout and reused.
- **Model stamp → safe reuse:** `meta` records the embedding model + dtype. On
  startup a mismatched (or legacy absolute-path) index is wiped and rebuilt rather
  than silently compared against vectors from a different model.
- **Prune:** at the end of a full walk, entries for files no longer present (deleted
  or newly ignored) are removed, so shared/stale indexes don't leak dead results.

---

## 6. How the code index stays local

This is a hard design constraint (IT-locked-down machines), not a preference. Every
choice below removes a reason for the tool to touch the network or need admin/build
tools.

**Embedding runs in-process, on-device.**
`@huggingface/transformers` runs an ONNX model (`embeddinggemma-300m`, q8) via
`onnxruntime-node` on the CPU, inside the MCP server process. There is **no
embedding API call** — the vectors are computed locally. At query time the query is
also embedded locally. So indexing and searching make **zero network requests**.

**The only network touch is a one-time model download.**
On first run the model weights (~300 MB) are fetched from Hugging Face and cached
under `node_modules/@huggingface/transformers/.cache`. After that it is fully
offline. For air-gapped machines, that cache folder can be copied over to skip the
download entirely — no internet ever required.

**No open network port.**
The MCP server ↔ bridge extension link is a **Unix domain socket / Windows named
pipe**, not a loopback TCP port. It never touches the network stack, and the socket
file is `chmod 0600` (current user only). This deliberately avoids a listening
`localhost` port that a security scanner would flag.

**No native compilation.**
`node:sqlite` (built into Node), `web-tree-sitter` (WASM grammars), and the ONNX
runtime ship prebuilt. Nothing needs a C++ toolchain, so it installs on restricted
machines.

**No telemetry / no external services.**
Storage is a local SQLite file. There is no analytics, no cloud vector DB, no chat
integration in the bridge. The bridge extension has **zero runtime dependencies**
(only devDependencies for building) — nothing to audit for supply-chain/telemetry
risk in the process that shares VS Code's extension host.

**Net effect:** after the one-time model fetch, source code and embeddings stay on
disk on the developer's machine; the only process that ever reads the code is the
local server the developer launched.

---

## 7. Token-cost analysis

There are two separate token budgets. The tool affects them very differently.

### 7.1 Indexing / embedding — zero LLM tokens

Embeddings are produced by a **local** model, not an LLM API. Building and
maintaining the index costs **no API/LLM tokens at all** — only CPU. If the
alternative were a hosted embedding API, this is a 100% saving on that axis.

### 7.2 The agent's retrieval loop — where LLM tokens are saved

When you ask an agent "where is X handled?", *without* semantic search it explores
by reading/grepping files, pulling large amounts of code into context to locate the
relevant part:

- Typical: read ~5–15 files, often whole files of 100–500 lines, sometimes re-sent
  across turns. Order of magnitude: **~15K input tokens** just to *find* the code.

*With* semantic search, one tool call returns the top-k relevant chunks:

- Default `topK = 8`, each a function/class (~25 lines) → ~200 lines ≈ **~1.5–2K
  tokens**.

So on the *locate-the-code* step, roughly a **5–10× reduction** for "where is X /
find code that does Y" tasks — and often *better* answers, because the model sees
relevant code instead of a noisy pile of whole files.

### 7.3 Honest limits

- Saves tokens on **retrieval/exploration only**, not on the model's reasoning or
  code generation afterward.
- The returned chunks still cost input tokens — targeted, not free.
- **Highly task-dependent.** Big for "locate/understand across the codebase"; little
  for tasks that read specific known files anyway, or on tiny repos.
- The model must actually *choose* to call the tool. Its description is written to
  encourage that, and a `.github/copilot-instructions.md` can nudge it, but only an
  explicit `#semantic_search` guarantees it.

### 7.4 Knobs that control per-call cost

- **`topK`** (default 8) — fewer results, fewer tokens.
- **Chunk size** — the tool currently returns each result's full chunk body. A
  future "compact" mode (return `file:line + symbol + short snippet`, let the agent
  open the file for detail) would cut per-call tokens ~3–5× at some recall cost.

---

## 8. Performance characteristics

Measured on a developer laptop (Node 24, CPU-only), `embeddinggemma-300m` q8:

| Metric | Value |
|---|---|
| Embed throughput (sequential) | ~660 ms/chunk |
| Embed throughput (batched) | ~380 ms/chunk (~1.7×) |
| Model load (from cache) | ~1.6 s |
| Cold index (small repo, ~50 chunks) | ~30–70 s |
| **Warm restart** (all unchanged) | **~2 s, 0 re-embedded** |
| Edit one function | re-embeds ~1 chunk, not the whole file |

The dominant cost is embedding, and it is **CPU-bound and already multi-threaded**
(the ONNX runtime saturates cores — visible as high CPU during a build). That means
the levers are *doing less work* (skip/reuse/prune, excludes) or a *smaller model*,
not more threads.

**Scaling notes:**
- Time scales with **chunks embedded**, not raw file count — ignored files are free.
- Brute-force cosine is linear in stored chunks; fine to tens of thousands, the
  target range. Beyond that, a vector index (`sqlite-vec`) would be the next step.
- First index of a very large repo (tens of thousands of files) can take hours; it
  is **one-time and resumable** (stop/reopen continues), and restarts are near-
  instant. For big repos, trim with `exclude`/`.sweignore` and/or switch to a
  smaller model (e.g. `all-MiniLM-L6-v2`, ~10–20× faster).

---

## 9. The LSP bridge (optional tier)

[`lsp-bridge-extension/`](lsp-bridge-extension/) — a thin VS Code extension.

- **Activation:** `onStartupFinished`. Opens a `net.Server` on the deterministic
  pipe path (same hash of the workspace root the MCP server computes independently —
  no coordination file). On Unix the socket is `chmod 0600`.
- **Protocol:** newline-delimited JSON over the pipe. Request
  `{id, type:"getSymbols", file}` → response `{id, symbols:[{name,kind,startLine,endLine}]}`.
- **Symbols:** `vscode.executeDocumentSymbolProvider` (the editor's own outline
  data), filtered to Function/Method/Class/Constructor, flattened to top level.
- **Failure is silent:** if the extension isn't running or times out, the MCP
  server's `lspBridgeClient` returns `null` and chunking falls back to tree-sitter.
  The bridge is never a hard dependency.
- **Zero runtime dependencies**, no chat integration — it only answers symbol
  queries.

---

## 10. Key design decisions, summarized

| Decision | Rationale |
|---|---|
| Standalone MCP server (not all-in-extension) | Copilot spawns it over stdio with no `vscode.*` access; keeps heavy work out of the extension host. |
| Local ONNX embedding | No embedding API, no per-query network, works offline. |
| `node:sqlite` + Float32 BLOBs + brute-force cosine | No native compilation; simple; fine at target scale. |
| WASM tree-sitter | Language-agnostic chunking with no C++ toolchain. |
| Named pipe, not TCP | No open localhost port for scanners to flag. |
| Relative paths + model stamp | Portable, shareable index across machines/checkouts. |
| File-hash + chunk-hash incrementalism | Cheap restarts and edits; only real changes cost embedding. |
| Connect transport before indexing | Avoids the MCP `initialize` timeout on slow startups. |
| Debounced/serialized/capped watcher | Correct, non-racing incremental updates under bursty changes. |
