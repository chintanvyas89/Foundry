import * as vscode from 'vscode';
import { ExecutionService } from '../executor/executionService';
import {
  runAgent,
  composePreamble,
  PREAMBLE_SEGMENTS,
  emitUnbuiltIndexHint,
} from '../executor/planAgent';
import type { AgentOutput } from '../executor/agentOutput';
import { PanelSession } from './sessionState';

// The Foundry agent panel — a custom webview that owns the whole agent session
// instead of renting VS Code's chat UI.
//
// Why this exists: everything past plain markdown had to be custom-built for
// the chat participant anyway (edit application, checkpoints, diff review, run
// state), while ChatRequestHandler's turn model actively fought the rest — no
// mid-run interaction, no persistent plan surface, buttons that only fire
// across turn boundaries. Owning the surface removes those constraints rather
// than working around them.
//
// The model is reached WITHOUT a chat request: vscode.lm.selectChatModels() +
// LanguageModelChat.sendRequest() are documented to work standalone (it's the
// example in selectChatModels' own doc comment), and lm.invokeTool() explicitly
// supports being called "globally by any extension in any custom flow" with
// toolInvocationToken: undefined. Two constraints apply and both are satisfied
// here: sendRequest must follow a user action (the user pressed Send), and the
// first call raises a one-time consent prompt, which is why NoPermissions gets
// its own rendered state rather than surfacing as a raw error.

export class FoundryPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'foundry.agentPanel';

  private view?: vscode.WebviewView;
  private session = new PanelSession();
  private service?: ExecutionService;
  private running?: vscode.CancellationTokenSource;
  private selectedModelId?: string;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case 'ready':
          // The view was (re)created — repaint from host state, which is why
          // collapsing the panel mid-run doesn't lose the conversation.
          this.post({ type: 'snapshot', ...this.session.snapshot(!!this.running) });
          await this.publishModels();
          break;
        case 'send':
          await this.handleSend(String(msg.text ?? ''));
          break;
        case 'cancel':
          this.running?.cancel();
          break;
        case 'selectModel':
          this.selectedModelId = String(msg.modelId ?? '') || undefined;
          break;
        case 'open':
          await openFile(String(msg.file ?? ''), Number(msg.line ?? 0));
          break;
        case 'newSession':
          this.resetSession();
          break;
      }
    });
  }

  // --- model access -------------------------------------------------------

  private async publishModels(): Promise<void> {
    const models = await vscode.lm.selectChatModels();
    if (this.selectedModelId && !models.some((m) => m.id === this.selectedModelId)) {
      this.selectedModelId = undefined; // previously chosen model went away
    }
    this.post({
      type: 'models',
      models: models.map((m) => ({ id: m.id, label: `${m.name} (${m.vendor})` })),
      selected: this.selectedModelId ?? models[0]?.id,
    });
  }

  private async resolveModel(): Promise<vscode.LanguageModelChat | undefined> {
    const models = await vscode.lm.selectChatModels();
    if (models.length === 0) return undefined;
    return models.find((m) => m.id === this.selectedModelId) ?? models[0];
  }

  // --- the run ------------------------------------------------------------

  private async handleSend(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt || this.running) return;

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      this.pushNotice('Open a folder in VS Code first — Foundry works against a workspace.');
      return;
    }

    const model = await this.resolveModel();
    if (!model) {
      this.pushNotice(
        'No language model is available. Sign in to GitHub Copilot (or another ' +
          'provider that exposes chat models to extensions), then press Send again.',
      );
      return;
    }

    // One preamble per session, not per send: this conversation is continuous,
    // so re-seeding would duplicate it in the context on every message.
    //
    // Phase 1 runs the same single autonomous pass the chat participant does,
    // so it takes the same segments. Segments are listed explicitly rather than
    // spread from the object so the composition is a deliberate choice here,
    // not an accident of key order — the two-phase split replaces this list.
    this.session.seed(
      composePreamble(
        PREAMBLE_SEGMENTS.identity,
        PREAMBLE_SEGMENTS.intentRouting,
        PREAMBLE_SEGMENTS.editRules,
        PREAMBLE_SEGMENTS.lookupRouting,
        PREAMBLE_SEGMENTS.cite,
      ),
    );
    this.pushEntry(this.session.addUser(prompt), true);

    // One ExecutionService per session so Keep/Undo spans the whole session's
    // edits, not just the most recent send.
    this.service ??= new ExecutionService(workspaceRoot);

    const cts = new vscode.CancellationTokenSource();
    this.running = cts;
    this.post({ type: 'running', running: true });

    const out: AgentOutput = {
      markdown: (value) => {
        const { entry, isNew } = this.session.appendAssistant(value);
        // Deltas rather than whole-entry repaints so a long answer doesn't
        // re-post its full text on every streamed chunk.
        this.post(
          isNew
            ? { type: 'entry', entry, append: true }
            : { type: 'delta', id: entry.id, text: value },
        );
      },
      progress: (value) => this.post({ type: 'progress', text: value }),
      toolActivity: (activity) => {
        const { entry, isNew } = this.session.addTool(activity);
        this.post(isNew ? { type: 'entry', entry, append: true } : { type: 'entry', entry });
      },
    };

    try {
      const result = await runAgent({
        model,
        prompt,
        // Outside a chat request there is no invocation token; the documented
        // value for tools invoked from any other flow.
        toolInvocationToken: undefined,
        out,
        token: cts.token,
        service: this.service,
        workspaceRoot,
        messages: this.session.messages,
      });

      if (result.sawUnbuiltIndex) emitUnbuiltIndexHint(out);
      this.post({
        type: 'runFinished',
        status: result.status,
        reason: result.reason,
        changedFiles: result.changedFiles,
        usedTools: result.usedTools,
        tokensUsed: result.tokensUsed,
      });
    } catch (err) {
      this.pushNotice(describeModelError(err));
    } finally {
      this.running = undefined;
      cts.dispose();
      this.post({ type: 'running', running: false });
      this.post({ type: 'progress', text: '' });
    }
  }

  private resetSession(): void {
    if (this.running) return;
    this.session = new PanelSession();
    this.service = undefined;
    this.post({ type: 'snapshot', ...this.session.snapshot(false) });
  }

  // --- plumbing -----------------------------------------------------------

  private pushNotice(text: string): void {
    this.pushEntry(this.session.addNotice(text), true);
  }

  private pushEntry(entry: unknown, append: boolean): void {
    this.post({ type: 'entry', entry, append });
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const css = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'panel.js'));
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${css}" />
</head>
<body>
  <header class="bar">
    <select id="model" title="Language model"></select>
    <button id="new" class="ghost" title="Start a new session">New</button>
  </header>
  <main id="transcript" class="transcript">
    <div class="empty">
      Ask about this codebase, or describe a change to make.
      <span class="muted">Grounded in the local, offline index — nothing leaves your machine except the model request.</span>
    </div>
  </main>
  <div id="progress" class="progress"></div>
  <footer class="composer">
    <textarea id="input" rows="2" placeholder="Ask Foundry…  (Enter to send, Shift+Enter for a newline)"></textarea>
    <button id="send" class="primary">Send</button>
    <button id="stop" class="danger" hidden>Stop</button>
  </footer>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

async function openFile(file: string, line: number): Promise<void> {
  if (!file) return;
  // Citations come back as the model wrote them — usually workspace-relative,
  // occasionally absolute — so resolve against the workspace before opening.
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  const isAbsolute = file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file);
  const uri = isAbsolute || !root ? vscode.Uri.file(file) : vscode.Uri.joinPath(root, file);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line > 0) {
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
  } catch {
    /* file may have moved since the tool reported it — not worth interrupting for */
  }
}

// The one-time consent prompt is the expected first-run path, so it gets a real
// explanation instead of a raw error string the user can't act on.
function describeModelError(err: unknown): string {
  if (err instanceof vscode.LanguageModelError) {
    if (err.code === vscode.LanguageModelError.NoPermissions.name) {
      return 'Foundry needs your permission to use the language model. Press Send again and choose **Allow**.';
    }
    if (err.code === vscode.LanguageModelError.Blocked.name) {
      return 'The model declined this request. Try rephrasing it.';
    }
    return `Language model error: ${err.message}`;
  }
  return `Run failed: ${err instanceof Error ? err.message : String(err)}`;
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
