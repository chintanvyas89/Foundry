import { Workflow } from './ir';

// Persistence seam for resumable workflows (execution-v2.md §12). v1 ships a
// no-op implementation and runs linearly; a later phase swaps in a real store
// (workflow.json / workflow.state.json) for resume + crash recovery WITHOUT
// reshaping the engine — the engine only ever talks to this interface.

export interface WorkflowStateSnapshot {
  workflow: Workflow;
  currentStep?: string;
  completed: string[];
}

export interface WorkflowStateStore {
  load(id: string): Promise<WorkflowStateSnapshot | undefined>;
  save(id: string, state: WorkflowStateSnapshot): Promise<void>;
  clear(id: string): Promise<void>;
}

export class NoopStateStore implements WorkflowStateStore {
  async load(): Promise<WorkflowStateSnapshot | undefined> {
    return undefined;
  }
  async save(): Promise<void> {
    /* no-op in v1 */
  }
  async clear(): Promise<void> {
    /* no-op in v1 */
  }
}
