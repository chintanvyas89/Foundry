# Copilot instructions

## Finding code in this workspace

When you need to locate code, understand where functionality lives, or find code
related to a request — e.g. "where is X handled?", "what code does Y?", or "find
something similar to Z" — **use the `semantic_search` tool first**, before reading
files individually or grepping.

`semantic_search` does a local, offline semantic search over this workspace and
returns the most relevant functions/classes ranked by meaning, each with its file
path and line range. Use its results to jump straight to the right files, then open
only those files for detail. Fall back to reading/searching files directly only if
semantic_search doesn't surface what you need.

This is faster and uses far less context than scanning the codebase file by file.

## Drilling down

If the first results are close but not exact, don't give up or start reading
files — **call `semantic_search` again to refine**:

- Set `mode: "refine"` to narrow to the strongest matches, or `mode: "expand"`
  to broaden when nothing looks right.
- Add a `note` to sharpen intent (e.g. `note: "the retry/backoff logic"`).
- Pass `pinResults` with the **numbers** of the results that were on-target
  (e.g. `pinResults: [1, 3]`) to steer the next search toward them. The server
  remembers your previous results, so you only pass the numbers — no ids.

Iterate this way a couple of times before falling back to reading files.

## Tracing execution flow

Once `semantic_search` locates a function, use **`trace_calls`** to follow the
call graph instead of reading files to find callers/callees. Pass the result's
`file` and `startLine` (and `symbol` if known); it returns the functions it calls
and the functions that call it, each with a `file:line` you can `trace_calls`
again to walk further. Good for "who calls X", "what does X call", "trace the
checkout/auth flow".

`trace_calls` needs the VS Code LSP bridge running and can't resolve dynamic
dispatch (interfaces/callbacks/DI), cross-language calls, or data flow — for
those, fall back to `semantic_search` (it finds likely candidates by meaning).
