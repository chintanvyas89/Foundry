# Foundry — status & roadmap

_Last updated: 2026-08-04_

Foundry today is a **local, offline semantic code search** system for VS Code: an
MCP server that indexes a repo into embeddings (in-process ONNX, SQLite) and
answers a `semantic_search` tool, plus a VS Code extension that adds a no-LLM
search UI and an LSP symbol bridge. It works both with Copilot agent mode and
standalone (no LLM, no network). This doc reconciles what's actually built with
the full "code intelligence platform" vision (preserved verbatim in the
appendix), and lays out what to build next.

Status legend: ✅ done · 🟡 partial · ⬜ not started.

## Implemented ✅

**Core search**
- MCP server + `semantic_search` tool over stdio — `local-semantic-search-mcp/src/index.ts`, `src/tools/semanticSearch.ts`
- In-process ONNX embeddings (embeddinggemma-300m, q8); SQLite vector store (`chunks`/`files`/`meta`); brute-force cosine — `src/embedding/embedder.ts`, `src/storage/store.ts`, `src/storage/similarity.ts`
- Incremental content-hash indexing + chokidar watcher (skips unchanged files, reuses chunk embeddings) — `src/indexing/indexer.ts`, `src/indexing/watcher.ts`
- Three-tier chunking: LSP bridge → tree-sitter → fixed-window — `src/chunking/*`
- **Call graph / execution flow (on-demand)**: callers/callees via the language server, exposed as a panel **Calls** action and a **`trace_calls`** MCP tool — `lsp-bridge-extension/src/callHierarchy.ts`, `local-semantic-search-mcp/src/tools/traceCalls.ts`, `src/chunking/lspBridgeClient.ts`
- **Symbol-name search**: `search_symbol` MCP tool + panel "Symbol name" toggle — exact/prefix/substring lookup over indexed symbols; the exact-identifier complement to embedding search — `local-semantic-search-mcp/src/tools/searchSymbol.ts`, `store.searchSymbols`
- **Usages / implementations (on-demand)**: `find_usages` + `find_implementations` MCP tools and a panel **Uses** button — references/implementations via the language server — `lsp-bridge-extension/src/references.ts`, `local-semantic-search-mcp/src/tools/symbolRefs.ts`
- **Hybrid retrieval (FTS5 + embeddings)**: `semantic_search` fuses vector ranking with a bounded FTS5 lexical bonus, so exact identifiers/tokens the embedding misses still surface — without regressing natural-language queries. Identifiers are **split at index + query time** (`cosineSimilarity` ↔ "cosine similarity", `get_user_by_id` ↔ "user id") so word-level queries match compound names. Transparent to callers; no new tool, no re-embed (a one-time FTS text backfill/upgrade reuses stored chunk text, version-gated) — `src/storage/store.ts` (`searchHybrid`/`searchText`/`backfillFts`/`ftsAugment`), `src/tools/semanticSearch.ts`
- **Token-lean output**: `semantic_search` returns compact signatures (symbol + file:line + score + one-line signature) by default; `expand=[n,…]` pulls full bodies of chosen prior hits without re-querying, and `detail="full"` returns all bodies. Full text still goes to UI clients via `structuredContent` — `src/tools/semanticSearch.ts`, `store.getChunksByIds`
- **Architecture map (Ph9, deterministic)**: `architecture_overview` MCP tool aggregates the persisted symbols/usages/call-graph indexes into a module-level map (modules = directories) — each module's dependencies/dependents (from the usages index), call-graph entry points (roots), and reference hotspots; `module="<path or name>"` drills into one module (files, key symbols, deps). No embedder, no bridge, no schema change, no re-index; the LLM narrates prose from the structured map — `src/tools/architectureOverview.ts`, `src/storage/store.ts` (`refEdges`/`symbolHotspots`/`allSymbolRows`/`callEdges`)
- **Persisted, shareable call graph**: an explicit one-time build (`SWE_BUILD_GRAPH=1`) walks the LSP bridge and stores directed caller→callee edges in `call_edges` (workspace-relative, so the graph rides inside `index.db` and is shareable — teammates get it offline, no bridge/LSP). Resumable + incremental (`graph_files` markers, watcher refetch on change). `trace_calls` falls back to this graph when the bridge is down. Embedding-free — reuses indexed symbols, no re-embed — `src/indexing/graphBuilder.ts`, `src/storage/store.ts` (`call_edges`/`getCallees`/`getCallers`/`upsertEdges`), `src/tools/traceCalls.ts`

**Beyond the original vision** (built, though not in the 16 phases)
- Relevance feedback: `pins` / `note` / `mode` (refine/expand), incl. **pin-by-result-number** so the LLM can steer without exposing chunk ids — `src/tools/semanticSearch.ts`
- Portable / shareable index: relative paths + model stamp + startup prune — `src/storage/store.ts`, `src/indexing/indexer.ts`
- Single-instance lock + WAL so search coexists with indexing; query-only mode — `src/lock.ts`, `src/index.ts`
- `structuredContent` output for non-LLM clients
- Config + `.sweignore` excludes — `src/config.ts`, `src/ignore/ignoreMatcher.ts`
- **No-LLM VS Code search UI**: Search-by-meaning (QuickPick), Find-similar, and a sidebar panel with a context tray, pins, refine/expand, and code-snippet cards — `lsp-bridge-extension/src/searchPanel.ts`, `searchCommands.ts`, `searchClient.ts`
- **Lazy indexing (Ph11)**: the initial build no longer blocks search behind a full embedding pass. Files are embedded **most-recently-modified first** (the developer's hot set); once that set is in, `semantic_search` opens and returns partial results with an *"index N% building"* note while the rest streams in the background. A **priority embed queue** (`src/embedding/embedder.ts`) makes a live query's embed preempt the background build (one shared ONNX pipeline). Two gates in `src/indexing/indexState.ts` — `searchable` (hot set done) and `indexComplete` (whole repo; the opt-in `SWE_BUILD_*` passes await it). Default on; `lazyIndex: false` (config) restores block-until-complete; `lazyHotSet` tunes the hot-set size. Unchanged files still skip via content hash — **no re-embed**; `repo_overview` reports `indexing: building (N%) → complete` — `src/indexing/indexer.ts` (mtime order + hot-set-first), `src/index.ts`, `src/tools/semanticSearch.ts`
- **`@codebase` chat participant + Copilot Language Model tools**: the local index made available *inside Copilot Chat* for teams that disable Copilot's cloud workspace index. `@codebase` runs an agentic loop — the model drives our `foundry_*` tools (registered as VS Code Language Model tools over the same query-only search client) to ground answers on-device; each tool call surfaces as progress (visible retrieval plan) and answers cite files + a "Grounded via" trailer. Slash commands `/index`, `/arch`, and `/plan` (grounded implementation plan). `#foundryCodebase` is the drop-in for the disabled `#codebase` inside Copilot's own chat/agent mode. Zero runtime deps (hand-rolled on the VS Code API), read-only over `index.db` — no re-embed — `lsp-bridge-extension/src/chatParticipant.ts`, `languageModelTools.ts`, `searchClient.ts` (`callTool`)
- LLM drill-down guidance — `.github/copilot-instructions.md`

## Partial 🟡
- **Repo metadata (Ph1):** `files(path, fileHash)` only — no `repositories` table or size/mtime columns; a `repo_overview` tool now reports file/chunk counts, language breakdown (by extension), and which indexes are built (`store.repoStats`, `src/tools/repoOverview.ts`).
- **LSP symbols (Ph2):** callable symbols are queryable via `search_symbol` (over `chunks.symbol`) and the persisted call graph; a standalone `symbols` table now also covers **non-callable kinds** (interfaces/enums/consts/types) via an opt-in `SWE_BUILD_SYMBOLS` pass — `src/indexing/symbolBuilder.ts`, `store.symbols`. Still partial: no `chunk_symbol_mapping` join table.
- **Chunk mapping (Ph5):** chunks carry a `symbol` name; no `chunk_symbol_mapping` table.
- **Retrieval / context expansion (Ph10/12):** embedding search + bounded-FTS hybrid + vector-blend relevance feedback + compact/expand token control; call-graph context is now folded into retrieval opt-in (`context=true` annotates each hit with callers/callees); still open: enclosing-parent/test context and intent detection.
- **MCP tools (Ph13):** 8 of 12 (`semantic_search` — now hybrid vector+FTS, `search_symbol`, `trace_calls`, `show_execution_flow`, `find_usages`, `find_implementations`, `repo_overview`, `architecture_overview`).
- **Tree-sitter (Ph14):** chunking only; no import/symbol/relationship extraction.
- **Incremental (Ph16):** chunks + watcher done; no graph invalidation or summaries.

## Not started ⬜
API graph (Ph6), DB graph (Ph7), visualizations (Ph15). (Symbol relationships/edges, Ph3, are now persisted as the call graph — see Implemented. Architecture summaries, Ph9, now ship as the deterministic `architecture_overview` map — see Implemented; LLM-authored prose summaries remain a later option.)

## Next up (prioritized)

### ✅ 1. Call graph / execution flow — shipped (on-demand + persisted)
Callers/callees are computed via the language server in
`lsp-bridge-extension/src/callHierarchy.ts`, exposed two ways: a **Calls** button
on each panel result, and a **`trace_calls`** MCP tool for Copilot over the bridge
pipe (`src/chunking/lspBridgeClient.ts` → `getCallHierarchyViaBridge`,
`local-semantic-search-mcp/src/tools/traceCalls.ts`). The graph is now also
**persisted** (`call_edges`) via an explicit one-time build
(`SWE_BUILD_GRAPH=1`, `src/indexing/graphBuilder.ts`) — resumable, incremental,
shareable inside `index.db`, and queried offline by `trace_calls` when the bridge
is down.
- **`show_execution_flow`** (shipped): a bounded-depth, multi-level walk over the
  persisted graph in one call (`src/tools/showExecutionFlow.ts`) — callees or
  callers, with cycle + node-count guards; offline once the graph is built.
- **Explorable call tree in the panel** (shipped): the extension's **Calls** action
  opens a lazily-expandable tree (`lsp-bridge-extension/src/searchPanel.ts`) — each
  node expands its callers/callees inline via the live language server, click to
  open, cycle-guarded. No-LLM.
- **Caveats:** the *build* needs the bridge (VS Code + a language server) running;
  once built, queries are offline. Cannot resolve dynamic dispatch,
  cross-language, or data flow (semantic search stays the complement).

### ✅ 2. Symbol tools (Ph2/3) — shipped
`search_symbol` (name lookup over indexed chunk symbols **plus** the standalone
`symbols` table), `find_usages`, and `find_implementations` (references/
implementations via the bridge). The persisted `call_edges` table (see #1) covers
whole-repo caller/callee relationships offline, and the standalone **`symbols`
table** (`SWE_BUILD_SYMBOLS`, `src/indexing/symbolBuilder.ts`) now adds
non-callable kinds (interfaces/enums/consts/types) — embedding-free, shareable in
`index.db`, incremental via the watcher. **Persisted `find_usages`** (`symbol_refs`,
`SWE_BUILD_USAGES`, `src/indexing/usageBuilder.ts`) now stores references for every
declaration in the symbol table, so `find_usages` answers offline (bridge-down
fallback, like `trace_calls`) — embedding-free and shareable. **Persisted
`find_implementations`** (`symbol_impls`, `SWE_BUILD_IMPLS`,
`src/indexing/implsBuilder.ts`) does the same for implementations. All four
persisted indexes can be built in one pass with **`SWE_BUILD_ALL=1`** (symbols →
graph → usages → impls, in dependency order).

### ✅ 3. Hybrid retrieval: FTS5 + embeddings (Ph8/10) — shipped
`semantic_search` now fuses semantic (cosine) ranking with a **bounded FTS5
lexical bonus** (`src/storage/store.ts` → `searchHybrid`/`searchText`), fixing the
exact-identifier weakness of pure vector search. The bonus is capped so a clearly
stronger semantic hit is never dethroned — lexical evidence only decides among
near-ties — so it can't regress a natural-language query pure vector got right.
FTS5 is optional at runtime (degrades to vector-only if the sqlite build lacks
it) and is kept in sync from the write path; a one-time `backfillFts` populates it
from existing chunk text with **no re-embed**.
- **Identifier splitting:** `ftsAugment` splits `camelCase`/`snake_case`/`kebab`
  names into their sub-words at index time (and `toFtsMatch` at query time), so a
  word-level query matches a single-token identifier (`cosineSimilarity` ↔ "cosine
  similarity"). The FTS content is version-stamped (`fts_version`); a stale index
  rebuilds its lexical rows once on the next writer start — still no re-embed.

### ✅ 4. Token efficiency (Ph12 + compact output) — shipped (partial)
`semantic_search` is **compact by default** (`src/tools/semanticSearch.ts` →
`renderCompact`): each hit is a symbol + `file:line` range + score + one-line
signature, so the model triages without whole function bodies in context.
`expand=[n,…]` fetches the full code of chosen prior hits with no re-query
(`store.getChunksByIds`); `detail="full"` returns every body at once. UI clients
still get full text via `structuredContent`.

**Structural context expansion — shipped (opt-in).** `context=true` annotates
each hit with a one-line summary drawn from the persisted indexes: its enclosing
parent (`getEnclosingSymbol`, symbol table), callers/callees (`getCallers`/
`getCallees`, call graph), and related tests (`getUsages` filtered to test paths,
usages index) — rendered as `in Parent · calls: … · called by: … · tests: …`. So
the model gets structural context in the same call, no separate `trace_calls`/
`find_usages`. Each source is used only if built; opt-in to stay token-lean.
Embedding-free.
- **Still open:** intent detection (route query → semantic vs symbol vs usages).

### 5. Later bets — recommended next
API/DB graphs (Ph6/7), visualizations (Ph15), and
LLM-authored prose architecture summaries (Ph9 — the deterministic
`architecture_overview` map already ships; prose narration is the optional next
step, likely driven by the consuming LLM rather than the offline server).

## Known limitations
- The persisted indexes (call graph, symbols, usages, implementations) are built on demand (`SWE_BUILD_GRAPH` / `SWE_BUILD_SYMBOLS` / `SWE_BUILD_USAGES` / `SWE_BUILD_IMPLS`, or `SWE_BUILD_ALL`); until built, `trace_calls`/`show_execution_flow`/`find_usages`/`find_implementations` need the live bridge and `search_symbol` covers callables only.
- Semantic search **can't do data flow**, and only *suggests candidates* for dynamic dispatch / cross-language boundaries — verify before trusting an edge.
- Whether Copilot auto-calls `semantic_search` is the model's choice; `#semantic_search` forces it and `.github/copilot-instructions.md` nudges it.

---

## Appendix: full vision (16 phases)

The original end-to-end roadmap, preserved in full below.

# Code Intelligence Platform - Step-by-Step Implementation Plan (LSP First)

## Vision

Build a local-first, AI-native repository intelligence platform that understands code architecture, execution flow, dependencies, APIs, database usage, and repository relationships.

The system should expose repository intelligence to AI agents through an MCP server while minimizing token usage and maximizing architectural understanding.

---

## Design Principles

1. Local-first architecture.
2. Language Server Protocol (LSP) as the primary semantic intelligence source.
3. Tree-sitter as a fallback parser.
4. Incremental and lazy indexing.
5. Graph-based repository intelligence.
6. Hybrid retrieval using symbols, graph traversal, full-text search, and embeddings.
7. AI-agent-friendly context expansion.

---

## High-Level Architecture

```text
Repository
    ↓
Language Detection
    ↓
-------------------------------
|                             |
LSP Supported              No LSP
|                             |
Language Server             Tree-sitter
|                             |
Semantic Information        AST Information
|                             |
-------------------------------
              ↓
        Repository Indexer
              ↓
         Graph Builder
              ↓
             SQLite
              ↓
      Retrieval Engine
              ↓
          MCP Server
              ↓
           AI Agents
```

---

## Phase 1 - Repository Metadata

### Goal

Store repository information and enable incremental indexing.

### Tables

```text
repositories
-------------
id
name
path
branch
last_indexed

files
------
id
repository_id
path
extension
language
sha256
size
last_modified
```

### Tasks

* Index repository files.
* Detect language.
* Store file metadata.
* Detect changed files using hashes.
* Support incremental indexing.

---

## Phase 2 - LSP Integration

### Goal

Use Language Servers as semantic analyzers.

### Supported LSP APIs

```text
workspace/symbol

textDocument/documentSymbol
```

### Tasks

Retrieve:

```text
Classes
Methods
Functions
Interfaces
Enums
Structs
Packages
Modules
Variables
Constants
```

### Tables

```text
symbols
-------

id
file_id
name
type
signature
language
start_line
end_line
visibility
```

### Deliverables

* LSP client.
* Symbol extraction.
* Repository symbol indexing.

---

## Phase 3 - Symbol Relationships

### Goal

Understand repository relationships.

### LSP APIs

```text
textDocument/references

textDocument/definition

textDocument/implementation

textDocument/typeDefinition
```

### Relationships

```text
references
implements
defines
inherits
uses
depends_on
```

### Tables

```text
edges
------

source_symbol_id
target_symbol_id
relationship_type
```

### Deliverables

Support:

```text
Show all implementations.

Find usages of a symbol.

Show inheritance hierarchy.

Find symbol definitions.
```

---

## Phase 4 - Call Graph

### Goal

Build execution flow.

### LSP APIs

```text
callHierarchy/prepareCallHierarchy

callHierarchy/incomingCalls

callHierarchy/outgoingCalls
```

### Tables

```text
call_graph
-----------

caller_symbol_id
callee_symbol_id
```

### Example

```text
CheckoutAPI

↓

CheckoutService

↓

PaymentService

↓

InventoryService

↓

Database
```

### Deliverables

Support:

```text
Who calls this method?

Show payment flow.

Show authentication flow.

What is impacted by changing this symbol?
```

---

## Phase 5 - Chunk Mapping

### Goal

Perform semantic chunking.

Chunks should never exist independently.

### Relationships

```text
Chunk

↓

Method

↓

Class

↓

Module
```

### Tables

```text
chunks
-------

id
content
embedding

chunk_symbol_mapping
--------------------

chunk_id
symbol_id
```

### Deliverables

* Symbol-aware embeddings.
* Semantic chunk retrieval.

---

## Phase 6 - API Graph

### Goal

Index repository entry points.

### Extract

```text
REST APIs

GraphQL

gRPC

CLI Commands

Cron Jobs

Queue Consumers

Event Handlers
```

### Tables

```text
apis
-----

id
method
path
symbol_id

api_flow
--------

api_id
symbol_id
```

### Deliverables

Generate complete request flows.

---

## Phase 7 - Database Graph

### Goal

Track database relationships.

### Extract

```text
Tables

Collections

Queries

ORM Models

Migrations
```

### Relationships

```text
reads

writes

updates

deletes
```

### Tables

```text
database_entities

database_relationships
```

### Deliverables

Support:

```text
Which API updates the User table?

Show database dependencies.

Who reads Orders?
```

---

## Phase 8 - Full Text Search

### Goal

Provide fast symbol and file lookups.

### Technology

```text
SQLite FTS5
```

### Index

```text
Files

Symbols

Imports

Signatures

Documentation

Comments
```

### Search Strategy

```text
Exact Match
    ↓
SQLite FTS
    ↓
Embeddings
    ↓
Graph Traversal
```

---

## Phase 9 - Architecture Summaries

### Goal

Generate AI-friendly repository summaries.

### Summary Levels

```text
Repository

↓

Module

↓

Directory

↓

File

↓

Symbol
```

### Example

```text
Authentication Module

Responsibilities:
- Login
- Session Management
- JWT Generation

Dependencies:
- Redis
- OAuth Provider

Exposed APIs:
- POST /login
- POST /logout
```

### Deliverables

* Architectural summaries.
* Summary embeddings.

---

## Phase 10 - Retrieval Engine

### Goal

Provide intelligent repository retrieval.

### Pipeline

```text
User Query

↓

Intent Detection

↓

Symbol Search

↓

Graph Traversal

↓

Full Text Search

↓

Embedding Search

↓

Context Expansion

↓

Source Retrieval

↓

LLM Context Builder

↓

Answer
```

---

## Phase 11 - Lazy Indexing and LSP Enrichment

### Goal

Avoid indexing the entire repository upfront.

### Example

```text
Repository Opened

↓

Load Workspace Symbols

↓

Store Symbol Metadata

----------------------------

User Query:
How does authentication work?

↓

Find Authentication Symbols

↓

Retrieve References

↓

Retrieve Call Hierarchy

↓

Build Graph

↓

Persist Results

↓

Return Context
```

### Benefits

```text
Smaller initial indexing time.

Incremental graph construction.

Faster repository onboarding.
```

---

## Phase 12 - Context Expansion

### Goal

Provide highly relevant context to the LLM.

### Expand Using

```text
Parent Symbol

Caller

Callee

Dependencies

Tests

APIs

Database Usage

Architecture Summary
```

### Example

Instead of:

```text
20 random chunks
```

Provide:

```text
CheckoutService

+

Related Methods

+

Call Hierarchy

+

Database Usage

+

Tests

+

Architecture Summary

+

Relevant Code
```

---

## Phase 13 - MCP Server

### Goal

Expose repository intelligence to AI agents.

### MCP Tools

```text
search_symbol()

search_code()

find_callers()

find_callees()

show_execution_flow()

show_architecture()

find_dependencies()

find_related_files()

find_database_usage()

find_api_flow()

impact_analysis()

repository_summary()
```

---

## Phase 14 - Tree-sitter Fallback

### Goal

Support unsupported languages and non-code files.

### Supported Targets

```text
Terraform

YAML

Markdown

SQL

Dockerfile

Proto Files

GraphQL

Unsupported Languages
```

### Responsibilities

```text
AST Parsing

Import Extraction

Symbol Extraction

Basic Relationships
```

### Deliverables

* Universal repository support.

---

## Phase 15 - Visualizations

### Goal

Improve developer experience.

### Views

```text
Repository Graph

Module Graph

Dependency Graph

Call Graph

API Graph

Database Graph
```

---

## Phase 16 - Incremental Indexing

### Goal

Support near real-time repository updates.

### Pipeline

```text
Git Changes

↓

Changed Files

↓

Re-index

↓

Update Symbols

↓

Update Graph

↓

Invalidate Relationships

↓

Update Summaries
```

---

## Suggested Milestone Order

### Milestone 1

* Repository metadata
* LSP client
* Symbol extraction

### Milestone 2

* References
* Definitions
* Implementations
* Type information

### Milestone 3

* Call hierarchy
* Chunk mapping
* Full text search

### Milestone 4

* API graph
* Database graph
* Architecture summaries

### Milestone 5

* Intelligent retrieval engine
* Lazy indexing
* Context expansion

### Milestone 6

* MCP server
* Visualizations
* Incremental indexing
* Tree-sitter fallback

---

## Recommended Tech Stack

```text
Semantic Intelligence:
- Language Server Protocol

Fallback Parser:
- Tree-sitter

Storage:
- SQLite

Search:
- SQLite FTS5

Embeddings:
- Existing embedding pipeline

Graph Layer:
- SQLite relationship tables

Repository Tracking:
- Git

AI Layer:
- LLM + RAG

Agent Layer:
- MCP Server

Editor Integration:
- VS Code Extension
```

---

## Final Architecture

```text
Repository

↓

Language Detection

↓

Language Server Protocol

↓

Tree-sitter Fallback

↓

Symbol Extraction

↓

Relationship Extraction

↓

Call Hierarchy

↓

API Graph

↓

Database Graph

↓

Chunk Mapping

↓

Architecture Summaries

↓

SQLite Repository Graph

↓

Hybrid Retrieval Engine

↓

Context Expansion

↓

MCP Server

↓

AI Agents / VS Code Extension
```

## End Goal

The final system should behave like a "Google Maps for repositories", allowing developers and AI agents to:

* Understand repository architecture.
* Traverse execution flows.
* Perform impact analysis.
* Explore APIs and database relationships.
* Retrieve semantically relevant code.
* Minimize token usage.
* Work entirely locally.
* Support polyglot repositories.
* Expose repository intelligence through MCP tools.

