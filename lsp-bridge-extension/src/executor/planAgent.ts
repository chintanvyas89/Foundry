import * as vscode from 'vscode';
import { FOUNDRY_TOOL_PREFIX } from '../languageModelTools';
import { EDIT_TOOLS, EDIT_TOOL_NAMES, runEditTool } from './editTools';
import { ExecutionService } from './executionService';

// The ONE @codebase agent loop — answers questions, proposes plans, AND makes
// changes, all through the same tool-calling loop. There is no separate
// "planning mode" vs "execution mode": the tool list always includes both the
// foundry_* lookups and the edit tools, and the model itself decides — from
// what the user actually asked — whether to just answer, propose a plan (and
// stop), or ground itself and go make the change. No mid-run checkpoints: once
// it decides to edit, it runs autonomously to completion or until genuinely
// stuck. This also means no separate "planning" conversation whose context gets
// discarded before "execution" starts — it is the same conversation throughout.

const MAX_ROUNDS = 40; // generous: one run may need to cover a whole multi-file change
const MAX_TOOL_RESULT_CHARS = 4000;
// Larger budget for tools that return actual source (search full bodies, read_file)
// — that's the code the model reasons over; still bounded, since results re-send
// every subsequent round.
const MAX_CODE_RESULT_CHARS = 8000;

const AGENT_PREAMBLE = [
  'You are @codebase, a coding assistant for the user’s CURRENT VS Code workspace. A local,',
  'offline code index is available through the foundry_* tools: foundry_semanticSearch,',
  'foundry_searchSymbol, foundry_traceCalls, foundry_showExecutionFlow, foundry_findUsages,',
  'foundry_findImplementations, foundry_architectureOverview, foundry_repoOverview,',
  'foundry_readFile, foundry_listDirectory, foundry_projectStandards, foundry_searchConfig.',
  'ALWAYS ground answers in this workspace by calling these tools before answering — never',
  'guess from memory. You ALSO have edit tools (apply_edit, create_file, delete_file,',
  'replace_symbol, insert_near_symbol, rename_symbol, add_import, remove_import, move_file) —',
  'no built-in VS Code tools, no terminal.',
  '\n\nDECIDE YOUR RESPONSE FROM WHAT THE USER ACTUALLY ASKED — there is no separate',
  '"plan mode"/"execute mode"; you choose per message:',
  '\n• An EXPLANATION ("what does X do", "how is Y handled")? Answer directly. Call no edit tools.',
  '\n• A PLAN, not the change itself ("how would I…", "what would it take to…", "should I…")?',
  'Answer with ONLY this markdown, filling every section, and call no edit tools:',
  '\n## Plan\n**Context:** current state in 1–2 lines.',
  '\n**Assumptions & open questions:** anything inferred or needing confirmation.',
  '\n**Files to change:** a bullet per file as `path` — what changes and why.',
  '\n**Steps:** a numbered, ordered list of concrete edits.',
  '\n**Risks / staleness:** what could break or go stale.',
  '\n**Verify:** the exact test/build commands (from real conventions/manifests you found) and a manual check.',
  '\n• AN ACTUAL FIX/CHANGE ("fix X", "implement Y", "add Z", "refactor…")? Ground yourself via',
  'foundry_* tools, then make the change directly with the edit tools — work through everything',
  'needed to completion in ONE continuous pass. Do not pause partway to ask permission once',
  'you\'ve decided edits are wanted; there is no per-step approval — the user reviews everything',
  'you changed at the end and can undo it all in one action, so proceed.',
  '\nIf genuinely unclear which of these three the user wants, ask ONE clarifying question rather',
  'than guessing.',
  '\n\nWHEN YOU DO EDIT: 1) Look up the REAL current code first — never edit from memory. A',
  'targeted foundry_readFile(file, symbol="name") is enough; you don\'t need the whole file. 2)',
  'Choose the right tool: apply_edit for a small tweak where you know the exact current text;',
  'replace_symbol to rewrite a WHOLE function/method/class (resolved by name via the language',
  'server — you don\'t need its exact current text); insert_near_symbol to add code next to an',
  'existing symbol; rename_symbol for a TRUE rename that must update every reference;',
  'add_import/remove_import/move_file for the obvious cases; create_file/delete_file for new or',
  'removed files. 3) When SEVERAL edits target the SAME file, apply them ONE AT A TIME, not as a',
  'batch of calls composed from a single earlier read: an earlier edit changes the surrounding',
  'text, so a "find" string you worked out before it ran can silently stop matching once it\'s',
  'applied. After an edit lands in a file you still have MORE edits for, treat your knowledge of',
  'that file as stale for the next one — fold adjacent changes into a single apply_edit instead of',
  'several when you can, and re-derive the next "find" from the tool\'s own diagnostics/feedback',
  'rather than the pre-edit read. 4) On a "symbol not found"/"ambiguous" error, add',
  'container/index/signature and retry — don\'t fall back to guessing text. On an apply_edit "not',
  'found" error, re-read the exact current text and retry. 5) Implement ONLY what\'s actually being asked — no unrelated changes.',
  '6) After editing, if diagnostics report errors you introduced, fix them before finishing.',
  '\n\nChoosing a LOOKUP tool (this matters — pick by what the user gave you):',
  '\n• PRIORITY RULE: if the request names an exact identifier or machine name (snake_case,',
  'dotted config id, or CamelCase — e.g. mercury_reference_card, field_hide_symbol,',
  'getUserById), try foundry_searchSymbol and/or foundry_searchConfig for that exact name',
  'FIRST — they are precise exact-match lookups, cheaper and more reliable than semantic',
  'search. Only call foundry_semanticSearch once those come up empty, or for the parts of',
  'the request that describe behaviour rather than name something exactly (a request often',
  'mixes both — e.g. "add a Hide Date toggle for mercury_reference_card" is a named-symbol',
  'lookup for the block PLUS a behavioural one for how the other toggles are implemented;',
  'do the name lookups first, then semantic search for the pattern).',
  '\n• Wants the repo LAYOUT / directory structure / "where do files live"? →',
  'foundry_listDirectory (a recursive file/folder tree; drill with path="…").',
  '\n• A PHP/Drupal repo, or a fully-qualified class name (has backslashes, e.g.',
  '`Drupal\\market\\Entity\\Foo`)? → foundry_readFile accepts the FQCN directly (it',
  'resolves to the file); call foundry_projectStandards to learn the framework and the',
  'namespace→directory (PSR-4) map, or "what standard/framework does this project use".',
  '\n• Names a specific SYMBOL (function/class/type/constant)? → foundry_searchSymbol',
  '(an exact name lookup). Do NOT use semanticSearch to find something named exactly.',
  '\n• Names a specific MODULE, DIRECTORY, or FILE? → foundry_architectureOverview',
  'with module="…" to locate it, then foundry_readFile to read its actual source. Do',
  'NOT semanticSearch a module/file name.',
  '\n• Asks about CONFIG — Drupal views/fields/displays, routes, permissions,',
  'services, a module’s dependencies, or any .yml setting ("which view lists X",',
  '"what fields does the Article type have", "what handles the /foo route")? →',
  'foundry_searchConfig (structured config is NOT in semanticSearch — it is never',
  'embedded), then foundry_readFile for the raw YAML.',
  '\n• Describes BEHAVIOUR but not a name ("how/where is X handled")? →',
  'foundry_semanticSearch to discover it by meaning.',
  '\n\nThen DRILL into what you found instead of searching again. foundry_readFile is',
  'TWO-PASS to save tokens: call it with just `file` first to get the OUTLINE (the',
  'file\'s functions/classes/methods with line ranges, no bodies), then call it again',
  'with `symbol="name"` to read just the code you need. (Or foundry_semanticSearch',
  'expand=[…] for a hit\'s full body.) Follow relationships with foundry_traceCalls /',
  'foundry_findUsages. To iterate a search, prefer mode:"refine"/"expand" or pinResults',
  '(cheap — reuses results). Re-run a fresh semanticSearch only for a genuinely different',
  'question, or when the first pass clearly missed — not to reword the same intent.',
  '\n\nCite concrete files as `path:line`. Be specific to this codebase.',
].join(' ');

export type AgentRunStatus = 'finished' | 'blocked';

export interface AgentRunResult {
  status: AgentRunStatus;
  reason?: string; // present when status === 'blocked'
  answered: boolean; // did the model stream any answer text?
  answerText: string; // accumulated answer/plan text, for the agent-mode handoff
  changedFiles: string[]; // absolute paths changed this run
  refs: string[]; // absolute file paths surfaced by tool results, for stream.reference
  usedTools: string[]; // foundry_* tool names called, for the "Grounded via" trailer
  sawUnbuiltIndex: boolean;
  tokensUsed: number; // ~tokens spent in THIS invocation (client-side estimate); the
  // caller (implement.ts) sums this across retries/skips for a true running total —
  // resist adding a "cumulative" field here, since this loop has no visibility into
  // prior invocations and can only report its own context SIZE, not tokens spent.
}

// Workspace custom-instruction files, in priority order. Built-in Copilot reads
// these automatically for its own chat; a third-party participant must load them
// itself. Capped so a long instructions file can't dominate the prompt.
const CONVENTION_FILES = ['.github/copilot-instructions.md', 'AGENTS.md', '.github/AGENTS.md'];
const MAX_CONVENTION_CHARS = 4000;

async function loadProjectConventions(): Promise<string | null> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return null;
  const parts: string[] = [];
  for (const name of CONVENTION_FILES) {
    try {
      const uri = vscode.Uri.joinPath(folder.uri, name);
      const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').trim();
      if (raw) parts.push(`# ${name}\n${raw}`);
    } catch {
      /* not present — skip */
    }
  }
  if (parts.length === 0) return null;
  const joined = parts.join('\n\n');
  return joined.length > MAX_CONVENTION_CHARS
    ? `${joined.slice(0, MAX_CONVENTION_CHARS)}\n…(truncated)`
    : joined;
}

// Seed a fresh run: the preamble, project conventions, prior turns in this chat
// (replayed from the rendered text VS Code exposes — not a full tool-call
// transcript; see the module doc in implement.ts for why), and the new prompt.
export async function seedMessages(
  chatContext: vscode.ChatContext,
  request: vscode.ChatRequest,
): Promise<vscode.LanguageModelChatMessage[]> {
  const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(AGENT_PREAMBLE)];

  const conventions = await loadProjectConventions();
  if (conventions) {
    messages.push(
      vscode.LanguageModelChatMessage.User(
        'Project conventions from this workspace (supplementary context; the tool-routing ' +
          `guidance above remains authoritative):\n\n${conventions}`,
      ),
    );
  }

  for (const turn of chatContext.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(vscode.LanguageModelChatMessage.User(turn.prompt));
    } else if (turn instanceof vscode.ChatResponseTurn) {
      let text = '';
      for (const part of turn.response) {
        if (part instanceof vscode.ChatResponseMarkdownPart) text += part.value.value;
      }
      if (text.trim()) messages.push(vscode.LanguageModelChatMessage.Assistant(text));
    }
  }

  messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
  return messages;
}

export interface AgentContext {
  request: vscode.ChatRequest;
  stream: vscode.ChatResponseStream;
  token: vscode.CancellationToken;
  service: ExecutionService;
  workspaceRoot: string;
  messages: vscode.LanguageModelChatMessage[];
}

export async function runAgent(ctx: AgentContext): Promise<AgentRunResult> {
  const { request, stream, token, service, workspaceRoot, messages } = ctx;
  const model = request.model;
  const foundryTools = vscode.lm.tools
    .filter((t) => t.name.startsWith(FOUNDRY_TOOL_PREFIX))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const tools: vscode.LanguageModelChatTool[] = [...foundryTools, ...EDIT_TOOLS];

  const usedTools = new Set<string>();
  const seenCalls = new Set<string>(); // (tool, input) already run this turn — skip repeats
  const refs = new Set<string>();
  let answered = false;
  let answerText = '';
  let endedMidTools = false;
  let sawUnbuiltIndex = false;
  let blockedReason: string | undefined;

  // Token accounting — a CLIENT-SIDE ESTIMATE via the model's own tokenizer
  // (vscode.LanguageModelChat has no server-reported usage API). `cumulativeContext`
  // tracks the running size of `messages`; each round's input cost is a snapshot of
  // that total (what actually gets re-sent), so this reflects the real repeated-
  // resend cost without re-tokenizing history every round.
  let cumulativeContext = 0;
  for (const m of messages) cumulativeContext += await countTokensSafe(model, m, token);
  let tokensUsed = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (token.isCancellationRequested) break;
    tokensUsed += cumulativeContext;

    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(messages, { tools }, token);
    } catch (err) {
      // Model can't do tool-calling (or tools rejected) — fall back to a single
      // grounded pass so the participant still answers (no edit capability without
      // tool calling, so this degrades to Q&A only).
      const fallbackText = await runFallbackRag(request, stream, model, token);
      return {
        status: 'finished',
        answered: true,
        answerText: fallbackText,
        changedFiles: [...service.changedFiles],
        refs: [],
        usedTools: [],
        sawUnbuiltIndex: false,
        tokensUsed,
      };
    }

    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    const assistantParts: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
    let roundText = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        stream.markdown(part.value);
        answered = answered || part.value.trim().length > 0;
        roundText += part.value;
        answerText += part.value;
        assistantParts.push(part);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
        assistantParts.push(part);
      }
    }
    const outTokens = await countTokensSafe(model, roundText, token);
    tokensUsed += outTokens;
    cumulativeContext += outTokens;

    const blocked = /\[BLOCKED:?\s*([^\]]*)\]/i.exec(roundText);
    if (blocked) blockedReason = blocked[1].trim() || 'the agent could not proceed';

    if (toolCalls.length === 0) break; // model produced its final answer
    endedMidTools = true;

    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
    const asstTokens = await countTokensSafe(model, messages[messages.length - 1], token);
    tokensUsed += asstTokens;
    cumulativeContext += asstTokens;

    const resultParts: vscode.LanguageModelToolResultPart[] = [];
    let newCalls = 0;
    for (const call of toolCalls) {
      if (token.isCancellationRequested) break;
      let resultText: string;

      if (EDIT_TOOL_NAMES.has(call.name)) {
        const input = (call.input ?? {}) as Record<string, unknown>;
        const key = callKey(call.name, input);
        if (seenCalls.has(key)) {
          resultText = '(Already attempted above with the same input — do not repeat this call; try something different.)';
        } else {
          seenCalls.add(key);
          newCalls += 1;
          stream.progress(`✎ ${call.name} ${typeof input.path === 'string' ? input.path : ''}`);
          resultText = await runEditTool(call.name, input, service, workspaceRoot);
        }
      } else {
        usedTools.add(call.name);
        const input = boostSearchInput(call.name, call.input ?? {});
        const key = callKey(call.name, input);
        if (seenCalls.has(key)) {
          resultText = '(Already retrieved above with the same input — reuse the earlier result; do not repeat this call.)';
        } else {
          seenCalls.add(key);
          newCalls += 1;
          stream.progress(labelFor(call));
          try {
            const r = await vscode.lm.invokeTool(
              call.name,
              { input, toolInvocationToken: request.toolInvocationToken },
              token,
            );
            resultText = toolText(r);
            collectRefs(resultText, refs);
            if (!sawUnbuiltIndex && mentionsUnbuiltIndex(resultText)) sawUnbuiltIndex = true;
          } catch (err) {
            resultText = `Tool ${call.name} failed: ${String(err)}`;
          }
        }
      }

      resultParts.push(
        new vscode.LanguageModelToolResultPart(
          call.callId,
          [new vscode.LanguageModelTextPart(head(resultText, budgetFor(call.name)))],
        ),
      );
    }
    messages.push(vscode.LanguageModelChatMessage.User(resultParts));
    const toolTokens = await countTokensSafe(model, messages[messages.length - 1], token);
    tokensUsed += toolTokens;
    cumulativeContext += toolTokens;

    if (newCalls === 0) break; // every call this round was a repeat — model is spinning
  }

  // The model may have spent all its rounds calling tools without ever
  // synthesizing (or produced no text at all). Force one final, tool-free pass
  // so the user always gets a written answer grounded in the tool results.
  if ((endedMidTools || !answered) && !token.isCancellationRequested && !blockedReason) {
    try {
      const finalMessages = [
        ...messages,
        vscode.LanguageModelChatMessage.User(
          'Now respond to the original request directly, using the tool results above (and any ' +
            'edits already made). Cite concrete files as `path:line`. Do not call any more tools.',
        ),
      ];
      const finalResp = await model.sendRequest(finalMessages, {}, token);
      let finalText = '';
      for await (const part of finalResp.text) {
        stream.markdown(part);
        finalText += part;
        answerText += part;
        answered = answered || part.trim().length > 0;
      }
      tokensUsed += await countTokensSafe(model, finalText, token);
    } catch {
      /* best effort — the streamed partial answer above still stands */
    }
  }

  return {
    status: blockedReason ? 'blocked' : 'finished',
    reason: blockedReason,
    answered,
    answerText,
    changedFiles: [...service.changedFiles],
    refs: [...refs],
    usedTools: [...usedTools],
    sawUnbuiltIndex,
    tokensUsed,
  };
}

async function countTokensSafe(
  model: vscode.LanguageModelChat,
  input: string | vscode.LanguageModelChatMessage,
  token: vscode.CancellationToken,
): Promise<number> {
  try {
    return await model.countTokens(input, token);
  } catch {
    return 0; // best-effort — a counting hiccup must never break execution
  }
}

// Fallback when the model doesn't support tool-calling: retrieve with
// semantic_search ourselves (via the LM tool directly) and ask the model to
// answer from those results. No edit capability without tool calling.
async function runFallbackRag(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string> {
  stream.progress('Searching the local index…');
  let contextText = '';
  try {
    const r = await vscode.lm.invokeTool(
      `${FOUNDRY_TOOL_PREFIX}semanticSearch`,
      { input: { query: request.prompt, context: true }, toolInvocationToken: request.toolInvocationToken },
      token,
    );
    contextText = toolText(r);
  } catch {
    /* leave context empty — the model will answer without grounding */
  }
  const messages = [
    vscode.LanguageModelChatMessage.User(AGENT_PREAMBLE),
    vscode.LanguageModelChatMessage.User(
      `Workspace search results:\n\n${contextText || '(no results)'}\n\n` +
        `Question: ${request.prompt}\n\nAnswer using the results above. Cite files as path:line.`,
    ),
  ];
  const response = await model.sendRequest(messages, {}, token);
  let text = '';
  for await (const part of response.text) {
    stream.markdown(part);
    text += part;
  }
  return text;
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

// Stable key for a tool call so repeats with the same input are detected
// regardless of key order.
function callKey(name: string, input: unknown): string {
  let body: string;
  try {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const obj = input as Record<string, unknown>;
      body = JSON.stringify(obj, Object.keys(obj).sort());
    } else {
      body = JSON.stringify(input);
    }
  } catch {
    body = String(input);
  }
  return `${name}:${body}`;
}

// Code-bearing tools carry the actual source the model reasons over, so they get
// a larger slice; signature/graph/overview tools stay lean (they re-send each round).
function budgetFor(toolName: string): number {
  return toolName === `${FOUNDRY_TOOL_PREFIX}semanticSearch` || toolName === `${FOUNDRY_TOOL_PREFIX}readFile`
    ? MAX_CODE_RESULT_CHARS
    : MAX_TOOL_RESULT_CHARS;
}

// Weak models often call foundry_semanticSearch and then reason over the compact
// signatures it returns by default, producing shallow answers. When the model
// hasn't asked for bodies (no expand, no explicit detail), request full bodies for
// a bounded number of hits so it always has real code to work from.
function boostSearchInput(name: string, input: object): Record<string, unknown> {
  const obj = input as Record<string, unknown>;
  if (name !== `${FOUNDRY_TOOL_PREFIX}semanticSearch`) return obj;
  if ('expand' in obj || obj.detail) return obj; // model already wants specific bodies
  const topK = Math.min(Number(obj.topK) || 5, 5);
  return { ...obj, detail: 'full', topK };
}

// Best-effort extraction of file paths from a tool result's text so we can add
// clickable references. Matches absolute paths (…/foo.ts optionally :line).
function collectRefs(text: string, refs: Set<string>): void {
  const re = /((?:\/|[A-Za-z]:\\)[^\s():"']+\.[A-Za-z0-9]{1,6})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    refs.add(m[1]);
    if (refs.size >= 20) break;
  }
}

// The index-status tools (repo_overview, architecture_overview, show_execution_flow,
// trace_calls/find_usages offline) say "not built" and point at SWE_BUILD_* when the
// symbol table / call graph / usages index were never built for this workspace.
function mentionsUnbuiltIndex(text: string): boolean {
  return /\bnot built\b/i.test(text) || /SWE_BUILD_/.test(text);
}

// A single, actionable notice appended once when the code-intelligence indexes
// are missing on this machine. Embedding-free fix — no re-index of vectors.
export function emitUnbuiltIndexHint(stream: vscode.ChatResponseStream): void {
  stream.markdown(
    '\n\n> ⚠️ **Code-intelligence indexes are not built for this workspace**, so ' +
      'architecture, call-graph, and usage lookups came back empty — the answer above ' +
      'may be shallow, and a weaker model can make extra tool attempts hunting for them. ' +
      'Building them is a one-time, **embedding-free** pass (your vectors are untouched):\n' +
      '>\n' +
      '> 1. Open this workspace in VS Code with the Foundry extension running (status bar shows `LSP Bridge: listening`).\n' +
      '> 2. Add `"SWE_BUILD_ALL": "1"` to the `env` in `.vscode/mcp.json`, then restart the `local-semantic-search` MCP server.\n' +
      '> 3. Wait for the four `done` logs in its output, then remove the flag.\n' +
      '>\n' +
      "> Or drop a teammate's prebuilt `.swe-search/index.db` into this workspace — the indexes travel with it.",
  );
}
