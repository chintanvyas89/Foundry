import * as vscode from 'vscode';
import { compilePlan } from './planner/workflowCompiler';
import { ExecutionController, EXECUTION_VIEW_ID } from './executionView';

// `@codebase /implement` — the in-house execution entry point (execution-v2.md).
// It compiles the most recent plan into a Workflow IR and hands it to the Foundry
// Execution view, which runs it step-by-step with native-diff review + Keep/Undo.
// Chat stays for planning and steering; the view owns execution.

let controller: ExecutionController | undefined;

export function setExecutionController(c: ExecutionController): void {
  controller = c;
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
  if (!controller) {
    stream.markdown('_The Foundry Execution view isn’t ready. Reload the window and try again._');
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

  controller.start(workflow, workspaceRoot);
  try {
    await vscode.commands.executeCommand(`${EXECUTION_VIEW_ID}.focus`);
  } catch {
    /* view focus is best-effort */
  }

  stream.markdown(`### ${workflow.objective || 'Execution plan'}\n\n`);
  if (workflow.summary) stream.markdown(`${workflow.summary}\n\n`);
  stream.markdown(
    'Opened in the **Foundry Execution** view (Activity Bar → Semantic Search). For each step: ' +
      '**Open diff** to review, then **Approve** / **Skip** — or **Apply all** to run the rest. ' +
      'When you’re done: **Keep** or **Undo all**.\n\n',
  );
  workflow.steps.forEach((s, i) => {
    stream.markdown(`${i + 1}. **${s.title}** _(${s.executor})_\n`);
  });
  // Manual escape if the in-house run isn't the right fit.
  offerAgentModeEscape(stream, originalRequest, planText);
  return {};
}

// Push the plan to VS Code's built-in agent mode (full native toolset) — the
// manual escape hatch when in-house execution isn't the right fit.
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
