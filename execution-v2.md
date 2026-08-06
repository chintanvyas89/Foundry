# Workflow IR & Execution Engine — V2 (implementation spec)

**Status:** guiding doc for implementation. Supersedes the strict-rule sections of
`execution.md` ("planning happens exactly once", "execution performs zero reasoning"). The
architecture and IR shape from v1 are kept; the rigid rules are loosened where reliability
requires it.

## 1. Goal & why the rules changed

Execute AI-generated implementation plans **inside the extension** using stable VS Code APIs
(`vscode.workspace.applyEdit`, Tasks/shell-integration), instead of handing off to VS Code's
non-extensible chat execution pipeline. This keeps the whole workflow on-device, deterministic,
and (later) resumable.

The v1 spec's two strictest rules were counter-productive:
- *"Planning happens exactly once."* A single bad edit or mis-resolved symbol then has no
  recovery. **Loosened:** reasoning still lives in exactly one *component* (the planner), but the
  orchestrator may re-invoke it a bounded number of times to repair a failed step.
- *"Execution performs zero reasoning."* **Kept for executors** — they only interpret the IR.
  Reasoning during a run happens by calling the planner again, never inside an executor.

## 2. Architecture

```
User → VS Code Chat (@codebase)
     → Chat Participant (Orchestrator)
           ├─ Semantic Search ┐
           └─ Deterministic Search ┘→ Planning LLM loop (reasoning)
                                     → Human-readable plan  (user reviews)
                                     → Workflow Compiler     → Workflow IR
                                     → Execution Engine
                                          ├ WorkspaceExecutor   (applyEdit)
                                          ├ UserExecutor        (manual, pause/resume)
                                          ├ TerminalExecutor    (Tasks / shell integration)
                                          └ ValidationExecutor  (build/tests/lint/diagnostics)
                                     → Progress Tracker → stream to chat
                                     ↺ on validation failure: orchestrator re-plans the step (≤N)
```

## 3. The reasoning boundary (the one rule that matters)

- **Planner** — the ONLY component that reasons: semantic/graph search, dependency analysis,
  multi-step planning, producing the plan and (via the compiler) the IR.
- **Orchestrator (Chat Participant)** — no architectural reasoning; it *sequences* things:
  invoke planner → show plan → compile → run engine → stream progress → on a red validation,
  call the planner again for a **patch** (≤ N=2), then stop and go interactive.
- **Executors** — zero reasoning. Interpret IR operations only.

So: reasoning is confined to one component, but a bounded repair loop exists. Executors never
reason.

## 4. Pipeline: plan → compile → IR → execute

1. **Plan (reasoning).** Planner produces a human-readable plan (what `@codebase /plan` shows
   today) so the user can review it. This preserves the reviewable artifact.
2. **Compile.** `workflowCompiler` turns the plan into Workflow IR: classify each step
   (executor), extract edit scripts, dependencies, completion conditions. Deterministic where it
   can be; a single cheap LM pass where structure/exact code must be generated. Emits **valid,
   schema-checked** IR (reject + one repair pass if invalid) — no separate "formatter" persona,
   just a validated compile.
3. **Execute.** Engine runs the IR (see §6–§9).

## 5. Workflow IR

```jsonc
// workflow
{ "version": "2.0", "objective": "", "summary": "", "steps": [ /* WorkflowStep */ ] }

// step
{
  "id": "step-1",
  "title": "",
  "executor": "workspace | user | terminal | validation",
  "dependsOn": ["step-0"],
  "completionCondition": { /* see §8 */ },
  "script": [ /* operations */ ],
  "repairBudget": 2          // orchestrator re-plan attempts for THIS step; default 2
}
```
No natural-language implementation inside a step — the script is executable.

## 6. Workspace operations (full set in v1)

`replace_function`, `replace_method`, `replace_block`, `replace_lines`, `insert_before`,
`insert_after`, `replace_text`, `append`, `prepend`, `create_file`, `delete_file`,
`rename_symbol`, `add_import`, `remove_import`, `move_file`.

Correctness rules baked into the executor:
- **Prefer anchored ops** (`{file, symbol}`) over `replace_lines`; line numbers rot the instant
  an earlier op edits the same file.
- **Re-resolve symbol→range against the freshly-read document per operation** (never precompute
  all ranges for a file up front).
- **Symbol disambiguation:** `{file, symbol}` may be ambiguous (overloads, nested members with
  the same name) → support an optional `container`/`index`/`signature` disambiguator; fail loud
  if still ambiguous (→ triggers repair).
- `rename_symbol` / `move_file` route through the **rename/refactor providers**
  (`vscode.executeDocumentRenameProvider`) so references update — not hand-rolled.

Edit-script example:
```json
{ "executor": "workspace",
  "script": [
    { "operation": "replace_function",
      "target": { "file": "services/user.go", "symbol": "UserService.CreateUser" },
      "replacement": "<full new function body>" },
    { "operation": "insert_after",
      "target": { "file": "handlers/user.go", "symbol": "CreateUserHandler" },
      "code": "..." }
  ] }
```

## 7. Apply model & safety

- **Per-step approval with an auto-apply toggle.** Default: show the step's proposed change as a
  **diff** and wait for approve. A **"apply the rest automatically"** control lets the user hand
  the wheel to the engine for the remainder of the run (agent-style auto-approve).
- **Git snapshot before a run** (stash/commit-to-scratch or require a clean tree) captures the
  pre-run state; it backs the workflow-level undo below.
- **Workflow-level Keep vs Undo (all changes).** Every file edit from a run is grouped into one
  checkpoint. When the run finishes *or is stopped*, the chat offers **[Keep changes] / [Undo
  all]**. Undo restores the working tree to the pre-run snapshot, discarding every change from the
  run — so the user can apply, manually test, then revert cleanly. (Edits are saved to disk
  incrementally, so Undo must restore from the snapshot, not the editor undo stack.)
- Edits applied via `vscode.workspace.applyEdit` then formatted (`format_document`) + saved.

## 8. Completion conditions

`{"type":"automatic"}`, `{"type":"user_confirmation"}`,
`{"type":"command_exit_code","expected":0}`, `{"type":"tests_passed"}`,
`{"type":"file_modified","path":"..."}`.

API notes: exit codes come from the **Tasks API** (`executeTask` + `onDidEndTaskProcess`) or
**shell integration** (`onDidEndTerminalShellExecution`) — NOT `terminal.sendText` (no exit
code). `file_modified` uses a `FileSystemWatcher`.

## 9. Executors

- **WorkspaceExecutor** — read step → for each op: resolve symbol against current buffer →
  compute range → build `WorkspaceEdit` → (preview/approve) → apply → format → save → next.
  Never reasons.
- **UserExecutor** — `operation: "manual"` with instructions; pauses via a `stream.button`
  ("Continue"), resumes on click; completion = `user_confirmation`.
- **TerminalExecutor** — `operation: "run"` via Tasks/shell integration; captures exit code +
  output for the completion condition.
- **ValidationExecutor** — `build | tests | lint | diagnostics | custom`; a red result triggers
  the orchestrator's repair loop.

## 10. Repair loop (bounded, then interactive)

On a red validation for a step: orchestrator asks the planner for a **patch sub-workflow for
that step only**, up to `repairBudget` (default 2). Executors stay dumb. On exhaustion: **stop**,
show the partial diff + why it gave up, and go **interactive** — the user can chat to steer, and
the orchestrator may ask clarifying questions before retrying. No automatic agent-mode fallback.

## 11. Progress streaming

Chat Participant streams step status (✔ / ⏳ / ▶), pauses render "Continue" buttons, validation
results and the final summary — as in v1's example. The final summary renders the
**[Keep changes] / [Undo all]** controls.

## 12. Resumability (interface now, persistence later)

v1 runs **linearly** with streaming. Define `WorkflowStateStore` + `workflow.json` /
`workflow.state.json` shapes now so a later phase adds persistence, resume, and crash recovery
without reshaping the engine. `dependsOn` + a runnable-steps scheduler are designed in from the
start (they also enable future parallelism).

## 13. Interfaces

```typescript
interface WorkflowExecutor {
  supports(step: WorkflowStep): boolean;
  execute(step: WorkflowStep, ctx: WorkflowExecutionContext): Promise<ExecutionResult>;
}
interface WorkflowExecutionContext {
  workflow: Workflow;
  workspace: WorkspaceContext;
  cancellationToken: vscode.CancellationToken;
  progressReporter: ProgressReporter;
  stateStore: WorkflowStateStore;      // no-op impl in v1
  replan(step: WorkflowStep, failure: ValidationFailure): Promise<WorkflowStep[]>; // orchestrator-owned
}
```

## 14. Module layout & reuse

```
src/
  participant/  codebaseParticipant.ts        (← existing chatParticipant.ts)
  planner/      planner.ts, workflowCompiler.ts
  execution/    executionEngine.ts, workflowScheduler.ts, workflowStateStore.ts
  executors/    workspaceExecutor.ts, terminalExecutor.ts, userExecutor.ts, validationExecutor.ts
  workspace/    symbolResolver.ts, workspaceEditBuilder.ts, formatter.ts
```
Reuse what exists: `symbolProvider.ts` (`getAllSymbolsForFile` → ranges) backs
`symbolResolver.ts`; `references.ts` backs `rename_symbol`; `planContext.ts` feeds the planner;
`languageModelTools.ts` `foundry_*` stay the planner's tools. Introduce incrementally — don't
big-bang the current flat `src/`.

## 15. Guiding principles (revised)

1. Reasoning lives in exactly one **component** (the planner); executors never reason.
2. Workflow IR is the single source of truth for a run.
3. Execution is deterministic; the only in-run reasoning is a **bounded** orchestrator re-plan.
4. Edits are anchored to symbols and re-resolved per operation.
5. Every run is recoverable: a pre-run git snapshot backs a workflow-level **Keep vs Undo all**,
   plus per-step approval or explicit auto-apply.
6. Every step declares its executor and completion condition.
7. New executors add without changing the planner.
8. Ship linear first; resumability slots into a pre-defined interface.

## 16. Phased rollout

- **P1** — IR types + compiler + WorkspaceExecutor (full op set) + per-step approval/diff +
  linear scheduler + progress streaming + **git snapshot & workflow-level Keep/Undo**. Keep
  "Implement in agent mode" as a manual escape.
- **P2** — TerminalExecutor + ValidationExecutor + bounded repair loop.
- **P3** — UserExecutor (pause/resume) + auto-apply toggle polish.
- **P4** — persisted state + resume + crash recovery + diff-approval refinements.
- **Later** — parallel execution, rollback, git/github/mcp executors.

## 17. Non-goals / open

- Not reintroducing the constrained "Foundry" custom agent for execution (retired).
- Agent-mode hand-off kept only as a manual escape; flip to auto-fallback later if desired.
- Line-range native attachments / the old attach-file hand-off: dropped.
