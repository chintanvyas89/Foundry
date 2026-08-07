import * as vscode from 'vscode';
import { ExecutionService } from './executor/executionService';
import { runPlanAgent, seedMessages } from './executor/planAgent';
import { openChangeDiff } from './executor/editTools';

// `@codebase /implement` — the chat-only execution driver. It runs the approved plan
// as ONE continuous LLM loop (planAgent) against the headless ExecutionService, and
// pauses at the checkpoints the model declares. Because the plan was already reviewed
// and approved, each pause is a lightweight Continue (plus an Auto-continue escape).
// ALL UI is here in the chat: streamed progress, Open Diff, and Continue / Undo /
// Retry / Skip / Keep buttons. Buttons re-enter this handler via a module-level
// RunState (a chat turn can't pause, so decisions are cross-turn).

type PendingAction = 'continue' | 'autoContinue' | 'undoCheckpoint' | 'retry' | 'skip';

interface RunState {
  runId: string;
  messages: vscode.LanguageModelChatMessage[];
  service: ExecutionService;
  workspaceRoot: string;
  originalRequest: string;
  planText: string;
  autoContinue: boolean;
  pendingAction?: PendingAction;
}

let run: RunState | undefined;

export function registerImplementCommands(context: vscode.ExtensionContext): void {
  const reenter = (action: PendingAction) => {
    if (!run) return;
    run.pendingAction = action;
    void vscode.commands.executeCommand('workbench.action.chat.open', { query: '@codebase /implement' });
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('foundry.impl.continue', () => reenter('continue')),
    vscode.commands.registerCommand('foundry.impl.autoContinue', () => reenter('autoContinue')),
    vscode.commands.registerCommand('foundry.impl.undoCheckpoint', () => reenter('undoCheckpoint')),
    vscode.commands.registerCommand('foundry.impl.retry', () => reenter('retry')),
    vscode.commands.registerCommand('foundry.impl.skip', () => reenter('skip')),
    vscode.commands.registerCommand('foundry.impl.keep', () => {
      run?.service.keep();
      run = undefined;
      vscode.window.showInformationMessage('Foundry: kept all changes from this run.');
    }),
    vscode.commands.registerCommand('foundry.impl.undoAll', async () => {
      if (run) {
        const { restored, failed } = await run.service.undoAll();
        vscode.window.showInformationMessage(
          `Foundry: reverted ${restored} file${restored === 1 ? '' : 's'}` + (failed ? ` (${failed} failed)` : '') + '.',
        );
      }
      run = undefined;
    }),
    vscode.commands.registerCommand('foundry.impl.openDiff', async (absPath?: string) => {
      if (run && absPath) await openChangeDiff(run.service, absPath);
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

  // Resume from a button action (cross-turn).
  if (run && run.pendingAction) {
    const st = run;
    const action: PendingAction = run.pendingAction;
    st.pendingAction = undefined;
    await resume(st, action, request, stream, token, output);
    return {};
  }

  // Fresh start.
  const { planText, originalRequest } = resolvePlan(request, chatContext);
  if (!planText) {
    stream.markdown(
      'I need a plan to implement. Run `@codebase /plan <the change>` first, then `@codebase /implement`.',
    );
    return {};
  }
  run = {
    runId: `run-${Date.now()}`,
    messages: seedMessages(planText, originalRequest),
    service: new ExecutionService(workspaceRoot),
    workspaceRoot,
    originalRequest,
    planText,
    autoContinue: false,
  };
  stream.markdown('### Implementing the plan\n\nI’ll work through it and pause at checkpoints for your review.\n');
  pushUser(run, 'Begin implementing the plan now. Work through it in order, and pause at the first natural checkpoint.');
  await runSegment(request, stream, token, output);
  return {};
}

async function resume(
  st: RunState,
  action: PendingAction,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
): Promise<void> {
  switch (action) {
    case 'autoContinue':
      st.autoContinue = true;
    // falls through — auto-continue is "continue, and don't stop at the next checkpoints"
    case 'continue':
      st.service.commitSegment();
      pushUser(st, 'Continue with the next part of the plan.');
      break;
    case 'undoCheckpoint':
      await st.service.revertSegment();
      stream.markdown('\n\n↩ Reverted the last checkpoint’s changes.\n');
      renderDecisionButtons(stream);
      return; // wait for the user's next choice
    case 'retry':
      // Keep any partial edits (blocked) or start clean (post-undo); beginSegment in
      // runSegment is idempotent, so either way this folds into one segment.
      pushUser(st, 'Reconsider and implement that part of the plan again, differently this time.');
      break;
    case 'skip':
      st.service.commitSegment(); // keep whatever was applied so far; move past the blocker
      pushUser(st, 'Skip that part and continue with the rest of the plan.');
      break;
  }
  await runSegment(request, stream, token, output);
}

// Run one segment of the brain loop and render its outcome (checkpoint / done / blocked).
async function runSegment(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
): Promise<void> {
  const st = run;
  if (!st) return;
  st.service.beginSegment(); // idempotent — ensures a segment layer is open

  const result = await runPlanAgent({
    request,
    stream,
    token,
    service: st.service,
    workspaceRoot: st.workspaceRoot,
    messages: st.messages,
  });

  if (token.isCancellationRequested) {
    st.service.commitSegment();
    stream.markdown('\n\n⏹ **Cancelled.**\n');
    renderKeepUndo(stream);
    return;
  }

  renderChangedFiles(stream, result.changedFiles);

  if (result.status === 'blocked') {
    output.appendLine(`[implement] blocked: ${result.reason}`);
    stream.markdown(`\n\n⛔ **Blocked:** ${result.reason ?? 'the agent could not proceed.'}\n`);
    stream.markdown('_Partial changes are left in place so you can inspect them._\n');
    renderDecisionButtons(stream);
    return;
  }

  if (result.status === 'done') {
    st.service.commitSegment();
    finishRun(stream);
    return;
  }

  // checkpoint — auto-continue straight through, or pause for the user.
  if (result.summary) stream.markdown(`\n\n⏸ **Checkpoint:** ${result.summary}\n`);
  if (st.autoContinue) {
    st.service.commitSegment();
    pushUser(st, 'Continue with the next part of the plan.');
    await runSegment(request, stream, token, output);
    return;
  }
  renderCheckpointButtons(stream);
}

function finishRun(stream: vscode.ChatResponseStream): void {
  stream.markdown('\n\n---\n🎉 **Plan implemented.**\n');
  renderKeepUndo(stream);
}

// Offer Keep / Undo-all if the run touched anything; otherwise clear the run.
function renderKeepUndo(stream: vscode.ChatResponseStream): void {
  const st = run;
  if (!st) return;
  const changed = st.service.changeCount;
  if (changed === 0) {
    run = undefined;
    return;
  }
  stream.markdown(
    `\n**${changed} file${changed === 1 ? '' : 's'} changed. Tested it? Keep the run or revert everything:**\n`,
  );
  stream.button({ command: 'foundry.impl.keep', title: '✓ Keep changes' });
  stream.button({ command: 'foundry.impl.undoAll', title: '↩ Undo all changes' });
}

function renderChangedFiles(stream: vscode.ChatResponseStream, files: string[]): void {
  if (files.length === 0) return;
  stream.markdown(`\n\n**${files.length} file${files.length === 1 ? '' : 's'} changed:**\n`);
  for (const f of files) {
    stream.anchor(vscode.Uri.file(f));
    stream.button({ command: 'foundry.impl.openDiff', title: 'Open Diff', arguments: [f] });
  }
}

function renderCheckpointButtons(stream: vscode.ChatResponseStream): void {
  stream.markdown('\n**Review the diff, then:**\n');
  stream.button({ command: 'foundry.impl.continue', title: '✓ Continue' });
  stream.button({ command: 'foundry.impl.undoCheckpoint', title: '↩ Undo this checkpoint' });
  stream.button({ command: 'foundry.impl.autoContinue', title: '⏩ Auto-continue to end' });
  const st = run;
  if (st) offerAgentModeEscape(stream, st.originalRequest, st.planText);
}

function renderDecisionButtons(stream: vscode.ChatResponseStream): void {
  const st = run;
  stream.markdown('\n**How do you want to proceed?**\n');
  stream.button({ command: 'foundry.impl.retry', title: '↻ Retry' });
  stream.button({ command: 'foundry.impl.skip', title: '⤼ Skip & continue' });
  if (st) offerAgentModeEscape(stream, st.originalRequest, st.planText);
  stream.button({ command: 'foundry.impl.undoAll', title: '↩ Undo all changes' });
}

function pushUser(st: RunState, text: string): void {
  st.messages.push(vscode.LanguageModelChatMessage.User(text));
}

function offerAgentModeEscape(stream: vscode.ChatResponseStream, request: string, content: string): void {
  if (!content || content.trim().length < 40) return;
  stream.button({ command: 'foundry.implementPlan', title: '⚡ Continue in agent mode', arguments: [{ request, content }] });
}

// The plan to implement: an inline plan pasted after `/implement`, else the most
// recent substantive @codebase response in this chat (the last /plan output).
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
