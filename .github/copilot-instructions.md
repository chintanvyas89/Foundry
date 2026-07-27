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
