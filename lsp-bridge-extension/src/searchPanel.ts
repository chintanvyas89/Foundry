import * as vscode from 'vscode';
import { SearchClient, SearchResult } from './searchClient';
import { getCallHierarchy, CallNode } from './callHierarchy';

// Sidebar webview that drives relevance-feedback search: a query box, a context
// tray (pinned results + a note) that steers the next search, and Refine/Expand
// buttons. Pinning reuses a result's stored vector server-side — no re-embedding.
export class SearchPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sweSearch.panel';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: SearchClient,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'search') {
        await this.runSearch(view.webview, msg);
      } else if (msg?.type === 'open') {
        await openAt(msg.file, msg.startLine, msg.endLine);
      } else if (msg?.type === 'trace') {
        await this.runTrace(view.webview, msg);
      }
    });
  }

  private async runSearch(
    webview: vscode.Webview,
    msg: { query?: string; note?: string; pins?: string[]; mode?: 'find' | 'refine' | 'expand' },
  ): Promise<void> {
    const query = (msg.query ?? '').trim();
    if (!query) {
      webview.postMessage({ type: 'error', message: 'Enter something to search for.' });
      return;
    }
    const topK = vscode.workspace.getConfiguration('sweSearch').get<number>('topK') ?? 8;

    webview.postMessage({ type: 'busy', busy: true });
    try {
      const results = await this.client.search({
        query,
        topK,
        pins: msg.pins,
        note: msg.note,
        mode: msg.mode ?? 'find',
      });
      webview.postMessage({
        type: 'results',
        mode: msg.mode ?? 'find',
        results: results.map(toPayload),
      });
    } catch (err) {
      webview.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      webview.postMessage({ type: 'busy', busy: false });
    }
  }

  private async runTrace(
    webview: vscode.Webview,
    msg: { file?: string; line?: number; symbol?: string },
  ): Promise<void> {
    if (!msg.file || !msg.line) return;
    webview.postMessage({ type: 'busy', busy: true });
    try {
      const calls = await getCallHierarchy(msg.file, msg.line, msg.symbol);
      webview.postMessage({
        type: 'calls',
        calls: {
          root: calls.root ? withRel(calls.root) : null,
          outgoing: calls.outgoing.map(withRel),
          incoming: calls.incoming.map(withRel),
        },
      });
    } catch (err) {
      webview.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      webview.postMessage({ type: 'busy', busy: false });
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body { padding: 8px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
  input, textarea, button { font-family: inherit; font-size: inherit; color: var(--vscode-input-foreground); }
  .row { display: flex; gap: 6px; margin-bottom: 8px; }
  input[type=text], textarea {
    width: 100%; box-sizing: border-box; padding: 5px 8px; border-radius: 4px;
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent);
  }
  textarea { resize: vertical; min-height: 30px; }
  button {
    padding: 5px 10px; border-radius: 4px; cursor: pointer; white-space: nowrap;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border: none;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .tray { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; margin-bottom: 10px; }
  .tray-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin-bottom: 6px; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px; border-radius: 10px; font-size: 12px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .chip .x { cursor: pointer; opacity: .8; }
  .chip .x:hover { opacity: 1; }
  .muted { opacity: .6; font-size: 12px; }
  .status { min-height: 16px; font-size: 12px; opacity: .8; margin-bottom: 6px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 9px; margin-bottom: 7px; }
  .card:hover { border-color: var(--vscode-focusBorder); }
  .card-head { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
  .sym { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sym:hover { text-decoration: underline; }
  .pin { font-size: 11px; padding: 2px 7px; }
  .pin.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .loc { font-size: 11px; color: var(--vscode-textLink-foreground); margin: 2px 0 6px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .snippet { margin: 0 0 7px; padding: 6px 8px; border-radius: 6px; cursor: pointer;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
  .bar { display: flex; align-items: center; gap: 7px; }
  .track { flex: 1; height: 4px; border-radius: 3px; background: var(--vscode-input-background); overflow: hidden; }
  .fill { height: 100%; background: var(--vscode-progressBar-background); }
  .score { font-size: 11px; opacity: .8; font-variant-numeric: tabular-nums; }
  .btns { display: flex; gap: 5px; flex-shrink: 0; }
  .hidden { display: none; }
  .trace-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .trace-title { font-family: var(--vscode-editor-font-family, monospace); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sec { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin: 12px 0 5px; }
  .cnode { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 5px 7px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; margin-bottom: 5px; }
  .cnode:hover { border-color: var(--vscode-focusBorder); }
  .cname { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cloc { color: var(--vscode-textLink-foreground); opacity: .8; }
</style>
</head>
<body>
  <div class="row">
    <input type="text" id="query" placeholder="Search by meaning…" />
    <button class="primary" id="go">Search</button>
  </div>

  <div class="tray">
    <div class="tray-label">Context steering the search</div>
    <div class="chips" id="pins"></div>
    <textarea id="note" placeholder="Add a note to refine, e.g. the discount rules"></textarea>
    <div class="row" style="margin: 8px 0 0;">
      <button id="refine">Refine ▸</button>
      <button id="expand">◂ Expand</button>
      <button id="clear">Clear</button>
    </div>
  </div>

  <div class="status" id="status">Type a query and press Enter.</div>
  <div id="results"></div>
  <div id="trace" class="hidden"></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const state = { pins: [], results: [] };

  function renderPins() {
    const note = $('note').value.trim();
    if (state.pins.length === 0 && !note) {
      $('pins').innerHTML = '<span class="muted">Nothing pinned — pin results below to steer the next search.</span>';
      return;
    }
    $('pins').innerHTML = state.pins
      .map((p, i) => '<span class="chip">' + escapeHtml(p.label) + ' <span class="x" data-i="' + i + '">✕</span></span>')
      .join('');
    document.querySelectorAll('.chip .x').forEach((el) => {
      el.addEventListener('click', () => { state.pins.splice(Number(el.dataset.i), 1); renderPins(); renderResults(); });
    });
  }

  function search(mode) {
    const query = $('query').value.trim();
    if (!query) { $('status').textContent = 'Enter something to search for.'; return; }
    vscode.postMessage({
      type: 'search', mode, query,
      note: $('note').value,
      pins: state.pins.map((p) => p.id),
    });
  }

  function renderResults() {
    const el = $('results');
    if (state.results.length === 0) { el.innerHTML = ''; return; }
    el.innerHTML = state.results.map((r, i) => {
      const pinned = state.pins.some((p) => p.id === r.id);
      const name = r.symbol ? r.symbol : r.rel.split('/').pop();
      const pct = Math.round(Math.max(0, Math.min(1, r.score)) * 100);
      return '<div class="card">' +
        '<div class="card-head">' +
          '<span class="sym" data-open="' + i + '" title="' + escapeHtml(r.rel) + '">' + escapeHtml(name) + '</span>' +
          '<span class="btns">' +
            '<button class="pin" data-trace="' + i + '" title="Trace callers and callees">Calls</button>' +
            '<button class="pin ' + (pinned ? 'on' : '') + '" data-pin="' + i + '">' + (pinned ? 'Pinned' : 'Pin') + '</button>' +
          '</span>' +
        '</div>' +
        '<div class="loc" data-open="' + i + '">' + escapeHtml(r.rel) + ':' + r.startLine + '</div>' +
        '<pre class="snippet" data-open="' + i + '">' + escapeHtml(r.snippet || '') + '</pre>' +
        '<div class="bar"><div class="track"><div class="fill" style="width:' + pct + '%"></div></div>' +
        '<span class="score">' + r.score.toFixed(3) + '</span></div>' +
      '</div>';
    }).join('');

    el.querySelectorAll('[data-open]').forEach((node) => {
      node.addEventListener('click', () => {
        const r = state.results[Number(node.dataset.open)];
        vscode.postMessage({ type: 'open', file: r.file, startLine: r.startLine, endLine: r.endLine });
      });
    });
    el.querySelectorAll('[data-pin]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = state.results[Number(btn.dataset.pin)];
        const at = state.pins.findIndex((p) => p.id === r.id);
        if (at >= 0) state.pins.splice(at, 1);
        else state.pins.push({ id: r.id, label: r.symbol || r.rel.split('/').pop() });
        renderPins(); renderResults();
      });
    });
    el.querySelectorAll('[data-trace]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const r = state.results[Number(btn.dataset.trace)];
        trace(r.file, r.startLine, r.symbol);
      });
    });
  }

  function trace(file, line, symbol) {
    $('status').textContent = 'Tracing calls…';
    vscode.postMessage({ type: 'trace', file, line, symbol });
  }

  function showResults() {
    $('trace').classList.add('hidden');
    $('results').classList.remove('hidden');
  }

  function renderTrace(calls) {
    const t = $('trace');
    const back = '<div class="trace-head"><button id="tback">← Results</button>' +
      (calls.root ? '<span class="trace-title" title="' + escapeHtml(calls.root.rel) + '">' + escapeHtml(calls.root.name) + '</span>' : '') +
      '</div>';
    if (!calls.root) {
      t.innerHTML = back + '<div class="muted">No call hierarchy here — the language server may not support it (or a language extension for this file isn\\'t installed/active).</div>';
    } else {
      t.innerHTML = back + section('Calls (outgoing)', calls.outgoing) + section('Called by (incoming)', calls.incoming);
    }
    $('results').classList.add('hidden');
    t.classList.remove('hidden');

    $('tback').addEventListener('click', showResults);
    t.querySelectorAll('.cname').forEach((el) => {
      el.addEventListener('click', () => vscode.postMessage({
        type: 'open', file: el.dataset.file, startLine: Number(el.dataset.line), endLine: Number(el.dataset.line),
      }));
    });
    t.querySelectorAll('[data-trace2]').forEach((btn) => {
      btn.addEventListener('click', () => trace(btn.dataset.file, Number(btn.dataset.line), btn.dataset.name));
    });
  }

  function section(title, nodes) {
    if (!nodes.length) return '<div class="sec">' + title + ' (0)</div><div class="muted">none</div>';
    return '<div class="sec">' + title + ' (' + nodes.length + ')</div>' + nodes.map((n) =>
      '<div class="cnode">' +
        '<span class="cname" data-file="' + escapeHtml(n.file) + '" data-line="' + n.line + '">' +
          escapeHtml(n.name) + ' <span class="cloc">' + escapeHtml(n.rel) + ':' + n.line + '</span></span>' +
        '<button class="pin" data-trace2="1" data-file="' + escapeHtml(n.file) + '" data-line="' + n.line + '" data-name="' + escapeHtml(n.name) + '">Calls</button>' +
      '</div>').join('');
  }

  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

  $('go').addEventListener('click', () => search('find'));
  $('refine').addEventListener('click', () => search('refine'));
  $('expand').addEventListener('click', () => search('expand'));
  $('clear').addEventListener('click', () => { state.pins = []; $('note').value = ''; renderPins(); renderResults(); });
  $('query').addEventListener('keydown', (e) => { if (e.key === 'Enter') search('find'); });
  $('note').addEventListener('input', renderPins);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'results') {
      state.results = m.results;
      showResults();
      const label = m.mode === 'refine' ? 'refined' : m.mode === 'expand' ? 'expanded' : 'found';
      $('status').textContent = m.results.length ? m.results.length + ' results (' + label + ')' : 'No matching code found.';
      renderResults();
    } else if (m.type === 'calls') {
      renderTrace(m.calls);
      $('status').textContent = '';
    } else if (m.type === 'busy') {
      if (m.busy) $('status').textContent = 'Searching…';
    } else if (m.type === 'error') {
      $('status').textContent = 'Error: ' + m.message;
    }
  });

  renderPins();
</script>
</body>
</html>`;
  }
}

function toPayload(r: SearchResult) {
  return {
    id: r.id,
    file: r.file,
    rel: vscode.workspace.asRelativePath(r.file),
    symbol: r.symbol,
    startLine: r.startLine,
    endLine: r.endLine,
    score: r.score,
    // A short code preview for the card. Trim to a handful of lines here so we
    // don't ship whole functions into the webview.
    snippet: firstLines(r.text, 6),
  };
}

function firstLines(text: string, n: number): string {
  const lines = text.split('\n');
  const head = lines.slice(0, n).join('\n');
  return lines.length > n ? `${head}\n…` : head;
}

function withRel(n: CallNode) {
  return { ...n, rel: vscode.workspace.asRelativePath(n.file) };
}

async function openAt(file: string, startLine: number, endLine: number): Promise<void> {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const start = new vscode.Position(Math.max(0, startLine - 1), 0);
    const end = new vscode.Position(Math.max(0, endLine - 1), 0);
    const editor = await vscode.window.showTextDocument(doc, {
      preview: true,
      selection: new vscode.Range(start, start),
    });
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Could not open ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function makeNonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}
