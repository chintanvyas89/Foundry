import * as vscode from 'vscode';
import { compilePlan } from './planner/workflowCompiler';
import { ExecutionEngine, EngineRunResult } from './execution/executionEngine';
import { ProgressReporter } from './execution/context';
import { WorkspaceCheckpoint } from './execution/checkpoint';
import { WorkspaceExecutor } from './executors/workspaceExecutor';
import { DeferredExecutor } from './executors/deferredExecutor';
import { Workflow } from './execution/ir';

// The in-house execution path (execution-v2.md). `@codebase /implement` compiles the
// most recent plan into Workflow IR and runs it through the ExecutionEngine, all in
// ONE chat turn: progress streams to the chat, per-step approval uses a modal prompt
// (a turn can await a window dialog while still streaming), and the run ends with
// Keep / Undo-all controls backed by the file-level checkpoint.

// Checkpoints from completed runs, so the Keep/Undo buttons (which fire in a later
// turn as plain commands) can find the right one. Not persisted across reloads.
const checkpoints = new Map<string, WorkspaceCheckpoint>();

export function registerImplementCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('foundry.undoChanges', async (runId?: string) => {
      const cp = runId ? checkpoints.get(runId) : undefined;
      if (!cp) {
        vscode.window.showInformationMessage('Foundry: nothing to undo — this run was already resolved.');
        return;
      }
      const { restored, failed } = await cp.restore();
      checkpoints.delete(runId!);
      vscode.window.showInformationMessage(
        `Foundry: reverted ${restored} file${restored === 1 ? '' : 's'} to the pre-run state` +
          (failed ? ` (${failed} could not be restored)` : '') + '.',
      );
    }),
    vscode.commands.registerCommand('foundry.keepChanges', async (runId?: string) => {
      if (runId) checkpoints.delete(runId);
      vscode.window.showInformationMessage('Foundry: kept all changes from this run.');
    }),
  );
}

export async function runImplement(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
): Promise<vscode.ChatResult> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    stream.markdown('Open a folder in VS Code first — there is nothing to implement against.');
    return {};
  }

  const { planText, originalRequest } = resolvePlan(request, chatContext);
  if (!planText) {
    stream.markdown(
      'I need a plan to implement. Run `@codebase /plan <the change>` first, then `@codebase /implement`. ' +
        '(Or paste the plan after `/implement`.)',
    );
    return {};
  }

  stream.progress('Compiling the plan into an executable workflow…');
  const compiled = await compilePlan(request.model, planText, originalRequest, token);
  if (!compiled.workflow) {
    output.appendLine(`[implement] compile failed: ${compiled.error}\n${compiled.raw ?? ''}`);
    stream.markdown(`\n\n_Couldn't compile the plan into a workflow: ${compiled.error}_`);
    offerAgentModeEscape(stream, originalRequest, planText);
    return {};
  }
  const workflow = compiled.workflow;

  renderWorkflowHeader(stream, workflow);

  const progress: ProgressReporter = { info: (m) => stream.markdown(`\n${m}  `) };
  const engine = new ExecutionEngine();
  let result: EngineRunResult;
  try {
    result = await engine.run({
      workflow,
      workspaceRoot,
      executors: [new WorkspaceExecutor(), new DeferredExecutor()],
      token,
      hooks: {
        progress,
        approveStep: (step, summary) => approveStep(stream, step.title, summary),
        replan: async () => [], // bounded repair loop is P2
      },
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    output.appendLine(`[implement] engine error: ${m}`);
    stream.markdown(`\n\n_Execution failed unexpectedly: ${m}_`);
    return { errorDetails: { message: m } };
  }

  renderOutcome(stream, workflow, result, originalRequest, planText);
  return {};
}

// Modal approval for one step. Streaming continues around it; the turn simply
// awaits the user's choice. Dismissing (or Cancel) stops the whole workflow.
async function approveStep(
  stream: vscode.ChatResponseStream,
  title: string,
  summary: string,
): Promise<'apply' | 'skip' | 'auto' | 'cancel'> {
  stream.markdown(`\n\n**Next: ${title}**\n\n${summary}\n`);
  const choice = await vscode.window.showInformationMessage(
    `Apply step: ${title}?`,
    { modal: true, detail: summary },
    'Apply',
    'Skip',
    'Apply all remaining',
  );
  if (choice === 'Apply') return 'apply';
  if (choice === 'Skip') return 'skip';
  if (choice === 'Apply all remaining') return 'auto';
  return 'cancel';
}

function renderWorkflowHeader(stream: vscode.ChatResponseStream, workflow: Workflow): void {
  stream.markdown(`### Executing: ${workflow.objective || 'plan'}\n\n`);
  if (workflow.summary) stream.markdown(`${workflow.summary}\n\n`);
  workflow.steps.forEach((s, i) => {
    stream.markdown(`${i + 1}. **${s.title}** _(${s.executor})_\n`);
  });
  stream.markdown('\n');
}

function renderOutcome(
  stream: vscode.ChatResponseStream,
  workflow: Workflow,
  result: EngineRunResult,
  originalRequest: string,
  planText: string,
): void {
  const edited = result.editedFiles;
  stream.markdown('\n\n---\n');

  if (result.outcome === 'completed') {
    stream.markdown(`✅ **Workflow complete.** ${edited.length} file(s) changed.\n`);
  } else if (result.outcome === 'cancelled') {
    stream.markdown(`⏹ **Stopped.** ${edited.length} file(s) changed before you stopped.\n`);
  } else {
    const step = result.failedStep?.title ?? 'a step';
    stream.markdown(
      `❌ **Stopped at "${step}".** ${result.failure?.message ?? ''}\n\n` +
        '_The bounded repair loop lands in P2; for now, tell me how to adjust and re-run ' +
        '`/implement`, or use the agent-mode escape below._\n',
    );
  }

  for (const f of edited) stream.reference(vscode.Uri.file(f));

  // Keep vs Undo — restore/keep exactly the files this run touched.
  if (result.checkpoint.size > 0) {
    const runId = `run-${Date.now()}`;
    checkpoints.set(runId, result.checkpoint);
    stream.markdown('\n**Tested it? Keep the changes or revert the whole run:**\n');
    stream.button({ command: 'foundry.keepChanges', title: '✓ Keep changes', arguments: [runId] });
    stream.button({ command: 'foundry.undoChanges', title: '↩ Undo all changes', arguments: [runId] });
  }

  if (result.outcome !== 'completed') {
    offerAgentModeEscape(stream, originalRequest, planText);
  }
}

// The manual escape hatch (kept per the spec): push the plan to VS Code's built-in
// agent mode, which has the full native toolset, if in-house execution stalls.
function offerAgentModeEscape(
  stream: vscode.ChatResponseStream,
  request: string,
  content: string,
): void {
  if (!content || content.trim().length < 40) return;
  stream.button({
    command: 'foundry.implementPlan',
    title: '⚡ Continue in agent mode',
    arguments: [{ request, content }],
  });
}

// The plan to implement: an inline plan pasted after `/implement`, else the most
// recent substantive @codebase response in this chat (the last /plan output). The
// original request is the user prompt that produced that response.
function resolvePlan(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
): { planText: string; originalRequest: string } {
  const inline = request.prompt.trim();
  if (inline.length >= 40) return { planText: inline, originalRequest: '' };

  const hist = chatContext.history;
  for (let i = hist.length - 1; i >= 0; i--) {
    const turn = hist[i];
    if (turn instanceof vscode.ChatResponseTurn) {
      const text = responseText(turn);
      if (text.trim().length >= 40) {
        let originalRequest = '';
        for (let j = i - 1; j >= 0; j--) {
          const prev = hist[j];
          if (prev instanceof vscode.ChatRequestTurn) {
            originalRequest = prev.prompt;
            break;
          }
        }
        return { planText: text, originalRequest };
      }
    }
  }
  return { planText: '', originalRequest: '' };
}

function responseText(turn: vscode.ChatResponseTurn): string {
  let text = '';
  for (const part of turn.response) {
    if (part instanceof vscode.ChatResponseMarkdownPart) text += part.value.value;
  }
  return text;
}
