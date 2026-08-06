import * as vscode from 'vscode';
import { ExecutionResult, ExecutorKind, ValidationFailure, Workflow, WorkflowStep } from './ir';
import { WorkflowStateStore } from './workflowStateStore';

// Streamed progress sink. The orchestrator implements this over a
// vscode.ChatResponseStream; executors call `info` to report per-operation notes.
export interface ProgressReporter {
  info(message: string): void;
}

// What an executor receives. Reasoning/orchestration concerns (approval, repair)
// live on the engine, not here — executors stay deterministic. `stateStore` and
// `replan` are present per the spec's interface but unused by v1 executors.
export interface WorkflowExecutionContext {
  workflow: Workflow;
  workspaceRoot: string;
  token: vscode.CancellationToken;
  progress: ProgressReporter;
  stateStore: WorkflowStateStore;
  replan(step: WorkflowStep, failure: ValidationFailure): Promise<WorkflowStep[]>;
  // Declare the files an edit is about to touch, so the engine can capture their
  // original content for the workflow-level Undo. Call immediately before applying.
  snapshotFiles(files: string[]): Promise<void>;
}

// One executor per ExecutorKind. `supports` lets the engine pick the right one;
// `execute` interprets the step's operations and returns a result. No reasoning.
export interface WorkflowExecutor {
  readonly kind: ExecutorKind;
  supports(step: WorkflowStep): boolean;
  execute(step: WorkflowStep, ctx: WorkflowExecutionContext): Promise<ExecutionResult>;
}
