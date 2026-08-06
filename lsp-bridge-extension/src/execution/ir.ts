// Workflow IR — the contract between planning and execution (execution-v2.md §5-§8).
//
// The planner (via the compiler) emits a Workflow; the Execution Engine interprets
// it deterministically. Nothing here carries natural-language "implementation" — a
// step's `script` is a list of executable operations. Types cover all four executors
// so the IR is complete; P1 only *executes* the `workspace` ones.

export const WORKFLOW_IR_VERSION = '2.0';

export type ExecutorKind = 'workspace' | 'user' | 'terminal' | 'validation';

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

// Anchor an edit to a symbol rather than a line number — line numbers rot the
// instant an earlier op edits the same file, so anchored ops are re-resolved
// against the current buffer per operation (see symbolResolver). `symbol` may be
// a dotted path (e.g. "UserService.CreateUser"); the optional fields disambiguate
// when a name is not unique (overloads, same-named nested members).
export interface SymbolTarget {
  file: string;
  symbol: string;
  container?: string; // enclosing symbol name, when the plain name is ambiguous
  index?: number; // pick the Nth match (0-based) when several remain
  signature?: string; // substring of the declaration line to disambiguate overloads
}

export interface FileTarget {
  file: string;
}

// ---------------------------------------------------------------------------
// Workspace operations (full set — execution-v2.md §6)
// ---------------------------------------------------------------------------

interface OpBase {
  // Optional human-readable note; ignored by executors, handy in diffs/logs.
  description?: string;
}

// Replace the whole body of a resolved symbol. replace_function / replace_method /
// replace_block are distinct tags only for planner intent + validation; the
// executor treats them identically (replace the symbol's full range).
export interface ReplaceSymbolOp extends OpBase {
  operation: 'replace_function' | 'replace_method' | 'replace_block';
  target: SymbolTarget;
  replacement: string;
}

// Line-based replacement (1-based, inclusive). Discouraged vs. anchored ops; kept
// for cases with no resolvable symbol. Never precompute these across ops in one file.
export interface ReplaceLinesOp extends OpBase {
  operation: 'replace_lines';
  target: FileTarget;
  startLine: number;
  endLine: number;
  replacement: string;
}

export interface InsertOp extends OpBase {
  operation: 'insert_before' | 'insert_after';
  target: SymbolTarget;
  code: string;
}

export interface ReplaceTextOp extends OpBase {
  operation: 'replace_text';
  target: FileTarget;
  find: string;
  replace: string;
  all?: boolean; // replace every occurrence (default: first only)
}

export interface AppendPrependOp extends OpBase {
  operation: 'append' | 'prepend';
  target: FileTarget;
  code: string;
}

export interface CreateFileOp extends OpBase {
  operation: 'create_file';
  file: string;
  contents: string;
  overwrite?: boolean; // default false — fail if the file already exists
}

export interface DeleteFileOp extends OpBase {
  operation: 'delete_file';
  file: string;
}

// Rename a symbol *and its references* via the language's rename provider.
export interface RenameSymbolOp extends OpBase {
  operation: 'rename_symbol';
  target: SymbolTarget;
  newName: string;
}

export interface ImportOp extends OpBase {
  operation: 'add_import' | 'remove_import';
  target: FileTarget;
  statement: string; // the exact import line to add, or a substring to remove
}

export interface MoveFileOp extends OpBase {
  operation: 'move_file';
  from: string;
  to: string;
}

export type WorkspaceOperation =
  | ReplaceSymbolOp
  | ReplaceLinesOp
  | InsertOp
  | ReplaceTextOp
  | AppendPrependOp
  | CreateFileOp
  | DeleteFileOp
  | RenameSymbolOp
  | ImportOp
  | MoveFileOp;

// ---------------------------------------------------------------------------
// Other executors' operations (defined now; executed in later phases)
// ---------------------------------------------------------------------------

export interface ManualOperation {
  operation: 'manual';
  instructions: string[];
}

export interface TerminalOperation {
  operation: 'run';
  command: string;
  cwd?: string;
}

export interface ValidationOperation {
  operation: 'validate';
  kind: 'build' | 'tests' | 'lint' | 'diagnostics' | 'custom';
  command?: string; // required for build/tests/lint/custom; diagnostics needs none
}

export type StepOperation =
  | WorkspaceOperation
  | ManualOperation
  | TerminalOperation
  | ValidationOperation;

// ---------------------------------------------------------------------------
// Completion conditions (execution-v2.md §8)
// ---------------------------------------------------------------------------

export type CompletionCondition =
  | { type: 'automatic' }
  | { type: 'user_confirmation' }
  | { type: 'command_exit_code'; expected: number }
  | { type: 'tests_passed' }
  | { type: 'file_modified'; path: string };

// ---------------------------------------------------------------------------
// Steps & workflow
// ---------------------------------------------------------------------------

export interface WorkflowStep {
  id: string;
  title: string;
  executor: ExecutorKind;
  dependsOn?: string[];
  completionCondition?: CompletionCondition;
  script: StepOperation[];
  // Orchestrator re-plan attempts for THIS step before going interactive (§10).
  repairBudget?: number;
}

export interface Workflow {
  version: string;
  objective: string;
  summary: string;
  steps: WorkflowStep[];
}

// ---------------------------------------------------------------------------
// Execution results
// ---------------------------------------------------------------------------

export type StepStatus = 'succeeded' | 'failed' | 'skipped' | 'paused';

export interface ValidationFailure {
  kind: string; // e.g. 'build' | 'tests' | 'ambiguous_symbol' | 'apply_failed'
  message: string;
  details?: string;
  exitCode?: number;
}

export interface ExecutionResult {
  stepId: string;
  status: StepStatus;
  message?: string;
  editedFiles?: string[]; // absolute paths touched, for progress + Keep/Undo accounting
  failure?: ValidationFailure; // present when status === 'failed'
}

export const DEFAULT_REPAIR_BUDGET = 2;
