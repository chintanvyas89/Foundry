import * as vscode from 'vscode';
import { FOUNDRY_TOOL_PREFIX } from '../languageModelTools';
import { EDIT_TOOLS, EDIT_TOOL_NAMES, runEditTool } from './editTools';
import { ExecutionService } from './executionService';
import type { AgentOutput } from './agentOutput';

// The shared agent loop — answers questions, proposes plans, AND makes changes,
// all through the same tool-calling loop. It is surface-agnostic: what varies
// between the @codebase chat participant and the Foundry panel is injected via
// AgentContext (where output goes, which tools are offered, what preamble the
// caller seeded into `messages`), not branched on in here.
//
// As the chat participant drives it, there is no separate "planning mode" vs
// "execution mode": the tool list holds both the foundry_* lookups and the edit
// tools, and the model itself decides — from what the user actually asked —
// whether to just answer, propose a plan (and stop), or ground itself and go
// make the change. No mid-run checkpoints: once it decides to edit, it runs
// autonomously to completion or until genuinely stuck, so no "planning"
// conversation gets its context discarded before "execution" starts.
//
// The panel splits that into two runs on purpose, and can do so safely because
// it owns the session: it hands the second run a curated context package rather
// than relying on a chat turn boundary that would have thrown the findings away.

const MAX_ROUNDS = 40; // generous: one run may need to cover a whole multi-file change
const MAX_TOOL_RESULT_CHARS = 4000;
// Larger budget for tools that return actual source (search full bodies, read_file)
// — that's the code the model reasons over; still bounded, since results re-send
// every subsequent round.
const MAX_CODE_RESULT_CHARS = 8000;

// chatContext.history replay in seedMessages() — see there for why this is bounded
// rather than replaying every prior turn in full on every future turn.
const MAX_VERBATIM_TURNS = 3; // request/response pairs
const COMPACT_EXCERPT_CHARS = 150; // per compacted (older) turn

// Not every model follows "don't ask permission, just edit" as reliably as
// others — some (observed: GPT-5 mini) plan correctly but then stop to ask
// "should I apply this?" in plain text instead of calling an edit tool, even
// after being told to proceed. Since the preamble alone doesn't guarantee
// compliance, the LOOP enforces it: a round with no tool calls whose text
// asks permission to act, before any edit has actually landed, gets a firm
// "yes, proceed" nudge and another round — bounded, so a model that keeps
// refusing regardless still ends the turn rather than looping forever.
const MAX_PERMISSION_NUDGES = 2;
const PERMISSION_ASK_RE =
  /\b(should i|shall i|do you want me to|would you like me to|can i go ahead|ok(?:ay)? (?:for me )?to|you(?:'d| would) like me to)\b[^.?!\n]{0,60}\b(apply|implement|proceed|execute|go ahead|make (?:the|this) change|run (?:the|this))\b/i;

// ---------------------------------------------------------------------------
// Preamble segments.
//
// The text is split into ordered, named blocks rather than one constant so a
// second surface (the Foundry panel, which runs exploration and implementation
// as two separate model calls) can compose the subset each phase needs — an
// exploration pass has no business carrying the edit rules, and an
// implementation pass has no business carrying "decide whether to just answer".
//
// Composition is a flat join with ' ', exactly as the single array was, so
// CHAT_PREAMBLE below is byte-identical to the constant it replaced. Keep it
// that way: the chat participant's behaviour must not shift because of a
// refactor done for the panel's benefit.
// ---------------------------------------------------------------------------

// Who you are and what tools exist. Assumes edit tools are in the tool list.
const SEG_IDENTITY = [
  'You are @codebase, a coding assistant for the user’s VS Code workspace. A local, offline',
  'code index is available through the foundry_* tools: foundry_semanticSearch,',
  'foundry_searchSymbol, foundry_traceCalls, foundry_showExecutionFlow, foundry_findUsages,',
  'foundry_findImplementations, foundry_architectureOverview, foundry_repoOverview,',
  'foundry_readFile, foundry_listDirectory, foundry_projectStandards, foundry_searchConfig.',
  'ALWAYS ground answers by calling these tools first — never guess from memory. You ALSO',
  'have edit tools (apply_edit, create_file, delete_file, replace_symbol, insert_near_symbol,',
  'rename_symbol, add_import, remove_import, move_file) — no built-in VS Code tools, no terminal.',
];

// Intent routing: one turn, model picks explanation vs plan vs change. This is
// the chat participant's defining behaviour — a two-phase surface knows its
// phase up front and replaces this segment rather than including it.
const SEG_INTENT_ROUTING = [
  '\n\nDECIDE YOUR RESPONSE FROM WHAT WAS ASKED — no separate "plan mode"/"execute mode";',
  'choose per message:',
  '\n• An EXPLANATION ("what does X do", "how is Y handled")? Answer directly, no edit tools.',
  '\n• A PLAN, not the change itself ("how would I…", "what would it take to…")? Answer with',
  'ONLY this markdown, filling every section, no edit tools:',
  '\n## Plan\n**Context:** current state in 1–2 lines.',
  '\n**Assumptions & open questions:** anything inferred or needing confirmation.',
  '\n**Files to change:** a bullet per file as `path` — what changes and why.',
  '\n**Steps:** a numbered, ordered list of concrete edits.',
  '\n**Risks / staleness:** what could break or go stale.',
  '\n**Verify:** the exact test/build commands (from real conventions/manifests you found) and a manual check.',
  '\n• AN ACTUAL FIX/CHANGE ("fix X", "implement Y", "add Z", "refactor…")? Ground via foundry_*',
  'tools, then edit directly — work through everything needed in ONE continuous pass. NEVER stop',
  'to ask "should I apply this change?" / "shall I proceed?" — asking means you already decided',
  'edits are wanted, so the answer is always yes: call the edit tool now, don\'t ask. No per-step',
  'approval — review/undo happens at the end, so proceed without pausing.',
  '\nIf unclear which of these three is wanted, ask ONE clarifying question rather than guessing.',
];

// How to edit safely. Needed by any phase that has the edit tools in its list.
const SEG_EDIT_RULES = [
  '\n\nWHEN YOU DO EDIT: 1) Look up the REAL current code first — never edit from memory; a',
  'targeted foundry_readFile(file, symbol="name") suffices, skip the whole file. 2) Pick the tool',
  'by what you need: apply_edit (exact known text), replace_symbol (whole function/method/class,',
  'no exact text needed), insert_near_symbol, rename_symbol (cross-reference), add/remove_import,',
  'move_file, create_file/delete_file. 3) When SEVERAL edits target the SAME file, apply them ONE',
  'AT A TIME, not batched from a single earlier read — an edit changes the surrounding text, so a',
  '"find" string from before it ran can silently stop matching. Fold adjacent changes into one',
  'apply_edit when you can; otherwise re-derive the next "find" from fresh diagnostics/feedback,',
  'not the pre-edit read. 4) On a "symbol not found"/"ambiguous" error, add',
  'container/index/signature and retry (don\'t guess text); on an apply_edit "not found" error,',
  're-read the exact text and retry. 5) Implement ONLY what\'s asked — no unrelated changes. 6) Fix',
  'any diagnostics errors you introduced before finishing.',
];

// Which lookup tool to reach for, and how to drill rather than re-search.
// Every phase on every surface wants this — it's the whole point of the index.
const SEG_LOOKUP_ROUTING = [
  '\n\nChoosing a LOOKUP tool:',
  '\n• PRIORITY RULE: an exact identifier/machine name (snake_case, dotted config id, CamelCase —',
  'e.g. mercury_reference_card, getUserById)? Try foundry_searchSymbol/foundry_searchConfig FIRST',
  '— precise exact-match, cheaper than semantic search. Call foundry_semanticSearch only once',
  'those miss, or for the behavioural part of a mixed request (e.g. "add a Hide Date toggle for',
  'mercury_reference_card" mixes a name lookup with a behavioural one — name lookup first).',
  '\n• Repo LAYOUT / directory structure / "where do files live"? → foundry_listDirectory (a',
  'recursive tree; drill with path="…").',
  '\n• A namespaced/fully-qualified class name (backslashes, e.g. `Acme\\Module\\Entity\\Foo`)? →',
  'foundry_readFile accepts the FQCN directly (auto-detected standards resolve it — Composer',
  'PSR-4, plus e.g. Drupal\'s runtime namespaces if present); foundry_projectStandards reports',
  'what was detected.',
  '\n• A specific SYMBOL (function/class/type/constant)? → foundry_searchSymbol (exact name',
  'lookup) — not semanticSearch.',
  '\n• A specific MODULE/DIRECTORY/FILE? → foundry_architectureOverview(module="…") to locate it,',
  'then foundry_readFile — not semanticSearch.',
  '\n• CONFIG — any structured .yml setting (e.g. Drupal views/fields, routes, permissions,',
  'services; "which view lists X")? → foundry_searchConfig (never embedded, NOT in',
  'semanticSearch), then foundry_readFile for the raw YAML.',
  '\n• BEHAVIOUR but not a name ("how/where is X handled")? → foundry_semanticSearch to discover',
  'it by meaning.',
  '\n\nThen DRILL into what you found instead of searching again. foundry_semanticSearch returns',
  'compact signatures by default — triage from those, then call it again with expand=[n,…] for',
  'just the bodies you need, rather than re-searching. foundry_readFile is TWO-PASS too: `file`',
  'alone for the OUTLINE (functions/classes/methods, line ranges, no bodies), then again with',
  '`symbol="name"` for just the code you need. Follow relationships with',
  'foundry_traceCalls/foundry_findUsages. To iterate, prefer mode:"refine"/"expand" or pinResults',
  '(cheap — reuses results) over a fresh semanticSearch — only re-run fresh for a genuinely',
  'different question, not to reword the same intent.',
  '\n\nFor SEVERAL independent lookups (e.g. a symbol check AND a config check), call them',
  'together in the SAME round, not one at a time — each extra round re-sends this preamble.',
  'Don\'t batch a call that DEPENDS on an earlier one\'s result.',
];

const SEG_CITE = ['\n\nCite concrete files as `path:line`. Be specific to this codebase.'];

// Flat join with ' ' — the same operation the one-piece array performed, so
// segment boundaries add no characters of their own.
export function composePreamble(...segments: string[][]): string {
  return segments.flat().join(' ');
}

// Exported so another surface can compose its own preamble from the same
// vetted wording rather than forking a second copy that drifts.
export const PREAMBLE_SEGMENTS = {
  identity: SEG_IDENTITY,
  intentRouting: SEG_INTENT_ROUTING,
  editRules: SEG_EDIT_RULES,
  lookupRouting: SEG_LOOKUP_ROUTING,
  cite: SEG_CITE,
} as const;

// The chat participant's preamble: every segment, in the original order.
// Byte-identical to the pre-refactor AGENT_PREAMBLE constant.
const CHAT_PREAMBLE = composePreamble(
  SEG_IDENTITY,
  SEG_INTENT_ROUTING,
  SEG_EDIT_RULES,
  SEG_LOOKUP_ROUTING,
  SEG_CITE,
);

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
  const messages: vscode.LanguageModelChatMessage[] = [vscode.LanguageModelChatMessage.User(CHAT_PREAMBLE)];

  const conventions = await loadProjectConventions();
  if (conventions) {
    messages.push(
      vscode.LanguageModelChatMessage.User(
        'Project conventions from this workspace (supplementary context; the tool-routing ' +
          `guidance above remains authoritative):\n\n${conventions}`,
      ),
    );
  }

  // Replay the most recent MAX_VERBATIM_TURNS request/response pairs in full — that
  // comfortably covers the continuity case this exists for ("give me a plan" → next
  // turn "go ahead") plus a bit of follow-up beyond it. Turns older than that would
  // otherwise replay in full on EVERY future turn of a long session (unbounded
  // growth), so they're compacted to a short excerpt instead of dropped outright —
  // the model still gets a breadcrumb of what happened earlier rather than a silent
  // gap, at a fraction of the resend cost.
  const cutoff = chatContext.history.length - MAX_VERBATIM_TURNS * 2;
  chatContext.history.forEach((turn, i) => {
    const compact = i < cutoff;
    if (turn instanceof vscode.ChatRequestTurn) {
      messages.push(
        vscode.LanguageModelChatMessage.User(compact ? head(turn.prompt, COMPACT_EXCERPT_CHARS) : turn.prompt),
      );
    } else if (turn instanceof vscode.ChatResponseTurn) {
      let text = '';
      for (const part of turn.response) {
        if (part instanceof vscode.ChatResponseMarkdownPart) text += part.value.value;
      }
      if (!text.trim()) return;
      messages.push(
        vscode.LanguageModelChatMessage.Assistant(compact ? head(text, COMPACT_EXCERPT_CHARS) : text),
      );
    }
  });

  messages.push(vscode.LanguageModelChatMessage.User(request.prompt));
  return messages;
}

// Every foundry_* lookup tool currently registered, in LanguageModelChatTool shape.
export function lookupTools(): vscode.LanguageModelChatTool[] {
  return vscode.lm.tools
    .filter((t) => t.name.startsWith(FOUNDRY_TOOL_PREFIX))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

// Lookups + edits: what a run that is allowed to change files gets. This is the
// chat participant's list, and runAgent()'s default when none is injected.
export function defaultAgentTools(): vscode.LanguageModelChatTool[] {
  return [...lookupTools(), ...EDIT_TOOLS];
}

export interface AgentContext {
  model: vscode.LanguageModelChat;
  /** The user's request text — used by the no-tool-calling fallback path. */
  prompt: string;
  /**
   * Chat-only: forwarded to lm.invokeTool so a tool can raise confirmation UI in
   * the chat turn. `undefined` outside a chat request, which is the documented
   * value for invoking tools from any other flow.
   */
  toolInvocationToken?: vscode.ChatParticipantToolToken;
  out: AgentOutput;
  token: vscode.CancellationToken;
  service: ExecutionService;
  workspaceRoot: string;
  messages: vscode.LanguageModelChatMessage[];
  /**
   * Tools offered to the model. Defaults to lookups + edits. A phase that must
   * not touch files (exploration/planning) passes lookupTools() instead — the
   * only airtight way to guarantee it, since prompt text alone doesn't bind.
   */
  tools?: vscode.LanguageModelChatTool[];
}

export async function runAgent(ctx: AgentContext): Promise<AgentRunResult> {
  const { model, prompt, toolInvocationToken, out, token, service, workspaceRoot, messages } = ctx;
  const tools = ctx.tools ?? defaultAgentTools();

  const usedTools = new Set<string>();
  const seenCalls = new Set<string>(); // (tool, input) already run this turn — skip repeats
  const refs = new Set<string>();
  let answered = false;
  let answerText = '';
  let endedMidTools = false;
  let sawUnbuiltIndex = false;
  let blockedReason: string | undefined;
  let editToolCalled = false;
  let permissionNudges = 0;

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
      const fallbackText = await runFallbackRag(prompt, toolInvocationToken, out, model, token);
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
        out.markdown(part.value);
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

    if (toolCalls.length === 0) {
      // The model ended with plain text, no tool calls. Normally that's the
      // final answer — UNLESS it's asking permission to do the very edit it
      // was already told to do and hasn't; then override it instead of
      // ending the turn (see MAX_PERMISSION_NUDGES doc comment above).
      if (
        !editToolCalled &&
        service.changeCount === 0 &&
        permissionNudges < MAX_PERMISSION_NUDGES &&
        PERMISSION_ASK_RE.test(roundText)
      ) {
        permissionNudges++;
        messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));
        messages.push(
          vscode.LanguageModelChatMessage.User(
            'Yes — proceed. You already have authorization to make this change; this run does not ' +
              'pause for per-step approval. Call the edit tool(s) now instead of asking again.',
          ),
        );
        const nudgeTokens =
          (await countTokensSafe(model, messages[messages.length - 2], token)) +
          (await countTokensSafe(model, messages[messages.length - 1], token));
        tokensUsed += nudgeTokens;
        cumulativeContext += nudgeTokens;
        out.markdown('\n\n_(proceeding automatically — this run doesn\'t pause for per-step approval)_\n');
        continue;
      }
      break; // model produced its final answer
    }
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
          editToolCalled = true;
          const label = `✎ ${call.name} ${typeof input.path === 'string' ? input.path : ''}`;
          out.progress(label);
          out.toolActivity?.({ tool: call.name, kind: 'edit', label, input });
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
          const label = labelFor(call);
          out.progress(label);
          out.toolActivity?.({ tool: call.name, kind: 'lookup', label, input });
          try {
            const r = await vscode.lm.invokeTool(call.name, { input, toolInvocationToken }, token);
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
        out.markdown(part);
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
  prompt: string,
  toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
  out: AgentOutput,
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken,
): Promise<string> {
  out.progress('Searching the local index…');
  let contextText = '';
  try {
    const r = await vscode.lm.invokeTool(
      `${FOUNDRY_TOOL_PREFIX}semanticSearch`,
      { input: { query: prompt, context: true }, toolInvocationToken },
      token,
    );
    contextText = toolText(r);
  } catch {
    /* leave context empty — the model will answer without grounding */
  }
  const messages = [
    vscode.LanguageModelChatMessage.User(CHAT_PREAMBLE),
    vscode.LanguageModelChatMessage.User(
      `Workspace search results:\n\n${contextText || '(no results)'}\n\n` +
        `Question: ${prompt}\n\nAnswer using the results above. Cite files as path:line.`,
    ),
  ];
  const response = await model.sendRequest(messages, {}, token);
  let text = '';
  for await (const part of response.text) {
    out.markdown(part);
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

// semantic_search's own default (detail:'compact') is deliberately token-lean —
// forcing detail:'full' here would 4-6x every call regardless of whether the model
// actually needed bodies, and that inflated result then re-sends on every subsequent
// round too. Leave `detail`/`expand` alone entirely (the model already knows what it
// wants once it sets either). Only bound topK — a floor so an unusually small
// request still gives the model enough (cheap, compact) candidates to reason over,
// and a ceiling against a runaway request.
const MIN_SEMANTIC_SEARCH_TOPK = 8;
const MAX_SEMANTIC_SEARCH_TOPK = 10;
function boostSearchInput(name: string, input: object): Record<string, unknown> {
  const obj = input as Record<string, unknown>;
  if (name !== `${FOUNDRY_TOOL_PREFIX}semanticSearch`) return obj;
  if ('expand' in obj) return obj; // model already named which hits it wants bodies for
  const requested = Number(obj.topK);
  const topK =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.max(requested, MIN_SEMANTIC_SEARCH_TOPK), MAX_SEMANTIC_SEARCH_TOPK)
      : MIN_SEMANTIC_SEARCH_TOPK;
  return { ...obj, topK };
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
export function emitUnbuiltIndexHint(out: AgentOutput): void {
  out.markdown(
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
