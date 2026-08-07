import * as vscode from 'vscode';
import { ExecutionService } from './executor/executionService';
import { runAgent, seedMessages, emitUnbuiltIndexHint } from './executor/planAgent';
import { openAllChangesDiff } from './executor/editTools';
import { FOUNDRY_TOOL_PREFIX } from './languageModelTools';

// The @codebase agent driver — runs the unified agent loop (planAgent.ts) for
// every turn and renders the outcome. There is no separate plan/execute
// command: the loop itself decides whether a turn just answers, proposes a
// plan, or makes changes; this module only cares about RENDERING that outcome
// (streamed progress already happened inside the loop) and, when changes were
// made, the end-of-run Review/Keep/Undo decision. No mid-run checkpoints — a
// run that edits does so autonomously to completion or until blocked.
//
// State is a module-level singleton, same limitation as before: VS Code
// exposes no session id to a chat participant, so this can't be properly keyed
// per chat panel. `chatContext.history` still gives per-turn continuity (the
// model sees prior turns' rendered text), which is what makes "give me a plan"
// then "go ahead" work across two turns without a hard re-discovery requirement
// — full tool-call-level memory across turns is a separate, deferred piece.

type PendingAction = 'retry' | 'skip' | 'keep' | 'undoAll';

interface RunState {
  runId: string;
  messages: vscode.LanguageModelChatMessage[];
  service: ExecutionService;
  workspaceRoot: string;
  requestPrompt: string; // for the agent-mode escape handoff
  answerText: string; // last answer/plan text, for the agent-mode escape handoff
  cumulativeTokens: number;
  pendingAction?: PendingAction;
}

let run: RunState | undefined;

export function registerAgentCommands(context: vscode.ExtensionContext): void {
  const reenter = (action: PendingAction) => {
    if (!run) return;
    run.pendingAction = action;
    void vscode.commands.executeCommand('workbench.action.chat.open', { query: '@codebase (resuming)' });
  };
  context.subscriptions.push(
    vscode.commands.registerCommand('foundry.agent.retry', () => reenter('retry')),
    vscode.commands.registerCommand('foundry.agent.skip', () => reenter('skip')),
    vscode.commands.registerCommand('foundry.agent.keep', () => {
      run?.service.keep();
      run = undefined;
      vscode.window.showInformationMessage('Foundry: kept all changes from this run.');
    }),
    vscode.commands.registerCommand('foundry.agent.undoAll', async () => {
      if (run) {
        const { restored, failed } = await run.service.undoAll();
        vscode.window.showInformationMessage(
          `Foundry: reverted ${restored} file${restored === 1 ? '' : 's'}` + (failed ? ` (${failed} failed)` : '') + '.',
        );
      }
      run = undefined;
    }),
    vscode.commands.registerCommand('foundry.agent.reviewAll', async () => {
      if (run) await openAllChangesDiff(run.service, run.service.changedFiles);
    }),
  );
}

export async function runAgentTurn(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
): Promise<vscode.ChatResult> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    stream.markdown('Open a folder in VS Code first.');
    return {};
  }

  // Resume from a button action (cross-turn — a chat turn can't pause mid-flight).
  if (run && run.pendingAction) {
    const st = run;
    const action = st.pendingAction;
    st.pendingAction = undefined;
    if (action === 'retry') {
      st.messages.push(vscode.LanguageModelChatMessage.User('Reconsider and try again, differently this time.'));
    } else if (action === 'skip') {
      st.messages.push(
        vscode.LanguageModelChatMessage.User(
          'Stop trying that part — finish up treating what has been applied so far as final.',
        ),
      );
    }
    await runOnce(request, stream, token, output);
    return {};
  }

  // Fresh turn.
  const service = new ExecutionService(workspaceRoot);
  run = {
    runId: `run-${Date.now()}`,
    messages: await seedMessages(chatContext, request),
    service,
    workspaceRoot,
    requestPrompt: request.prompt,
    answerText: '',
    cumulativeTokens: 0,
  };
  await runOnce(request, stream, token, output);
  return {};
}

async function runOnce(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  output: vscode.OutputChannel,
): Promise<void> {
  const st = run;
  if (!st) return;

  const result = await runAgent({
    request,
    stream,
    token,
    service: st.service,
    workspaceRoot: st.workspaceRoot,
    messages: st.messages,
  });
  st.cumulativeTokens = result.cumulativeTokens;
  st.answerText = result.answerText;

  for (const f of result.refs) stream.reference(vscode.Uri.file(f));

  if (!result.answered) {
    stream.markdown(
      '_I gathered context from the local index but the model returned no answer. ' +
        'See the “Semantic Search” output channel — the index may be empty, or the ' +
        'selected model may not support tool calls (pick a Copilot model)._',
    );
  } else if (result.usedTools.length > 0) {
    const names = result.usedTools.map((n) => n.replace(FOUNDRY_TOOL_PREFIX, '')).join(', ');
    stream.markdown(`\n\n---\n_Grounded via the local index: ${names}._`);
  }
  if (result.sawUnbuiltIndex) emitUnbuiltIndexHint(stream);
  renderTokenUsage(stream, result.tokensUsed, st.cumulativeTokens);

  if (st.service.changeCount === 0) {
    // Pure Q&A/plan answer — nothing to keep or undo. Offer the native
    // agent-mode escape only for a substantive plan/finding, same threshold
    // as before, so a one-line answer doesn't get a handoff button.
    if (result.answered) offerAgentModeEscape(stream, st.requestPrompt, st.answerText);
    run = undefined;
    return;
  }

  renderChangedFiles(stream, st.service.changedFiles);

  if (result.status === 'blocked') {
    output.appendLine(`[agent] blocked: ${result.reason}`);
    stream.markdown(`\n\n⛔ **Blocked:** ${result.reason ?? 'the agent could not proceed.'}\n`);
    stream.markdown('_Partial changes are left in place so you can inspect them._\n');
    renderDecisionButtons(stream);
    return;
  }

  finishRun(stream);
}

function finishRun(stream: vscode.ChatResponseStream): void {
  stream.markdown('\n\n---\n🎉 **Done.**\n');
  renderKeepUndo(stream);
}

function renderKeepUndo(stream: vscode.ChatResponseStream): void {
  const st = run;
  if (!st) return;
  const changed = st.service.changeCount;
  stream.markdown(`\n**${changed} file${changed === 1 ? '' : 's'} changed. Review, then:**\n`);
  stream.button({ command: 'foundry.agent.keep', title: '✓ Keep changes' });
  stream.button({ command: 'foundry.agent.undoAll', title: '↩ Undo all changes' });
}

function renderChangedFiles(stream: vscode.ChatResponseStream, files: string[]): void {
  if (files.length === 0) return;
  for (const f of files) stream.anchor(vscode.Uri.file(f));
  stream.button({ command: 'foundry.agent.reviewAll', title: '🔍 Review all changes' });
}

function renderDecisionButtons(stream: vscode.ChatResponseStream): void {
  const st = run;
  stream.button({ command: 'foundry.agent.retry', title: '↻ Retry' });
  stream.button({ command: 'foundry.agent.skip', title: '⤼ Skip & finish' });
  if (st) offerAgentModeEscape(stream, st.requestPrompt, st.answerText);
  stream.button({ command: 'foundry.agent.undoAll', title: '↩ Undo all changes' });
}

function offerAgentModeEscape(stream: vscode.ChatResponseStream, request: string, content: string): void {
  if (!content || content.trim().length < 40) return;
  stream.button({ command: 'foundry.implementPlan', title: '⚡ Continue in agent mode', arguments: [{ request, content }] });
}

// Client-side ~token estimate (see planAgent.ts) — not exact billed usage, since
// VS Code's stable chat API reports no server-side usage figure.
function renderTokenUsage(stream: vscode.ChatResponseStream, tokensThisTurn: number, cumulativeTokens: number): void {
  stream.markdown(`\n_~${fmtTokens(tokensThisTurn)} tokens this turn · ~${fmtTokens(cumulativeTokens)} total this run._\n`);
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
