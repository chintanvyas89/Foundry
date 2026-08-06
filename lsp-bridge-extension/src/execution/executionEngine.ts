import * as vscode from 'vscode';
import {
  DEFAULT_REPAIR_BUDGET,
  ExecutionResult,
  ValidationFailure,
  Workflow,
  WorkflowStep,
} from './ir';
import { ProgressReporter, WorkflowExecutionContext, WorkflowExecutor } from './context';
import { NoopStateStore, WorkflowStateStore } from './workflowStateStore';
import { WorkspaceCheckpoint } from './checkpoint';
import { orderSteps } from './workflowScheduler';

// The orchestrator's decision for a step, from the approval gate (§7).
export type ApprovalDecision = 'apply' | 'skip' | 'auto' | 'cancel';

export interface EngineHooks {
  progress: ProgressReporter;
  // Approve a step before it runs. `summary` describes what the step will do.
  // Return 'auto' to apply this and every remaining step without asking again.
  approveStep(step: WorkflowStep, summary: string): Promise<ApprovalDecision>;
  // Repair a failed step: return replacement/patch steps, or [] to stop and hand
  // control back to the user (§10). v1's orchestrator returns [] (repair is P2).
  replan(step: WorkflowStep, failure: ValidationFailure): Promise<WorkflowStep[]>;
}

export interface EngineOptions {
  workflow: Workflow;
  workspaceRoot: string;
  executors: WorkflowExecutor[];
  hooks: EngineHooks;
  token: vscode.CancellationToken;
  stateStore?: WorkflowStateStore;
}

export type RunOutcome = 'completed' | 'failed' | 'cancelled';

export interface EngineRunResult {
  outcome: RunOutcome;
  results: ExecutionResult[];
  checkpoint: WorkspaceCheckpoint; // holds original bytes for Keep/Undo
  editedFiles: string[];
  failedStep?: WorkflowStep;
  failure?: ValidationFailure;
}

// Drives a compiled Workflow to completion: order steps, gate each on approval,
// dispatch to the matching executor, stream progress, and (bounded) repair a
// failed step before stopping. Applies no reasoning of its own — repair is
// delegated back to the planner via `hooks.replan`.
export class ExecutionEngine {
  async run(opts: EngineOptions): Promise<EngineRunResult> {
    const { workflow, workspaceRoot, executors, hooks, token } = opts;
    const stateStore = opts.stateStore ?? new NoopStateStore();
    const checkpoint = new WorkspaceCheckpoint();
    const results: ExecutionResult[] = [];
    const editedFiles = new Set<string>();

    const ctx: WorkflowExecutionContext = {
      workflow,
      workspaceRoot,
      token,
      progress: hooks.progress,
      stateStore,
      replan: hooks.replan,
      snapshotFiles: (files) => checkpoint.capture(files),
    };

    let ordered: WorkflowStep[];
    try {
      ordered = orderSteps(workflow);
    } catch (err) {
      return {
        outcome: 'failed',
        results,
        checkpoint,
        editedFiles: [],
        failure: { kind: 'invalid_workflow', message: err instanceof Error ? err.message : String(err) },
      };
    }

    let autoApply = false;

    for (const step of ordered) {
      if (token.isCancellationRequested) {
        return finish('cancelled');
      }

      hooks.progress.info(`▶ ${step.title}`);

      let decision: ApprovalDecision = 'apply';
      if (!autoApply) {
        decision = await hooks.approveStep(step, summarizeStep(step));
      }
      if (decision === 'cancel') {
        return finish('cancelled');
      }
      if (decision === 'skip') {
        const skipped: ExecutionResult = { stepId: step.id, status: 'skipped' };
        results.push(skipped);
        hooks.progress.info(`⏭ skipped ${step.title}`);
        continue;
      }
      if (decision === 'auto') {
        autoApply = true;
      }

      let result = await this.runStep(step, ctx, executors);
      collect(result);

      if (result.status === 'failed') {
        result = await this.repair(step, result, ctx, executors, collect);
        collect(result);
        if (result.status === 'failed') {
          hooks.progress.info(`✖ ${step.title}: ${result.failure?.message ?? 'failed'}`);
          return {
            outcome: 'failed',
            results,
            checkpoint,
            editedFiles: [...editedFiles],
            failedStep: step,
            failure: result.failure,
          };
        }
      }

      hooks.progress.info(`✔ ${step.title}`);
      await stateStore.save(workflow.objective, {
        workflow,
        currentStep: step.id,
        completed: results.filter((r) => r.status === 'succeeded').map((r) => r.stepId),
      });
    }

    return finish('completed');

    function collect(r: ExecutionResult): void {
      for (const f of r.editedFiles ?? []) editedFiles.add(f);
    }
    function finish(outcome: RunOutcome): EngineRunResult {
      return { outcome, results, checkpoint, editedFiles: [...editedFiles] };
    }
  }

  private async runStep(
    step: WorkflowStep,
    ctx: WorkflowExecutionContext,
    executors: WorkflowExecutor[],
  ): Promise<ExecutionResult> {
    const executor = executors.find((e) => e.supports(step));
    if (!executor) {
      return {
        stepId: step.id,
        status: 'failed',
        failure: { kind: 'no_executor', message: `No executor for "${step.executor}" step "${step.id}".` },
      };
    }
    return executor.execute(step, ctx);
  }

  // Bounded repair (§10): ask the planner for patch steps and run them. If they all
  // succeed, the step is recovered; otherwise return the latest failure so the engine
  // stops and hands control to the user.
  private async repair(
    step: WorkflowStep,
    failure: ExecutionResult,
    ctx: WorkflowExecutionContext,
    executors: WorkflowExecutor[],
    collect: (r: ExecutionResult) => void,
  ): Promise<ExecutionResult> {
    const budget = step.repairBudget ?? DEFAULT_REPAIR_BUDGET;
    let last = failure;
    for (let attempt = 1; attempt <= budget; attempt++) {
      if (ctx.token.isCancellationRequested) return last;
      const patch = await ctx.replan(step, last.failure!);
      if (patch.length === 0) return last; // planner declined — stop, go interactive
      ctx.progress.info(`↻ repair attempt ${attempt}/${budget} for ${step.title}`);
      let recovered = true;
      for (const patchStep of patch) {
        const r = await this.runStep(patchStep, ctx, executors);
        collect(r);
        if (r.status === 'failed') {
          last = r;
          recovered = false;
          break;
        }
      }
      if (recovered) {
        return { stepId: step.id, status: 'succeeded', editedFiles: last.editedFiles };
      }
    }
    return last;
  }
}

// A compact, human-readable description of what a step will do — shown in the
// approval prompt. Deliberately generic (works for any executor).
export function summarizeStep(step: WorkflowStep): string {
  const lines = step.script.map((op) => {
    switch (op.operation) {
      case 'create_file':
      case 'delete_file':
        return `- ${op.operation} \`${op.file}\``;
      case 'move_file':
        return `- move \`${op.from}\` → \`${op.to}\``;
      case 'run':
        return `- run \`${op.command}\``;
      case 'manual':
        return `- manual: ${op.instructions[0] ?? ''}${op.instructions.length > 1 ? ' …' : ''}`;
      case 'validate':
        return `- validate ${op.kind}${op.command ? ` (\`${op.command}\`)` : ''}`;
      default: {
        const anyOp = op as { operation: string; target?: { file?: string; symbol?: string } };
        const where = anyOp.target?.symbol
          ? `${anyOp.target.symbol} in ${anyOp.target.file}`
          : anyOp.target?.file ?? '';
        return `- ${anyOp.operation}${where ? ` \`${where}\`` : ''}`;
      }
    }
  });
  return lines.join('\n');
}
