# Copilot instructions

## Mandatory workflow for implementation tasks

For any task that involves implementing, changing, debugging, or extending
existing behavior, use the semantic-search workflow first.

Required behavior:
1. If the task requires understanding existing implementation, use semantic_search
   to locate the relevant symbols, modules, or functions by meaning.
2. If the task involves execution flow, call trace_calls on the relevant symbol
   to inspect callers and callees before making changes.
3. Only after semantic_search and trace_calls have been used should you read
   specific files or use targeted text search for details.
4. Do not rely on broad grep or ad-hoc file reading as the primary approach when
   the goal is to understand or modify existing implementation.

This applies even when the user asks for a direct implementation request such as
"implement X" or "fix Y"; in those cases, the agent should still inspect the
current code paths through semantic_search and trace_calls before editing.

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

When you already know the exact identifier — a specific function, class, or method
name like `VectorStore` or `getUserById` — use **search_symbol** (a direct
name lookup, ranked exact > prefix > substring) instead of semantic_search, which
is weaker at exact names. Use semantic_search when you know *what the code does*
but not what it's called; use search_symbol when you know the name.

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

Trace calls needs the VS Code LSP bridge running and can't resolve dynamic
dispatch (interfaces/callbacks/DI), cross-language calls, or data flow — for
those, fall back to semantic_search (it finds likely candidates by meaning).

Related bridge-backed tools (same file/line inputs): **find_usages** lists every
reference to a symbol across the workspace (use for "where is X used?" and impact
analysis before a change), and **find_implementations** finds the concrete
implementations of an interface/abstract member.
