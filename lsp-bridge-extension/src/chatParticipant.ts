import * as vscode from 'vscode';
import type { SearchClient } from './searchClient';
import { FOUNDRY_TOOL_PREFIX } from './languageModelTools';
import { moduleGraphMermaid, callGraphMermaid, type ModuleNode, type FlowNodeLite } from './mermaid';
import { gatherPlanContext, PLAN_PREAMBLE, head, type SearchHit } from './planContext';

// The @codebase chat participant. It answers questions about THIS workspace by
// letting the model drive our local MCP tools (registered as Language Model
// tools) — agentic tool-calling, no separate router. The index stays local;
// only retrieved snippets reach the model, exactly like any Copilot chat. This
// is the code-aware replacement for a disabled cloud workspace index.

const PARTICIPANT_ID = 'foundry.codebase';
// Max agentic tool-calling rounds before we force a final answer. @codebase
// drives cheap LOCAL tools and costs far less Copilot credit than plain Copilot,
// so we favour giving the model room to investigate over capping rounds early —
// quality first, since credit isn't the constraint here.
const MAX_TOOL_ROUNDS = 8;

const BASE_PREAMBLE = [
  'You are @codebase, a coding assistant for the user’s CURRENT VS Code workspace.',
  'A local, offline code index is available through the foundry_* tools:',
  'foundry_semanticSearch, foundry_searchSymbol, foundry_traceCalls,',
  'foundry_showExecutionFlow, foundry_findUsages, foundry_findImplementations,',
  'foundry_architectureOverview, foundry_repoOverview, foundry_readFile,',
  'foundry_listDirectory, foundry_projectStandards, foundry_searchConfig.',
  'ALWAYS ground answers in this workspace by calling these tools before answering —',
  'never guess from memory.',
  '\n\nChoosing a tool (this matters — pick by what the user gave you):',
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
  'foundry_findUsages. To iterate a',
  'search, prefer mode:"refine"/"expand" or pinResults (cheap — reuses results). Re-run',
  'a fresh semanticSearch only for a genuinely different question, or when the first',
  'pass clearly missed — not to reword the same intent.',
  '\n\nCite concrete files as `path:line`. Be specific to this codebase.',
].join(' ');

// Local, best-effort token/request accounting. VS Code does NOT expose the
// actual Copilot credit / premium-request cost to extensions, so we count what
// we can: how many model requests we made (the real cost driver) and an
// estimate of input/output tokens via the model's own tokenizer.
interface Usage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

function newUsage(): Usage {
  return { requests: 0, inputTokens: 0, outputTokens: 0 };
}

// Counts one model request and estimates its input tokens. Never throws — token
// counting is best-effort and must not break the answer.
async function countInput(
  model: vscode.LanguageModelChat,
  messages: vscode.LanguageModelChatMessage[],
  usage: Usage,
): Promise<void> {
  usage.requests += 1;
  try {
    let total = 0;
    for (const m of messages) total += await model.countTokens(m);
    usage.inputTokens += total;
  } catch {
    /* tokenizer unavailable — leave the estimate as-is */
  }
}

async function countOutput(
  model: vscode.LanguageModelChat,
  text: string,
  usage: Usage,
): Promise<void> {
  if (!text) return;
  try {
    usage.outputTokens += await model.countTokens(text);
  } catch {
    /* best effort */
  }
}

function renderUsage(stream: vscode.ChatResponseStream, usage: Usage): void {
  if (usage.requests === 0) return;
  if (vscode.workspace.getConfiguration('sweSearch').get<boolean>('showUsage') === false) return;
  const n = (x: number) => x.toLocaleString();
  const reqs = `${usage.requests} model request${usage.requests === 1 ? '' : 's'}`;
  stream.markdown(
    `\n\n_Usage (estimated): ${reqs} · ~${n(usage.inputTokens)} in / ~${n(usage.outputTokens)} out tokens. ` +
      'Exact Copilot credits aren’t exposed to extensions._',
  );
}

export function registerChatParticipant(
  context: vscode.ExtensionContext,
  client: SearchClient,
  output: vscode.OutputChannel,
): void {
  if (typeof vscode.chat?.createChatParticipant !== 'function') {
    output.appendLine('[chat] Chat participant API unavailable — skipping @codebase.');
    return;
  }

  const handler: vscode.ChatRequestHandler = async (request, chatContext, stream, token) => {
    if (!serverConfigured()) {
      stream.markdown(
        'Set **`sweSearch.serverEntry`** to the absolute path of ' +
          '`local-semantic-search-mcp/dist/index.js`, then try again — that’s the local ' +
          'index @codebase reads from.',
      );
      return {};
    }

    try {
      // Deterministic, LLM-free slash commands for quick orientation.
      if (request.command === 'index') {
        return await renderTool(client, stream, 'repo_overview', {});
      }
      if (request.command === 'arch') {
        return await runArch(client, stream);
      }
      if (request.command === 'graph') {
        return await runGraph(request, client, stream, output);
      }

      if (request.command === 'plan') {
        stream.progress('Gathering workspace context for planning…');
        const { seed, target } = await gatherPlanContext(client, request.prompt, output);
        return await runPlan(request, stream, token, seed, target, client, output);
      }
      return await runAgentic(request, chatContext, stream, token, BASE_PREAMBLE, client, output);
    } catch (err) {
      if (err instanceof vscode.CancellationError) return {};
      const m = err instanceof Error ? err.message : String(err);
      output.appendLine(`[chat] ${m}`);
      stream.markdown(`\n\n_Something went wrong: ${m}_`);
      return { errorDetails: { message: m } };
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'search.svg');
  participant.followupProvider = {
    provideFollowups() {
      return [
        { prompt: 'Summarize the architecture', label: 'Architecture overview', command: 'arch' },
        { prompt: 'What does the local index cover?', label: 'Index status', command: 'index' },
      ];
    },
  };
  context.subscriptions.push(participant);
  output.appendLine('[chat] registered @codebase participant.');
}

function serverConfigured(): boolean {
  return ((vscode.workspace.getConfiguration('sweSearch').get<string>('serverEntry') ?? '').trim()).length > 0;
}

// Run a tool and print its text output directly (no model call).
async function renderTool(
  client: SearchClient,
  stream: vscode.ChatResponseStream,
  mcpName: string,
  args: Record<string, unknown>,
): Promise<vscode.ChatResult> {
  const { text } = await client.callTool(mcpName, args);
  stream.markdown('```\n' + (text || '(no data — is the index built?)') + '\n```');
  return {};
}

// /arch — the architecture_overview text PLUS a Mermaid module dependency graph
// built from the same call's structuredContent. Deterministic (no model call).
async function runArch(client: SearchClient, stream: vscode.ChatResponseStream): Promise<vscode.ChatResult> {
  const { text, structured } = await client.callTool('architecture_overview', {});
  stream.markdown('```\n' + (text || '(no data — is the index built?)') + '\n```');
  const modules = (structured as { modules?: ModuleNode[] } | undefined)?.modules;
  if (Array.isArray(modules) && modules.length > 0) {
    const mmd = moduleGraphMermaid(modules);
    if (mmd) stream.markdown('\n\n### Module dependency graph\n\n' + mmd);
  }
  return {};
}

// /graph <symbol> — a Mermaid call graph for a symbol (prefix "callers" to
// invert). Deterministic: resolves the symbol, walks the persisted call graph.
async function runGraph(
  request: vscode.ChatRequest,
  client: SearchClient,
  stream: vscode.ChatResponseStream,
  output: vscode.OutputChannel,
): Promise<vscode.ChatResult> {
  let arg = request.prompt.trim();
  let direction: 'callers' | 'callees' = 'callees';
  const m = /^(callers|callees)\s+(.*)$/i.exec(arg);
  if (m) {
    direction = m[1].toLowerCase() as 'callers' | 'callees';
    arg = m[2].trim();
  }
  if (!arg) {
    stream.markdown(
      'Give a symbol for a call graph — e.g. `@codebase /graph checkoutOrder` ' +
        '(or `/graph callers checkoutOrder` to invert). For the module map, use `/arch`.',
    );
    return {};
  }

  let hit: SearchHit | undefined;
  try {
    const { structured } = await client.callTool('search_symbol', { name: arg, limit: 1 });
    hit = (structured as { results?: SearchHit[] } | undefined)?.results?.[0];
  } catch (err) {
    output.appendLine(`[chat/graph] search_symbol failed: ${String(err)}`);
  }
  if (!hit?.symbol || !hit.file || !hit.startLine) {
    stream.markdown(`Couldn't find a symbol named \`${arg}\` in the index.`);
    return {};
  }

  let root: FlowNodeLite | undefined;
  try {
    const { structured } = await client.callTool('show_execution_flow', {
      file: hit.file,
      symbol: hit.symbol,
      line: hit.startLine,
      direction,
      depth: 3,
    });
    root = (structured as { root?: FlowNodeLite } | undefined)?.root;
  } catch (err) {
    output.appendLine(`[chat/graph] show_execution_flow failed: ${String(err)}`);
  }
  if (!root?.children || root.children.length === 0) {
    stream.markdown(
      `\`${hit.symbol}\` has no ${direction} in the call graph — build it with ` +
        '`SWE_BUILD_GRAPH=1` (or `SWE_BUILD_ALL=1`) if the graph is empty.',
    );
    return {};
  }
  stream.markdown(
    `### Call graph — ${direction} of \`${hit.symbol}\`\n\n` + callGraphMermaid(root, direction),
  );
  return {};
}

// The agentic tool-calling loop. Exposes our foundry_* LM tools to the model and
// runs its tool calls against the local index, surfacing each as progress (the
// visible retrieval plan) and ending with a "Grounded via" trailer.
async function runAgentic(
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  preamble: string,
  client: SearchClient,
  output: vscode.OutputChannel,
): Promise<vscode.ChatResult> {
  const model = request.model;
  const tools: vscode.LanguageModelChatTool[] = vscode.lm.tools
    .filter((t) => t.name.startsWith(FOUNDRY_TOOL_PREFIX))
    .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  const messages = buildMessages(preamble, request, chatContext);
  // Unlike built-in Copilot, a third-party participant's raw model.sendRequest does
  // NOT inherit the workspace's custom instructions. Fold them in so team/project
  // conventions reach the model too — supplementary to our (authoritative) routing.
  const conventions = await loadProjectConventions();
  if (conventions) {
    messages.splice(
      1,
      0,
      vscode.LanguageModelChatMessage.User(
        'Project conventions from this workspace (supplementary context; the tool-routing ' +
          `guidance above remains authoritative):\n\n${conventions}`,
      ),
    );
  }
  const usedTools = new Set<string>();
  const seenCalls = new Set<string>(); // (tool, input) already run this turn — skip repeats
  const refs = new Set<string>();
  const usage = newUsage();
  let answered = false; // did the model stream any answer text?
  let answerText = ''; // accumulated final answer text (for the agent-mode handoff)
  let endedMidTools = false; // did we exit the loop while still calling tools?
  let sawUnbuiltIndex = false; // a tool reported the symbol/graph/usage index isn't built

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (token.isCancellationRequested) return {};

    await countInput(model, messages, usage);
    let response: vscode.LanguageModelChatResponse;
    try {
      response = await model.sendRequest(messages, { tools }, token);
    } catch (err) {
      // Model can't do tool-calling (or tools rejected) — fall back to a single
      // grounded RAG pass so the participant still answers.
      output.appendLine(`[chat] tool request failed, falling back to RAG: ${String(err)}`);
      await runFallbackRag(request, stream, model, client, token, preamble);
      return {};
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
    await countOutput(model, roundText, usage);
    output.appendLine(
      `[chat] round ${round}: ${toolCalls.length} tool call(s), ${roundText.length} chars text`,
    );

    if (toolCalls.length === 0) break; // Model produced its final answer.
    endedMidTools = true;

    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

    const resultParts: vscode.LanguageModelToolResultPart[] = [];
    let newCalls = 0; // non-duplicate calls that actually retrieved something
    for (const call of toolCalls) {
      if (token.isCancellationRequested) return {};
      usedTools.add(call.name);

      // De-dupe: weak models often re-issue the same call. Every tool call still
      // needs a matching result part, so answer a repeat with a short pointer
      // instead of re-invoking and re-appending the full (large) result.
      const key = callKey(call.name, call.input);
      if (seenCalls.has(key)) {
        output.appendLine(`[chat] round ${round}: skipped duplicate ${call.name}`);
        resultParts.push(
          new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(
              '(Already retrieved above with the same input — reuse the earlier result; do not repeat this call.)',
            ),
          ]),
        );
        continue;
      }
      seenCalls.add(key);
      newCalls += 1;

      stream.progress(labelFor(call));
      let result: vscode.LanguageModelToolResult;
      try {
        result = await vscode.lm.invokeTool(
          call.name,
          { input: boostSearchInput(call.name, call.input), toolInvocationToken: request.toolInvocationToken },
          token,
        );
      } catch (err) {
        result = new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Tool ${call.name} failed: ${String(err)}`),
        ]);
      }
      collectRefs(result, refs);
      // Watch for tools reporting that the symbol/call-graph/usage indexes were
      // never built — the common reason a weak model spins on empty graph/usage
      // lookups. We surface a one-time fix hint at the end instead.
      if (!sawUnbuiltIndex && mentionsUnbuiltIndex(result)) sawUnbuiltIndex = true;
      // Trim before appending: results get re-sent every subsequent round, so a
      // large one inflates input tokens on every request. Give code-bearing tools
      // (search full bodies, read_file) a larger budget — that's the actual code
      // the model must reason over — and keep signature/graph tools lean.
      resultParts.push(
        new vscode.LanguageModelToolResultPart(call.callId, trimmedToolContent(result, budgetFor(call.name))),
      );
    }
    messages.push(vscode.LanguageModelChatMessage.User(resultParts));

    // If a round produced tool calls but none were new (all duplicates), the
    // model is spinning — stop looping and let the final synthesis answer,
    // instead of burning more requests on repeats.
    if (newCalls === 0) {
      output.appendLine(`[chat] round ${round}: all calls were duplicates — ending tool loop`);
      break;
    }
  }

  // The model may have spent all its rounds calling tools without ever
  // synthesizing (or produced no text at all). Force one final, tool-free pass
  // so the user always gets a written answer grounded in the tool results.
  if ((endedMidTools || !answered) && !token.isCancellationRequested) {
    try {
      const finalMessages = [
        ...messages,
        vscode.LanguageModelChatMessage.User(
          'Now answer the original question directly, using the tool results above. ' +
            'Cite concrete files as `path:line`. Do not call any more tools.',
        ),
      ];
      await countInput(model, finalMessages, usage);
      const finalResp = await model.sendRequest(finalMessages, {}, token);
      let finalText = '';
      for await (const part of finalResp.text) {
        stream.markdown(part);
        finalText += part;
        answerText += part;
        answered = answered || part.trim().length > 0;
      }
      await countOutput(model, finalText, usage);
    } catch (err) {
      output.appendLine(`[chat] final synthesis failed: ${String(err)}`);
    }
  }

  for (const file of refs) {
    stream.reference(vscode.Uri.file(file));
  }
  if (!answered) {
    stream.markdown(
      '_I gathered context from the local index but the model returned no answer. ' +
        'See the “Semantic Search” output channel — the index may be empty, or the ' +
        'selected model may not support tool calls (pick a Copilot model)._',
    );
    if (sawUnbuiltIndex) emitUnbuiltIndexHint(stream);
    renderUsage(stream, usage);
    return {};
  }
  if (usedTools.size > 0) {
    const names = [...usedTools].map((n) => n.replace(FOUNDRY_TOOL_PREFIX, '')).join(', ');
    stream.markdown(`\n\n---\n_Grounded via the local index: ${names}._`);
  }
  if (sawUnbuiltIndex) emitUnbuiltIndexHint(stream);
  // Let the user push this finding into agent mode for execution (see runPlan).
  offerImplementHandoff(stream, request.prompt, answerText);
  renderUsage(stream, usage);
  return {};
}

// Render the "⚡ Implement in agent mode" button. Clicking it invokes the
// foundry.implementPlan command (registered in extension.ts), which opens VS
// Code's built-in agent mode pre-filled with the plan. We pass BOTH the user's
// original request (their real intent/phrasing) and `content` (the derived
// plan/answer), so the agent grounds on what was actually asked — not just the
// synthesis. @codebase can't edit or run commands itself (Chat Participant API
// limitation), so this is the supported hand-off to the agent that can — and
// that agent can still call our foundry_* tools / foundry_plan for more search
// and planning mid-implementation.
function offerImplementHandoff(
  stream: vscode.ChatResponseStream,
  request: string,
  content: string,
): void {
  if (!content || content.trim().length < 40) return; // nothing substantive to hand off
  stream.button({
    command: 'foundry.implementPlan',
    title: '⚡ Implement in agent mode',
    arguments: [{ request, content }],
  });
}

// The index-status tools (repo_overview, architecture_overview, show_execution_flow,
// trace_calls/find_usages offline) say "not built" and point at SWE_BUILD_* when the
// symbol table / call graph / usages index were never built for this workspace. When
// that happens the graph/usage tools return nothing, so a weaker model keeps
// re-searching (burning tool rounds) and the answer is shallow. Detect it so we can
// tell the user how to fix it.
function mentionsUnbuiltIndex(result: vscode.LanguageModelToolResult): boolean {
  let text = '';
  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) text += part.value + '\n';
  }
  return /\bnot built\b/i.test(text) || /SWE_BUILD_/.test(text);
}

// A single, actionable notice appended once per answer when the code-intelligence
// indexes are missing on this machine. Embedding-free fix — no re-index of vectors.
function emitUnbuiltIndexHint(stream: vscode.ChatResponseStream): void {
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

// Fallback when the model doesn't support tool-calling: retrieve with
// semantic_search ourselves and ask the model to answer from those results.
async function runFallbackRag(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  model: vscode.LanguageModelChat,
  client: SearchClient,
  token: vscode.CancellationToken,
  preamble: string,
): Promise<void> {
  stream.progress('Searching the local index…');
  let contextText = '';
  try {
    const { text } = await client.callTool('semantic_search', {
      query: request.prompt,
      context: true,
    });
    contextText = text;
  } catch {
    /* leave context empty — the model will answer without grounding */
  }
  const messages = [
    vscode.LanguageModelChatMessage.User(preamble),
    vscode.LanguageModelChatMessage.User(
      `Workspace search results:\n\n${contextText || '(no results)'}\n\n` +
        `Question: ${request.prompt}\n\nAnswer using the results above. Cite files as path:line.`,
    ),
  ];
  const usage = newUsage();
  await countInput(model, messages, usage);
  const response = await model.sendRequest(messages, {}, token);
  let text = '';
  for await (const part of response.text) {
    stream.markdown(part);
    text += part;
  }
  await countOutput(model, text, usage);
  renderUsage(stream, usage);
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

function buildMessages(
  preamble: string,
  request: vscode.ChatRequest,
  chatContext: vscode.ChatContext,
): vscode.LanguageModelChatMessage[] {
  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(preamble),
  ];

  // Carry prior @codebase turns so follow-ups have context.
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

// /plan uses a two-phase flow: gather context deterministically (gatherPlanContext,
// already run by the caller), then a SINGLE tools-off synthesis call whose only
// job is to fill the plan template. Removing tool-calling from the final turn
// makes even a weaker model produce the structured plan reliably.
async function runPlan(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
  seed: string,
  target: SearchHit | null,
  client: SearchClient,
  output: vscode.OutputChannel,
): Promise<vscode.ChatResult> {
  const messages: vscode.LanguageModelChatMessage[] = [
    vscode.LanguageModelChatMessage.User(PLAN_PREAMBLE),
  ];
  if (seed && seed.trim()) {
    messages.push(vscode.LanguageModelChatMessage.User(seed));
  } else {
    stream.markdown(
      '_Note: no workspace context could be gathered (is the index built and ' +
        '`sweSearch.serverEntry` set?). Planning from the request alone._\n\n',
    );
  }
  messages.push(
    vscode.LanguageModelChatMessage.User(
      `Change requested: ${request.prompt}\n\n` +
        'Write the plan now, using exactly the sections and headers specified. ' +
        'Ground every claim in the workspace context above; do not call tools.',
    ),
  );

  const usage = newUsage();
  let answered = false;
  let planText = '';
  try {
    await countInput(request.model, messages, usage);
    const response = await request.model.sendRequest(messages, {}, token);
    for await (const part of response.text) {
      stream.markdown(part);
      planText += part;
      answered = answered || part.trim().length > 0;
    }
    await countOutput(request.model, planText, usage);
  } catch (err) {
    output.appendLine(`[chat/plan] synthesis failed: ${String(err)}`);
    stream.markdown(`\n\n_Couldn't generate the plan: ${String(err)}_`);
    return { errorDetails: { message: String(err) } };
  }
  if (!answered) {
    stream.markdown(
      '_No plan was produced — the selected model may be unavailable. See the ' +
        '“Semantic Search” output channel._',
    );
  }
  renderUsage(stream, usage);

  // Change-impact diagram (deterministic, 0 model requests) — callers of the
  // target symbol = the blast radius. Only rendered when there's a target WITH
  // callers, so it never shows an empty/low-value diagram.
  if (answered && target?.symbol && target.file && target.startLine) {
    try {
      const { structured } = await client.callTool('show_execution_flow', {
        file: target.file,
        symbol: target.symbol,
        line: target.startLine,
        direction: 'callers',
        depth: 2,
      });
      const root = (structured as { root?: FlowNodeLite } | undefined)?.root;
      if (root?.children && root.children.length > 0) {
        stream.markdown(
          `\n\n### Change impact — callers of \`${target.symbol}\`\n\n` +
            callGraphMermaid(root, 'callers'),
        );
      }
    } catch (err) {
      output.appendLine(`[chat/plan] impact diagram failed: ${String(err)}`);
    }
  }

  // Hand off to the built-in agent for execution. @codebase is read-only (the
  // Chat Participant API can't edit files/run commands), so we pass the finished
  // plan to VS Code's agent mode, which has the edit/terminal tools — and can
  // still call our foundry_* tools / foundry_plan for more search/planning.
  if (answered) offerImplementHandoff(stream, request.prompt, planText);
  return {};
}

// Max characters of a tool result kept in the message history. Results are
// re-sent to the model on every subsequent round, so this bounds input-token
// growth; the model can pull more via foundry_semanticSearch expand if needed.
const MAX_TOOL_RESULT_CHARS = 4000;
// Larger budget for tools that return actual source (semantic_search full bodies,
// read_file) — that code is what the model reasons over, so gutting it defeats the
// purpose. Still bounded, since results re-send each round.
const MAX_CODE_RESULT_CHARS = 8000;

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

// The content to append for a tool result, with its text capped so re-sending it
// each round doesn't inflate input tokens. Non-text parts (rare for our tools)
// pass through untouched when there's no text to trim.
function trimmedToolContent(
  result: vscode.LanguageModelToolResult,
  budget = MAX_TOOL_RESULT_CHARS,
): Array<vscode.LanguageModelTextPart> | vscode.LanguageModelToolResult['content'] {
  let text = '';
  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) text += part.value;
  }
  if (!text) return result.content;
  return [new vscode.LanguageModelTextPart(head(text, budget))];
}

// Code-bearing tools carry the actual source the model reasons over, so they get
// a larger slice; signature/graph/overview tools stay lean (they re-send each round).
function budgetFor(toolName: string): number {
  return toolName === `${FOUNDRY_TOOL_PREFIX}semanticSearch` ||
    toolName === `${FOUNDRY_TOOL_PREFIX}readFile`
    ? MAX_CODE_RESULT_CHARS
    : MAX_TOOL_RESULT_CHARS;
}

// Weak models often call foundry_semanticSearch and then reason over the compact
// signatures it returns by default, producing shallow answers. When the model
// hasn't asked for bodies (no expand, no explicit detail), request full bodies for
// a bounded number of hits so it always has real code to work from.
function boostSearchInput(name: string, input: object): object {
  if (name !== `${FOUNDRY_TOOL_PREFIX}semanticSearch`) return input;
  const obj = input as Record<string, unknown>;
  if ('expand' in obj || obj.detail) return input; // model already wants specific bodies
  const topK = Math.min(Number(obj.topK) || 5, 5);
  return { ...obj, detail: 'full', topK };
}

// First ~n characters (whole lines) of text, with a truncation marker.
function labelFor(call: vscode.LanguageModelToolCallPart): string {
  const info = vscode.lm.tools.find((t) => t.name === call.name);
  const base = info?.description ? shortDesc(info.description) : call.name;
  return base;
}

function shortDesc(d: string): string {
  const firstSentence = d.split(/[.\n]/)[0].trim();
  return firstSentence.length > 60 ? firstSentence.slice(0, 57) + '…' : firstSentence;
}

// Best-effort extraction of file paths from a tool result's text so we can add
// clickable references. Matches absolute paths (…/foo.ts optionally :line).
function collectRefs(result: vscode.LanguageModelToolResult, refs: Set<string>): void {
  let text = '';
  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) text += part.value + '\n';
  }
  const re = /((?:\/|[A-Za-z]:\\)[^\s():"']+\.[A-Za-z0-9]{1,6})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    refs.add(m[1]);
    if (refs.size >= 20) break;
  }
}
