import * as vscode from 'vscode';
import { ExecutionResult, Workflow, WorkflowStep } from './execution/ir';
import { orderSteps } from './execution/workflowScheduler';
import { WorkspaceCheckpoint } from './execution/checkpoint';
import { WorkspaceExecutor } from './executors/workspaceExecutor';
import { DeferredExecutor } from './executors/deferredExecutor';
import { WorkflowExecutionContext } from './execution/context';
import { NoopStateStore } from './execution/workflowStateStore';
import { stepFileChanges, proposedFileContent, opLabel } from './workspace/preview';

// The native-first execution UI (execution-v2.md). A compiled Workflow IR is run
// here step-by-step: the Foundry Execution TreeView shows the steps with live
// status; the active step offers Approve / Skip / Open-diff; review uses VS Code's
// NATIVE diff editor (current file vs. proposed content). Chat stays for planning
// and steering. Reuses the whole engine — WorkspaceExecutor, WorkspaceCheckpoint.

export const EXECUTION_VIEW_ID = 'foundry.executionView';
const PROPOSED_SCHEME = 'foundry-proposed';

type StepStatus = 'pending' | 'active' | 'running' | 'applied' | 'skipped' | 'failed';

// Tree node: a step, or one of a step's operations.
type Node = { kind: 'step'; index: number } | { kind: 'op'; stepIndex: number; opIndex: number };

// Serves the "proposed" side of a diff. The controller fills the cache before
// asking VS Code to open the diff; the provider just reads it back.
class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  private readonly cache = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.cache.set(uri.toString(), content);
    this.emitter.fire(uri);
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.cache.get(uri.toString()) ?? '';
  }
}

class ExecutionTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly controller: ExecutionController) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    // Return the SAME step-node instances each time so TreeView.reveal can find them.
    if (!node) return this.controller.stepNodes;
    if (node.kind === 'step') {
      const step = this.controller.steps[node.index];
      return step.script.map((_, opIndex) => ({ kind: 'op', stepIndex: node.index, opIndex }));
    }
    return [];
  }

  getParent(node: Node): Node | undefined {
    return node.kind === 'op' ? this.controller.stepNodes[node.stepIndex] : undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'op') {
      const op = this.controller.steps[node.stepIndex].script[node.opIndex];
      const item = new vscode.TreeItem(opLabel(op), vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('circle-small-filled');
      item.command = { command: 'foundry.exec.openDiff', title: 'Open diff', arguments: [node] };
      return item;
    }
    const step = this.controller.steps[node.index];
    const status = this.controller.statusOf(node.index);
    const item = new vscode.TreeItem(
      `${node.index + 1}. ${step.title}`,
      status === 'active'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.description = step.executor;
    item.iconPath = iconFor(status);
    item.contextValue = `foundry.step.${status}`;
    item.command = { command: 'foundry.exec.openDiff', title: 'Open diff', arguments: [node] };
    return item;
  }
}

function iconFor(status: StepStatus): vscode.ThemeIcon {
  switch (status) {
    case 'applied':
      return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
    case 'active':
      return new vscode.ThemeIcon('chevron-right', new vscode.ThemeColor('charts.blue'));
    case 'running':
      return new vscode.ThemeIcon('loading~spin');
    case 'skipped':
      return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

export class ExecutionController {
  readonly tree: ExecutionTreeProvider;
  private readonly proposed = new ProposedContentProvider();
  private readonly workspaceExecutor = new WorkspaceExecutor();
  private readonly deferredExecutor = new DeferredExecutor();

  steps: WorkflowStep[] = [];
  stepNodes: Node[] = []; // stable node instances for TreeView.reveal
  private statuses: StepStatus[] = [];
  private workflow?: Workflow;
  private workspaceRoot = '';
  private index = -1; // active step, or -1 when idle/finished
  private checkpoint = new WorkspaceCheckpoint();
  private results: ExecutionResult[] = [];
  private cancelSource?: vscode.CancellationTokenSource;
  private runId = '';
  private busy = false;
  private treeView?: vscode.TreeView<Node>;

  constructor(private readonly output: vscode.OutputChannel) {
    this.tree = new ExecutionTreeProvider(this);
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this.proposed),
    );
    this.treeView = vscode.window.createTreeView(EXECUTION_VIEW_ID, { treeDataProvider: this.tree });
    context.subscriptions.push(this.treeView);
    const cmd = (id: string, fn: (...args: unknown[]) => unknown) =>
      context.subscriptions.push(vscode.commands.registerCommand(id, fn));
    cmd('foundry.exec.approve', () => this.approveCurrent());
    cmd('foundry.exec.skip', () => this.skipCurrent());
    cmd('foundry.exec.applyAll', () => this.applyAllRemaining());
    cmd('foundry.exec.cancel', () => this.cancel());
    cmd('foundry.exec.keep', () => this.keep());
    cmd('foundry.exec.undo', () => this.undo());
    cmd('foundry.exec.openDiff', (node) => this.openDiff(node as Node | undefined));
    this.updateContext();
  }

  statusOf(i: number): StepStatus {
    return this.statuses[i] ?? 'pending';
  }

  // Begin a run: reset state, activate step 1, reveal + preview it.
  start(workflow: Workflow, workspaceRoot: string): void {
    this.workflow = workflow;
    this.workspaceRoot = workspaceRoot;
    this.steps = orderSteps(workflow);
    this.stepNodes = this.steps.map((_, index) => ({ kind: 'step', index }));
    this.statuses = this.steps.map(() => 'pending');
    this.checkpoint = new WorkspaceCheckpoint();
    this.results = [];
    this.runId = `run-${Date.now()}`;
    this.cancelSource = new vscode.CancellationTokenSource();
    this.index = this.steps.length ? 0 : -1;
    if (this.index >= 0) this.statuses[0] = 'active';
    this.updateContext();
    this.tree.refresh();
    if (this.index >= 0) {
      this.reveal(0);
      void this.openDiff({ kind: 'step', index: 0 });
    }
  }

  async approveCurrent(): Promise<void> {
    if (this.index < 0 || this.busy) return;
    const i = this.index;
    this.busy = true;
    this.statuses[i] = 'running';
    this.tree.refresh();
    const result = await this.applyStep(this.steps[i]);
    this.results.push(result);
    this.busy = false;
    if (result.status === 'failed') {
      this.statuses[i] = 'failed';
      this.stopOnFailure(this.steps[i], result);
      return;
    }
    this.statuses[i] = result.status === 'skipped' ? 'skipped' : 'applied';
    this.advance(true);
  }

  skipCurrent(): void {
    if (this.index < 0 || this.busy) return;
    this.statuses[this.index] = 'skipped';
    this.advance(true);
  }

  async applyAllRemaining(): Promise<void> {
    if (this.busy || this.index < 0) return;
    this.busy = true;
    try {
      while (this.index >= 0 && !this.cancelSource?.token.isCancellationRequested) {
        const i = this.index;
        this.statuses[i] = 'running';
        this.tree.refresh();
        const result = await this.applyStep(this.steps[i]);
        this.results.push(result);
        if (result.status === 'failed') {
          this.statuses[i] = 'failed';
          this.busy = false;
          this.stopOnFailure(this.steps[i], result);
          return;
        }
        this.statuses[i] = result.status === 'skipped' ? 'skipped' : 'applied';
        this.pickNext(false);
      }
    } finally {
      this.busy = false;
    }
    if (this.index < 0) this.finish('completed');
  }

  cancel(): void {
    this.cancelSource?.cancel();
    this.index = -1;
    this.updateContext();
    this.tree.refresh();
    this.finish('cancelled');
  }

  async keep(): Promise<void> {
    this.checkpoint = new WorkspaceCheckpoint();
    vscode.window.showInformationMessage('Foundry: kept all changes from this run.');
    this.reset();
  }

  async undo(): Promise<void> {
    const { restored, failed } = await this.checkpoint.restore();
    this.checkpoint = new WorkspaceCheckpoint();
    vscode.window.showInformationMessage(
      `Foundry: reverted ${restored} file${restored === 1 ? '' : 's'} to the pre-run state` +
        (failed ? ` (${failed} could not be restored)` : '') + '.',
    );
    this.reset();
  }

  // --- internals -----------------------------------------------------------

  private async applyStep(step: WorkflowStep): Promise<ExecutionResult> {
    const executor = step.executor === 'workspace' ? this.workspaceExecutor : this.deferredExecutor;
    const ctx: WorkflowExecutionContext = {
      workflow: this.workflow!,
      workspaceRoot: this.workspaceRoot,
      token: this.cancelSource!.token,
      progress: { info: (m) => this.output.appendLine(`  ${m}`) },
      stateStore: new NoopStateStore(),
      replan: async () => [],
      snapshotFiles: (files) => this.checkpoint.capture(files),
    };
    this.output.appendLine(`[exec] ${step.title}`);
    try {
      return await executor.execute(step, ctx);
    } catch (err) {
      return {
        stepId: step.id,
        status: 'failed',
        failure: { kind: 'executor_error', message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // Move to the next pending step (advance=true opens its diff for review).
  private advance(openDiff: boolean): void {
    this.pickNext(openDiff);
    if (this.index < 0) this.finish('completed');
  }

  private pickNext(openDiff: boolean): void {
    const next = this.statuses.findIndex((s) => s === 'pending');
    this.index = next;
    if (next >= 0) {
      this.statuses[next] = 'active';
      this.updateContext();
      this.tree.refresh();
      this.reveal(next);
      if (openDiff) void this.openDiff({ kind: 'step', index: next });
    } else {
      this.updateContext();
      this.tree.refresh();
    }
  }

  private stopOnFailure(step: WorkflowStep, result: ExecutionResult): void {
    this.index = -1;
    this.updateContext();
    this.tree.refresh();
    this.output.appendLine(`[exec] FAILED ${step.title}: ${result.failure?.message ?? ''}`);
    vscode.window
      .showErrorMessage(
        `Foundry: "${step.title}" failed — ${result.failure?.message ?? 'error'}. ` +
          'Adjust in @codebase chat and re-run, or Undo from the view.',
        'Show log',
      )
      .then((pick) => {
        if (pick === 'Show log') this.output.show();
      });
  }

  private finish(outcome: 'completed' | 'cancelled'): void {
    this.updateContext();
    const n = this.checkpoint.size;
    const verb = outcome === 'completed' ? 'complete' : 'stopped';
    vscode.window.showInformationMessage(
      `Foundry: workflow ${verb} — ${n} file${n === 1 ? '' : 's'} changed. ` +
        'Keep or Undo from the Foundry Execution view.',
    );
  }

  private reset(): void {
    this.steps = [];
    this.stepNodes = [];
    this.statuses = [];
    this.workflow = undefined;
    this.index = -1;
    this.results = [];
    this.updateContext();
    this.tree.refresh();
  }

  private reveal(index: number): void {
    const node = this.stepNodes[index];
    if (node) this.treeView?.reveal(node, { select: false, focus: false }).then(undefined, () => undefined);
  }

  // Context keys drive the view's title/inline buttons (see package.json menus).
  private updateContext(): void {
    const running = this.index >= 0 && this.steps.length > 0;
    const canReview = this.index < 0 && this.checkpoint.size > 0;
    void vscode.commands.executeCommand('setContext', 'foundry.exec.running', running);
    void vscode.commands.executeCommand('setContext', 'foundry.exec.canReview', canReview);
  }

  private async openDiff(node?: Node): Promise<void> {
    if (!node) return;
    const stepIndex = node.kind === 'step' ? node.index : node.stepIndex;
    const step = this.steps[stepIndex];
    if (!step) return;
    const changes = stepFileChanges(step, this.workspaceRoot);
    if (changes.length === 0) {
      vscode.window.showInformationMessage(`"${step.title}" has no file changes to preview.`);
      return;
    }
    for (const ch of changes) {
      if (ch.kind === 'structural') {
        vscode.window.showInformationMessage(`${ch.relPath}: ${ch.note ?? 'structural change'}`);
        continue;
      }
      let proposed: string | null;
      try {
        proposed = await proposedFileContent(ch.absPath, step, this.workspaceRoot);
      } catch (err) {
        vscode.window.showWarningMessage(
          `Couldn't preview ${ch.relPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      if (proposed === null) continue;

      const right = vscode.Uri.parse(
        `${PROPOSED_SCHEME}:/${this.runId}/${stepIndex}/${encodeURIComponent(ch.relPath)}`,
      );
      this.proposed.set(right, proposed);
      let left: vscode.Uri;
      if (ch.kind === 'create') {
        left = vscode.Uri.parse(
          `${PROPOSED_SCHEME}:/${this.runId}/${stepIndex}/empty/${encodeURIComponent(ch.relPath)}`,
        );
        this.proposed.set(left, '');
      } else {
        left = vscode.Uri.file(ch.absPath);
      }
      await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `Foundry · ${step.title} · ${ch.relPath}`,
        { preview: true },
      );
    }
  }
}
