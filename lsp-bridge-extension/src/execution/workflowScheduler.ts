import { Workflow, WorkflowStep } from './ir';

// Orders steps for linear execution, honoring `dependsOn` (execution-v2.md §12).
// v1 runs the returned list front-to-back; the same dependency graph is what a
// future phase would use to run independent steps in parallel. Deterministic:
// ties (same dependency depth) keep the workflow's original order.

export class WorkflowCycleError extends Error {
  constructor(public readonly remaining: string[]) {
    super(`Workflow has a dependency cycle among: ${remaining.join(', ')}`);
    this.name = 'WorkflowCycleError';
  }
}

export function orderSteps(workflow: Workflow): WorkflowStep[] {
  const steps = workflow.steps;
  const index = new Map<string, number>();
  steps.forEach((s, i) => index.set(s.id, i));

  // Count only dependencies that actually exist in this workflow; a dangling
  // dependsOn id can't block anything.
  const indegree = new Map<string, number>();
  for (const s of steps) {
    const deps = (s.dependsOn ?? []).filter((d) => index.has(d));
    indegree.set(s.id, deps.length);
  }

  const ready = () =>
    steps
      .filter((s) => indegree.get(s.id) === 0)
      .sort((a, b) => index.get(a.id)! - index.get(b.id)!);

  const ordered: WorkflowStep[] = [];
  const done = new Set<string>();

  while (ordered.length < steps.length) {
    const next = ready().find((s) => !done.has(s.id));
    if (!next) {
      const remaining = steps.filter((s) => !done.has(s.id)).map((s) => s.id);
      throw new WorkflowCycleError(remaining);
    }
    ordered.push(next);
    done.add(next.id);
    indegree.set(next.id, -1); // remove from future `ready()` results
    for (const s of steps) {
      if (done.has(s.id)) continue;
      if ((s.dependsOn ?? []).includes(next.id)) {
        indegree.set(s.id, (indegree.get(s.id) ?? 1) - 1);
      }
    }
  }

  return ordered;
}
