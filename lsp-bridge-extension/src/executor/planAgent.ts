import * as vscode from 'vscode';
import { FOUNDRY_TOOL_PREFIX } from '../languageModelTools';
import { EDIT_TOOLS, EDIT_TOOL_NAMES, runEditTool } from './editTools';
import { ExecutionService } from './executionService';

// The LLM "brain": drives ONE continuous tool-calling loop over the whole approved
// plan — foundry_* to look up the real code, and the edit tools to change it (which
// route to the headless ExecutionService). Reuses the same shape as chatParticipant's
// runAgentic. It streams its work to chat and runs until it reaches a natural
// checkpoint, finishes, or is blocked. The conversation `messages` persists across
// turns (checkpoints), so the brain keeps full context as the user continues it.

const MAX_ROUNDS = 15;
const MAX_TOOL_RESULT_CHARS = 6000;

const EXECUTION_SYSTEM = [
  'You are Foundry’s execution agent. You implement an APPROVED plan in the user’s workspace,',
  'working through it in order in ONE continuous pass. Rules:',
  '1) Before ANY edit, look up the real current code with the foundry_* tools — never edit from memory.',
  '2) Change files ONLY with apply_edit / create_file / delete_file. apply_edit’s `find` must be the',
  'EXACT current text and unique; if it errors, re-read the file and retry with corrected text.',
  '3) Implement ONLY what the plan says — no unrelated changes.',
  '4) After editing, if diagnostics report errors you introduced, fix them before moving on.',
  '5) You have NO other tools (no terminal, no built-in search).',
  'PACING: after completing each logical unit of the plan, STOP and end your turn with',
  '"[CHECKPOINT: <one-line summary of what you just did>]" so the user can review — do NOT keep going',
  'past a checkpoint in the same turn. When the ENTIRE plan is implemented, end with "[DONE]".',
  'If you genuinely cannot proceed even after retrying, end with "[BLOCKED: <short reason>]".',
].join(' ');

export type PlanRunStatus = 'checkpoint' | 'done' | 'blocked';

export interface PlanRunResult {
  status: PlanRunStatus;
  summary?: string; // checkpoint summary (what was just done)
  reason?: string; // blocked reason
  changedFiles: string[]; // absolute paths changed during this segment
}

export function seedMessages(planText: string, originalRequest: string): vscode.LanguageModelChatMessage[] {
  return [
    vscode.LanguageModelChatMessage.User(EXECUTION_SYSTEM),
    vscode.LanguageModelChatMessage.User(
      `Original request:\n${originalRequest || '(not provided)'}\n\nApproved plan:\n${planText}`,
    ),
  ];
}

export interface PlanAgentContext {
  request: vscode.ChatRequest;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  service: ExecutionService;
  workspaceRoot: string;
  messages: vscode.LanguageModelChatMessage[];
}

// Run the brain until it emits a control marker (or the round budget is spent).
// `messages` must already contain the seed + whatever user turn kicked off / resumed
// this segment; this function only appends the assistant/tool exchange.
export async function runPlanAgent(ctx: PlanAgentContext): Promise<PlanRunResult> {
  const { request, stream, token, service, workspaceRoot, messages } = ctx;
  const foundryTools = vscode.lm.tools
    .filter((t) => t.name.startsWith(FOUNDRY_TOOL_PREFIX))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const tools: vscode.LanguageModelChatTool[] = [...foundryTools, ...EDIT_TOOLS];

  let finalText = ''; // all assistant text this segment — scanned for control markers
  let tailText = ''; // text from the final (no-tool-call) round — the closing turn
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (token.isCancellationRequested) {
      return { status: 'blocked', reason: 'cancelled', changedFiles: [...service.currentSegmentFiles] };
    }

    let response: vscode.LanguageModelChatResponse;
    try {
      response = await request.model.sendRequest(messages, { tools }, token);
    } catch (err) {
      return { status: 'blocked', reason: `model request failed: ${String(err)}`, changedFiles: [...service.currentSegmentFiles] };
    }

    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
    let roundText = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        stream.markdown(part.value);
        roundText += part.value;
        finalText += part.value;
        assistantParts.push(part);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
        assistantParts.push(part);
      }
    }

    if (toolCalls.length === 0) {
      tailText = roundText; // the model ended its turn (marker lives here)
      break;
    }
    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

    const resultParts: vscode.LanguageModelToolResultPart[] = [];
    for (const call of toolCalls) {
      if (token.isCancellationRequested) {
        return { status: 'blocked', reason: 'cancelled', changedFiles: [...service.currentSegmentFiles] };
      }
      let resultText: string;
      const input = (call.input ?? {}) as Record<string, unknown>;
      if (EDIT_TOOL_NAMES.has(call.name)) {
        stream.progress(`✎ ${call.name} ${typeof input.path === 'string' ? input.path : ''}`);
        resultText = await runEditTool(call.name, input, service, workspaceRoot);
      } else {
        stream.progress(labelFor(call));
        try {
          const r = await vscode.lm.invokeTool(
            call.name,
            { input, toolInvocationToken: request.toolInvocationToken },
            token,
          );
          resultText = toolText(r);
        } catch (err) {
          resultText = `Tool ${call.name} failed: ${String(err)}`;
        }
      }
      resultParts.push(
        new vscode.LanguageModelToolResultPart(call.callId, [
          new vscode.LanguageModelTextPart(head(resultText, MAX_TOOL_RESULT_CHARS)),
        ]),
      );
    }
    messages.push(vscode.LanguageModelChatMessage.User(resultParts));
  }

  // Record the closing assistant turn (only the final round's text — earlier rounds
  // were already pushed with their tool calls, so this avoids duplicating them).
  if (tailText.trim()) messages.push(vscode.LanguageModelChatMessage.Assistant(tailText));

  return classify(finalText, [...service.currentSegmentFiles]);
}

// Classify a finished segment from its control marker (last marker wins). No marker
// means the turn ended (or hit the round budget) without a verdict → treat as a
// checkpoint so the run pauses for the user rather than silently stopping.
function classify(finalText: string, changedFiles: string[]): PlanRunResult {
  const markers = findMarkers(finalText);
  const last = markers[markers.length - 1];
  if (last?.kind === 'blocked') {
    return { status: 'blocked', reason: last.text || 'the agent could not proceed', changedFiles };
  }
  if (last?.kind === 'done') {
    return { status: 'done', changedFiles };
  }
  return { status: 'checkpoint', summary: last?.kind === 'checkpoint' ? last.text : '', changedFiles };
}

type Marker = { kind: 'checkpoint' | 'done' | 'blocked'; text: string };

function findMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  const re = /\[(CHECKPOINT|DONE|BLOCKED)(?::?\s*([^\]]*))?\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ kind: m[1].toLowerCase() as Marker['kind'], text: (m[2] ?? '').trim() });
  }
  return out;
}

function toolText(r: vscode.LanguageModelToolResult): string {
  let t = '';
  for (const part of r.content) {
    if (part instanceof vscode.LanguageModelTextPart) t += part.value;
  }
  return t || '(no result)';
}

function labelFor(call: vscode.LanguageModelToolCallPart): string {
  const info = vscode.lm.tools.find((t) => t.name === call.name);
  const d = info?.description?.split(/[.\n]/)[0]?.trim() ?? call.name;
  return d.length > 60 ? d.slice(0, 57) + '…' : d;
}

function head(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n…(truncated)' : s;
}
