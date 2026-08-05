import { isAbsolute, join, relative, sep } from 'node:path';

// Normalize a caller-supplied `file` argument into the two forms the tools need.
//
// Tools receive a `file` from an LLM/agent that may be EITHER absolute (as
// semantic_search / trace_calls emit) OR workspace-relative (as search_symbol's
// text and architecture_overview show). The old `relative(workspaceRoot, file)`
// assumed absolute input and silently mangled a relative path into
// `../../…/file`, so the persisted-index lookup (and the bridge) returned
// nothing. This accepts both:
//   - `abs`: absolute path, for the LSP bridge (VS Code needs a real fs path);
//   - `rel`: workspace-relative, '/'-joined, matching how paths are stored in
//     the index (`files.path`, `symbol_refs`, `call_edges`, …).
export function normalizeFileArg(
  file: string,
  workspaceRoot: string,
): { abs: string; rel: string } {
  const abs = isAbsolute(file) ? file : join(workspaceRoot, file);
  const rel = relative(workspaceRoot, abs).split(sep).join('/');
  return { abs, rel };
}
