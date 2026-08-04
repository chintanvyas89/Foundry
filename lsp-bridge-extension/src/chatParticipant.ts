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
  'You are @codebase, planning an implementation change for the user’s CURRENT VS',
  'Code workspace. Workspace context is provided below: an index overview, the',
  'module architecture, the project’s own docs, the MOST RELEVANT CODE WITH FULL',
  'BODIES, and the project’s build/test manifests. Base every claim on that context',
  'and the actual code — do not guess from memory. If a detail (a function’s',
  'determinants, a runtime mode) is not shown in the context, say so rather than',
  'inventing it. Use ONLY the build/test commands evidenced by the provided',
  'manifests, scripts, and test files (whatever the ecosystem — npm, pytest, go',
  'test, cargo, make, gradle, …); NEVER invent a build or test command that is not',
  'shown. Reason about the runtime/process model, config, and concurrency from the',
  'code and docs, not just individual functions.',
  '\n\nRespond with ONLY the following markdown, filling every section:',
  '\n## Plan',
  '\n**Context:** current state in 1–2 lines.',
  '\n**Assumptions & open questions:** anything inferred or needing confirmation.',
  '\n**Files to change:** a bullet per file as `path` — what changes and why.',
  '\n**Steps:** a numbered, ordered list of concrete edits.',
  '\n**Risks / staleness:** what could break or go stale — concurrency, caching,',
  'invalidation, cross-process/query-only state, re-index coupling.',
  '\n**Alternatives / existing mechanisms:** simpler options or existing features',
  'that may already cover this; say plainly if the change may be unnecessary.',
  '\n**Verify:** the exact test/build commands (from the real conventions above) and a manual check.',
  '\n\nDo NOT write the full code or edit files, and do NOT call any tools — propose',
  'the plan only, grounded in the provided context.',
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
        return await renderTool(client, stream, 'architecture_overview', {});
      }

      if (request.command === 'plan') {
        stream.progress('Gathering workspace context for planning…');
        const seed = await gatherPlanContext(client, request.prompt, output);
        return await runPlan(request, stream, token, seed, output);
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
  const seenCalls = new Set<string>(); // (tool, input) already run this turn — skip repeats
  const refs = new Set<string>();
  const usage = newUsage();
  let answered = false; // did the model stream any answer text?
  let endedMidTools = false; // did we exit the loop while still calling tools?

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
          { input: call.input, toolInvocationToken: request.toolInvocationToken },
          token,
        );
      } catch (err) {
        result = new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`Tool ${call.name} failed: ${String(err)}`),
        ]);
      }
      collectRefs(result, refs);
      // Trim before appending: results get re-sent every subsequent round, so a
      // large one inflates input tokens on every request. Cap what the model
      // needs to reason (it can call foundry_semanticSearch with expand for more).
      resultParts.push(
        new vscode.LanguageModelToolResultPart(call.callId, trimmedToolContent(result)),
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
    renderUsage(stream, usage);
    return {};
  }
  if (usedTools.size > 0) {
    const names = [...usedTools].map((n) => n.replace(FOUNDRY_TOOL_PREFIX, '')).join(', ');
    stream.markdown(`\n\n---\n_Grounded via the local index: ${names}._`);
  }
  renderUsage(stream, usage);
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
  try {
    await countInput(request.model, messages, usage);
    const response = await request.model.sendRequest(messages, {}, token);
    let text = '';
    for await (const part of response.text) {
      stream.markdown(part);
      text += part;
      answered = answered || part.trim().length > 0;
    }
    await countOutput(request.model, text, usage);
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
  return {};
}

// Assemble a rich, deterministic context pack for /plan. Everything here is
// language-agnostic: index overview, module architecture, the most relevant code
// with FULL bodies, the project's OWN docs (README/ARCHITECTURE — where any repo
// describes how it builds/runs), and its build/test manifests. All read-only, no
// project-specific assumptions — the model adapts to whatever ecosystem it finds.
async function gatherPlanContext(
  client: SearchClient,
  prompt: string,
  output: vscode.OutputChannel,
): Promise<string> {
  const parts: string[] = [];

  const add = async (label: string, mcpName: string, args: Record<string, unknown>): Promise<void> => {
    try {
      const { text } = await client.callTool(mcpName, args);
      if (text && text.trim()) parts.push(`#### ${label}\n${text.trim()}`);
    } catch (err) {
      output.appendLine(`[chat/plan] ${mcpName} failed: ${String(err)}`);
    }
  };

  await add('Index overview', 'repo_overview', {});
  await add('Architecture (modules)', 'architecture_overview', {});

  const docs = await gatherProjectDocs(output);
  if (docs) parts.push(docs);

  // FULL bodies of the most relevant code — the key upgrade over lean signatures.
  await add('Most relevant code (full bodies)', 'semantic_search', {
    query: prompt,
    detail: 'full',
    topK: 6,
    context: true,
  });

  const conventions = await gatherConventions(output);
  if (conventions) parts.push(conventions);

  if (parts.length === 0) return '';
  return (
    'Auto-gathered workspace context for planning (read before proposing changes):\n\n' +
    parts.join('\n\n')
  );
}

// Directories that never hold source worth reading — excluded from every scan.
const SCAN_EXCLUDE = '**/{node_modules,dist,build,out,target,.venv,venv,vendor,.git,bin,obj}/**';

// Pull the top of the project's own docs — README / ARCHITECTURE / CONTRIBUTING.
// Every repo, in any language, documents how it builds, runs, and is structured
// here; this is where process/runtime facts live, so the model learns them from
// the project itself rather than any hardcoded, repo-specific knowledge.
async function gatherProjectDocs(output: vscode.OutputChannel): Promise<string> {
  try {
    const uris = await vscode.workspace.findFiles(
      '**/{README.md,README.rst,README.txt,README,ARCHITECTURE.md,CONTRIBUTING.md}',
      SCAN_EXCLUDE,
      10,
    );
    // Prefer shallow (repo-root) docs, and lead with the README.
    const sorted = uris
      .map((u) => ({ uri: u, rel: vscode.workspace.asRelativePath(u) }))
      .sort((a, b) => {
        const depth = a.rel.split('/').length - b.rel.split('/').length;
        if (depth !== 0) return depth;
        const ar = /readme/i.test(a.rel) ? 0 : 1;
        const br = /readme/i.test(b.rel) ? 0 : 1;
        return ar - br;
      });
    const chosen = sorted.slice(0, 2);
    const blocks: string[] = [];
    for (const { uri, rel } of chosen) {
      try {
        const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        blocks.push(`\`${rel}\` (excerpt):\n${head(raw, 1800)}`);
      } catch {
        /* skip unreadable doc */
      }
    }
    return blocks.length ? '#### Project docs\n' + blocks.join('\n\n') : '';
  } catch (err) {
    output.appendLine(`[chat/plan] docs scan failed: ${String(err)}`);
    return '';
  }
}

// Common build/test manifest filenames across ecosystems. Their presence + a
// short excerpt tells the model the real build/test commands to use, whatever
// the language — no assumption of npm/Node.
const MANIFEST_GLOB =
  '**/{package.json,pyproject.toml,setup.cfg,setup.py,tox.ini,pytest.ini,noxfile.py,' +
  'go.mod,Cargo.toml,pom.xml,build.gradle,build.gradle.kts,build.sbt,Gemfile,' +
  'composer.json,mix.exs,Makefile,justfile,Taskfile.yml,Taskfile.yaml,CMakeLists.txt}';

// Read the workspace's real build/test conventions so the plan uses actual
// commands (npm / pytest / go test / cargo / make / …) instead of inventing one,
// plus a language-neutral sample of test-file paths to reveal the runner.
async function gatherConventions(output: vscode.OutputChannel): Promise<string> {
  const sections: string[] = [];
  const seen = new Set<string>();

  const collect = async (pattern: string): Promise<void> => {
    try {
      const uris = await vscode.workspace.findFiles(pattern, SCAN_EXCLUDE, 12);
      for (const uri of uris) {
        const rel = vscode.workspace.asRelativePath(uri);
        if (seen.has(rel) || sections.length >= 10) continue;
        seen.add(rel);
        try {
          const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
          const excerpt = manifestExcerpt(rel, raw);
          if (excerpt) sections.push(`\`${rel}\`:\n${excerpt}`);
        } catch {
          /* skip unreadable/malformed manifest */
        }
      }
    } catch (err) {
      output.appendLine(`[chat/plan] manifest scan failed (${pattern}): ${String(err)}`);
    }
  };

  await collect(MANIFEST_GLOB);
  await collect('**/*.csproj');

  // Test files — language-neutral: common test dirs, plus name patterns that
  // cover pytest (test_*.py), Go (*_test.go), JS/TS (*.test.ts), JUnit (*Test.java), etc.
  try {
    const tests = await vscode.workspace.findFiles(
      '**/{test,tests,__tests__,spec,specs,e2e}/**/*.*',
      SCAN_EXCLUDE,
      60,
    );
    const byName = await vscode.workspace.findFiles(
      '**/{test_*,*_test,*.test,*.spec,*_spec,*Test,*Tests,*Spec}.*',
      SCAN_EXCLUDE,
      60,
    );
    const names = [...tests, ...byName]
      .map((u) => vscode.workspace.asRelativePath(u))
      .filter((p) => /(^|\/)(tests?|specs?|e2e)(\/|$)|[._-](test|spec)s?\.|(^|\/)test_/i.test(p));
    const unique = [...new Set(names)].sort().slice(0, 20);
    if (unique.length) sections.push('Test files (naming / runner convention):\n  ' + unique.join('\n  '));
  } catch (err) {
    output.appendLine(`[chat/plan] test scan failed: ${String(err)}`);
  }

  return sections.length ? '#### Build / test conventions\n' + sections.join('\n\n') : '';
}

// Ecosystem-aware excerpt of a manifest: pull the build/test-relevant bit
// (package.json scripts, Makefile/Taskfile targets) or a truncated head.
function manifestExcerpt(rel: string, raw: string): string {
  const base = baseName(rel).toLowerCase();
  if (base === 'package.json') {
    try {
      const json = JSON.parse(raw) as { scripts?: Record<string, string> };
      const scripts = json.scripts ? Object.entries(json.scripts) : [];
      return scripts.length ? 'scripts:\n  ' + scripts.map(([k, v]) => `${k}: ${v}`).join('\n  ') : '(no scripts)';
    } catch {
      return head(raw, 600);
    }
  }
  if (base === 'makefile' || base === 'justfile' || base.startsWith('taskfile')) {
    const targets = raw
      .split('\n')
      .filter((l) => /^[A-Za-z0-9][\w.\/-]*:\s*(#.*)?$|^[A-Za-z0-9][\w.\/-]*:\s+[^=]/.test(l))
      .slice(0, 30);
    return targets.length ? 'targets:\n  ' + targets.map((t) => t.trim()).join('\n  ') : head(raw, 800);
  }
  return head(raw, 900);
}

function baseName(path: string): string {
  const i = path.replace(/\\/g, '/').lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

// Max characters of a tool result kept in the message history. Results are
// re-sent to the model on every subsequent round, so this bounds input-token
// growth; the model can pull more via foundry_semanticSearch expand if needed.
const MAX_TOOL_RESULT_CHARS = 4000;

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
): Array<vscode.LanguageModelTextPart> | vscode.LanguageModelToolResult['content'] {
  let text = '';
  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) text += part.value;
  }
  if (!text) return result.content;
  return [new vscode.LanguageModelTextPart(head(text, MAX_TOOL_RESULT_CHARS))];
}

// First ~n characters (whole lines) of text, with a truncation marker.
function head(text: string, n: number): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= n) return trimmed;
  const cut = trimmed.slice(0, n);
  const lastNl = cut.lastIndexOf('\n');
  return (lastNl > n * 0.5 ? cut.slice(0, lastNl) : cut) + '\n… (truncated)';
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
