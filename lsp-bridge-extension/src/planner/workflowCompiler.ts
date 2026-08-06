import * as vscode from 'vscode';
import { Workflow, WORKFLOW_IR_VERSION } from '../execution/ir';

// Compiles a human-readable plan into Workflow IR (execution-v2.md §4). This is the
// one place the model turns prose into an executable script; it is a *validated*
// compile, not a free-form "formatter": we schema-check the JSON and, if it's wrong,
// send the errors back for a single repair pass before giving up. Keeping the plan
// human-readable (produced by /plan) and compiling it here preserves the reviewable
// artifact while still yielding a deterministic workflow to execute.

export interface CompileResult {
  workflow?: Workflow;
  error?: string;
  raw?: string;
}

const SCHEMA_GUIDE = `
Output ONLY a JSON object (no markdown fence, no prose) of this shape:

{
  "version": "2.0",
  "objective": "<one line: what this change accomplishes>",
  "summary": "<2-3 sentences>",
  "steps": [
    {
      "id": "step-1",
      "title": "<short imperative>",
      "executor": "workspace" | "terminal" | "validation" | "user",
      "dependsOn": ["step-0"],          // optional; ids of prerequisite steps
      "completionCondition": { "type": "automatic" },  // see below
      "script": [ <operation>, ... ]
    }
  ]
}

completionCondition types:
  {"type":"automatic"}
  {"type":"user_confirmation"}
  {"type":"command_exit_code","expected":0}
  {"type":"tests_passed"}
  {"type":"file_modified","path":"relative/path"}

WORKSPACE operations (executor "workspace") — PREFER symbol-anchored ops over line
numbers; provide the COMPLETE new code, not a description:
  {"operation":"replace_function","target":{"file":"p","symbol":"Name"},"replacement":"<full new fn>"}
  {"operation":"replace_method"|"replace_block", ...same as above...}
  {"operation":"insert_before"|"insert_after","target":{"file":"p","symbol":"Name"},"code":"<code>"}
  {"operation":"replace_lines","target":{"file":"p"},"startLine":N,"endLine":M,"replacement":"<code>"}
  {"operation":"replace_text","target":{"file":"p"},"find":"<exact text>","replace":"<text>","all":false}
  {"operation":"append"|"prepend","target":{"file":"p"},"code":"<code>"}
  {"operation":"create_file","file":"p","contents":"<full file>"}
  {"operation":"delete_file","file":"p"}
  {"operation":"move_file","from":"p","to":"q"}
  {"operation":"rename_symbol","target":{"file":"p","symbol":"Old"},"newName":"New"}
  {"operation":"add_import"|"remove_import","target":{"file":"p"},"statement":"<import line>"}
  target may add "container","index" or "signature" to disambiguate a non-unique symbol.

TERMINAL operation (executor "terminal"): {"operation":"run","command":"<cmd>"}
VALIDATION operation (executor "validation"): {"operation":"validate","kind":"build"|"tests"|"lint"|"diagnostics"|"custom","command":"<cmd if needed>"}
USER operation (executor "user"): {"operation":"manual","instructions":["step","step"]}

Rules: one executor kind per step. Put edits in "workspace" steps, shell commands in
"terminal" steps, checks in "validation" steps. Use file paths relative to the workspace
root, exactly as they appear in the plan/context. Emit valid JSON only.`;

export async function compilePlan(
  model: vscode.LanguageModelChat,
  planText: string,
  originalRequest: string,
  token: vscode.CancellationToken,
): Promise<CompileResult> {
  const system = vscode.LanguageModelChatMessage.User(
    'You compile an approved implementation plan into an executable Workflow IR. ' +
      'The plan is authoritative — do not re-design it. Translate every concrete edit, ' +
      'command, and check it describes into operations, preserving exact code. ' +
      SCHEMA_GUIDE,
  );
  const ask = vscode.LanguageModelChatMessage.User(
    `Original request:\n${originalRequest || '(not provided)'}\n\n` +
      `Approved plan to compile:\n\n${planText}\n\nEmit the Workflow IR JSON now.`,
  );

  let raw = await send(model, [system, ask], token);
  let parsed = tryParseWorkflow(raw);
  if (parsed.workflow) return parsed;

  // One repair pass: hand the parser/validation error back and ask for a fix.
  const repair = vscode.LanguageModelChatMessage.User(
    `That was not valid Workflow IR: ${parsed.error}\n\n` +
      `Here is what you returned:\n${head(raw, 4000)}\n\n` +
      'Return ONLY the corrected JSON workflow — no prose, no markdown fence.',
  );
  raw = await send(model, [system, ask, repair], token);
  parsed = tryParseWorkflow(raw);
  if (parsed.workflow) return parsed;
  return { error: parsed.error, raw };
}

async function send(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  token: vscode.CancellationToken,
): Promise<string> {
  const resp = await model.sendRequest(messages, {}, token);
  let text = '';
  for await (const part of resp.text) text += part;
  return text;
}

function tryParseWorkflow(raw: string): CompileResult {
  const json = extractJson(raw);
  if (!json) return { error: 'no JSON object found in the response' };
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    return { error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const errors = validateWorkflow(obj);
  if (errors.length > 0) return { error: errors.join('; ') };
  const wf = obj as Workflow;
  if (!wf.version) wf.version = WORKFLOW_IR_VERSION;
  return { workflow: wf };
}

// Pull the outermost {...} out of the response, tolerating a ```json fence or
// stray prose around it.
function extractJson(raw: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

const EXECUTORS = new Set(['workspace', 'terminal', 'validation', 'user']);

function validateWorkflow(obj: unknown): string[] {
  const errors: string[] = [];
  if (!obj || typeof obj !== 'object') return ['top level is not an object'];
  const wf = obj as Record<string, unknown>;
  if (!Array.isArray(wf.steps) || wf.steps.length === 0) {
    return ['"steps" must be a non-empty array'];
  }
  const ids = new Set<string>();
  wf.steps.forEach((s: unknown, i: number) => {
    const step = s as Record<string, unknown>;
    const at = `step ${i}`;
    if (!step || typeof step !== 'object') {
      errors.push(`${at} is not an object`);
      return;
    }
    if (typeof step.id !== 'string' || !step.id) errors.push(`${at} missing "id"`);
    else ids.add(step.id);
    if (typeof step.executor !== 'string' || !EXECUTORS.has(step.executor)) {
      errors.push(`${at} has invalid executor "${String(step.executor)}"`);
    }
    if (!Array.isArray(step.script) || step.script.length === 0) {
      errors.push(`${at} "script" must be a non-empty array`);
    } else {
      step.script.forEach((op: unknown, j: number) => {
        const o = op as Record<string, unknown>;
        if (!o || typeof o.operation !== 'string') {
          errors.push(`${at} op ${j} missing "operation"`);
        }
      });
    }
  });
  return errors;
}

function head(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n…(truncated)' : s;
}
