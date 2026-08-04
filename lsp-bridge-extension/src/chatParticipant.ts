import * as vscode from 'vscode';
import type { SearchClient } from './searchClient';
import { FOUNDRY_TOOL_PREFIX } from './languageModelTools';

// The @codebase chat participant. It answers questions about THIS workspace by
// letting the model drive our local MCP tools (registered as Language Model
// tools) — agentic tool-calling, no separate router. The index stays local;
// only retrieved snippets reach the model, exactly like any Copilot chat. This
// is the code-aware replacement for a disabled cloud workspace index.

const PARTICIPANT_ID = 'foundry.codebase';
const MAX_TOOL_ROUNDS = 5;

const BASE_PREAMBLE = [
  'You are @codebase, a coding assistant for the user’s CURRENT VS Code workspace.',
  'A local, offline code index is available through the foundry_* tools',
  '(foundry_semanticSearch, foundry_searchSymbol, foundry_traceCalls,',
  'foundry_showExecutionFlow, foundry_findUsages, foundry_findImplementations,',
  'foundry_architectureOverview, foundry_repoOverview).',
  'ALWAYS ground answers in this workspace by calling these tools before answering —',
  'do not guess from memory. Prefer foundry_semanticSearch to locate code by meaning,',
  'then foundry_traceCalls / foundry_findUsages to follow relationships.',
  'Cite concrete files as `path:line`. Be concise and specific to this codebase.',
].join(' ');

const PLAN_PREAMBLE = [
  BASE_PREAMBLE,
  '\n\nThe user wants an IMPLEMENTATION PLAN for a change, not prose.',
  'First gather context with the foundry_* tools (search for the relevant code,',
  'check architecture and existing usages/impact). Then output a plan in this shape:',
  '\n\n## Plan\n**Context:** one or two lines on the current state.\n',
  '**Files to change:** a bullet per file as `path` — what changes and why.\n',
  '**Steps:** a numbered, ordered list of concrete edits.\n',
  '**Verify:** how to test it (commands/tests).\n',
  'Do NOT write the full code or edit files — propose the plan only, grounded in real files.',
].join(' ');

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
        return await renderTool(client, stream, 'architecture_overview', {});
      }

      const preamble = request.command === 'plan' ? PLAN_PREAMBLE : BASE_PREAMBLE;
      return await runAgentic(request, chatContext, stream, token, preamble, client, output);
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
  const usedTools = new Set<string>();
  const refs = new Set<string>();
  let answered = false; // did the model stream any answer text?
  let endedMidTools = false; // did we exit the loop while still calling tools?

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (token.isCancellationRequested) return {};

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
    let roundTextLen = 0;
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        stream.markdown(part.value);
        answered = answered || part.value.trim().length > 0;
        roundTextLen += part.value.length;
        assistantParts.push(part);
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push(part);
        assistantParts.push(part);
      }
    }
    output.appendLine(
      `[chat] round ${round}: ${toolCalls.length} tool call(s), ${roundTextLen} chars text`,
    );

    if (toolCalls.length === 0) break; // Model produced its final answer.
    endedMidTools = true;

    messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

    const resultParts: vscode.LanguageModelToolResultPart[] = [];
    for (const call of toolCalls) {
      if (token.isCancellationRequested) return {};
      usedTools.add(call.name);
      stream.progress(labelFor(call));
      let result: vscode.LanguageModelToolResult;
      try {
        result = await vscode.lm.invokeTool(
          call.name,
          { input: call.input, toolInvocationToken: request.toolInvocationToken },
          token,
        );
      } catch (err) {
        result = new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Tool ${call.name} failed: ${String(err)}`),
        ]);
      }
      collectRefs(result, refs);
      resultParts.push(new vscode.LanguageModelToolResultPart(call.callId, result.content));
    }
    messages.push(vscode.LanguageModelChatMessage.User(resultParts));
  }

  // The model may have spent all its rounds calling tools without ever
  // synthesizing (or produced no text at all). Force one final, tool-free pass
  // so the user always gets a written answer grounded in the tool results.
  if ((endedMidTools || !answered) && !token.isCancellationRequested) {
    try {
      const finalResp = await model.sendRequest(
        [
          ...messages,
          vscode.LanguageModelChatMessage.User(
            'Now answer the original question directly, using the tool results above. ' +
              'Cite concrete files as `path:line`. Do not call any more tools.',
          ),
        ],
        {},
        token,
      );
      for await (const part of finalResp.text) {
        stream.markdown(part);
        answered = answered || part.trim().length > 0;
      }
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
    return {};
  }
  if (usedTools.size > 0) {
    const names = [...usedTools].map((n) => n.replace(FOUNDRY_TOOL_PREFIX, '')).join(', ');
    stream.markdown(`\n\n---\n_Grounded via the local index: ${names}._`);
  }
  return {};
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
  const response = await model.sendRequest(messages, {}, token);
  for await (const part of response.text) {
    stream.markdown(part);
  }
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
