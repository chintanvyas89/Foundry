import { ExecutionResult, WorkflowStep } from '../execution/ir';
import { WorkflowExecutionContext, WorkflowExecutor } from '../execution/context';

// P1 executes `workspace` steps only. Terminal, validation, and user steps get
// their own executors in P2/P3; until then this reports what each such step WOULD
// do and marks it skipped, so a workflow that mixes edits with "run tests" still
// applies its edits instead of hard-failing on the first non-workspace step.
export class DeferredExecutor implements WorkflowExecutor {
  readonly kind = 'terminal' as const;

  supports(step: WorkflowStep): boolean {
    return step.executor !== 'workspace';
  }

  async execute(step: WorkflowStep, ctx: WorkflowExecutionContext): Promise<ExecutionResult> {
    for (const op of step.script) {
      switch (op.operation) {
        case 'run':
          ctx.progress.info(`↷ (run it yourself for now) \`${op.command}\``);
          break;
        case 'validate':
          ctx.progress.info(`↷ (validation lands in P2) ${op.kind}${op.command ? ` \`${op.command}\`` : ''}`);
          break;
        case 'manual':
          ctx.progress.info(`↷ (manual) ${op.instructions.join('; ')}`);
          break;
        default:
          break;
      }
    }
    return { stepId: step.id, status: 'skipped', message: 'deferred to a later phase' };
  }
}
