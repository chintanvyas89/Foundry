// @ts-check
// Foundry agent panel — webview side.
//
// Deliberately dependency-free: the extension ships zero runtime deps, and that
// constraint applies here too, so markdown is rendered by the small escape-first
// renderer below rather than by vendoring a library. Everything the model emits
// is escaped BEFORE any markup is generated — model output is untrusted text.
//
// This side holds no authoritative state. The extension host owns the session;
// `entries` here is a render cache keyed by id, rebuilt from a snapshot whenever
// the view is recreated (collapsing the panel disposes the DOM, not the run).

(function () {
  const vscode = acquireVsCodeApi();

  const $transcript = /** @type {HTMLElement} */ (document.getElementById('transcript'));
  const $input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const $send = /** @type {HTMLButtonElement} */ (document.getElementById('send'));
  const $stop = /** @type {HTMLButtonElement} */ (document.getElementById('stop'));
  const $progress = /** @type {HTMLElement} */ (document.getElementById('progress'));
  const $model = /** @type {HTMLSelectElement} */ (document.getElementById('model'));
  const $new = /** @type {HTMLButtonElement} */ (document.getElementById('new'));

  /** @type {Map<string, {entry: any, el: HTMLElement}>} */
  const entries = new Map();
  let running = false;

  // --- messages from the host ---------------------------------------------
  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'snapshot':
        entries.clear();
        $transcript.textContent = '';
        if (!msg.entries.length) showEmpty();
        for (const entry of msg.entries) upsertEntry(entry, true);
        setRunning(msg.running);
        scrollToEnd(true);
        break;
      case 'entry':
        upsertEntry(msg.entry, !!msg.append);
        break;
      case 'delta': {
        const rec = entries.get(msg.id);
        if (rec) {
          rec.entry.text += msg.text;
          renderBody(rec);
          scrollToEnd(false);
        }
        break;
      }
      case 'running':
        setRunning(msg.running);
        break;
      case 'progress':
        $progress.textContent = msg.text || '';
        break;
      case 'models':
        renderModels(msg.models, msg.selected);
        break;
      case 'runFinished':
        renderRunFooter(msg);
        break;
    }
  });

  // --- composer ------------------------------------------------------------
  $send.addEventListener('click', send);
  $stop.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  $new.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
  $model.addEventListener('change', () =>
    vscode.postMessage({ type: 'selectModel', modelId: $model.value }),
  );

  $input.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter is a newline. Matches every chat surface the
    // user already has open next to this one.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $input.addEventListener('input', autoGrow);

  function send() {
    const text = $input.value.trim();
    if (!text || running) return;
    vscode.postMessage({ type: 'send', text });
    $input.value = '';
    autoGrow();
  }

  function autoGrow() {
    $input.style.height = 'auto';
    $input.style.height = Math.min($input.scrollHeight, 140) + 'px';
  }

  function setRunning(value) {
    running = value;
    $send.disabled = value;
    $stop.hidden = !value;
    if (!value) $progress.textContent = '';
  }

  function renderModels(models, selected) {
    $model.textContent = '';
    if (!models.length) {
      $model.appendChild(new Option('No model available — sign in to a provider', ''));
      $model.disabled = true;
      return;
    }
    $model.disabled = false;
    for (const m of models) {
      const opt = new Option(m.label, m.id);
      if (m.id === selected) opt.selected = true;
      $model.appendChild(opt);
    }
  }

  // --- transcript rendering ------------------------------------------------
  function showEmpty() {
    const div = document.createElement('div');
    div.className = 'empty';
    div.textContent = 'Ask about this codebase, or describe a change to make.';
    $transcript.appendChild(div);
  }

  function upsertEntry(entry, append) {
    const existing = entries.get(entry.id);
    if (existing) {
      existing.entry = entry;
      renderBody(existing);
      scrollToEnd(false);
      return;
    }
    const empty = $transcript.querySelector('.empty');
    if (empty) empty.remove();

    const el = document.createElement('div');
    el.className = 'entry ' + entry.kind;
    $transcript.appendChild(el);

    const rec = { entry, el };
    entries.set(entry.id, rec);
    renderBody(rec);
    scrollToEnd(append);
  }

  function renderBody(rec) {
    const { entry, el } = rec;
    if (entry.kind === 'tools') {
      el.textContent = '';
      el.appendChild(renderTools(entry.tools || []));
      return;
    }
    el.textContent = '';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (entry.kind === 'assistant' || entry.kind === 'notice') {
      bubble.innerHTML = renderMarkdown(entry.text);
      wireRefs(bubble);
    } else {
      bubble.textContent = entry.text; // user text is never interpreted
    }
    el.appendChild(bubble);
  }

  function renderTools(tools) {
    const details = document.createElement('details');
    details.className = 'tools';
    const summary = document.createElement('summary');
    summary.textContent = tools.length === 1 ? '1 tool' : `${tools.length} tools`;
    details.appendChild(summary);
    const ul = document.createElement('ul');
    for (const t of tools) {
      const li = document.createElement('li');
      li.className = t.kind;
      li.textContent = describeTool(t);
      ul.appendChild(li);
    }
    details.appendChild(ul);
    return details;
  }

  // Show the tool's most identifying argument rather than the whole input blob —
  // "semanticSearch · how is auth handled" reads; a JSON dump does not.
  function describeTool(t) {
    const name = String(t.tool || '').replace(/^foundry_/, '');
    const input = t.input || {};
    const arg =
      input.query || input.name || input.symbol || input.file || input.path || input.module || '';
    return arg ? `${name} · ${String(arg).slice(0, 80)}` : name;
  }

  function scrollToEnd(force) {
    // Only follow the stream if the user hasn't scrolled up to read something.
    const nearBottom =
      $transcript.scrollHeight - $transcript.scrollTop - $transcript.clientHeight < 120;
    if (force || nearBottom) $transcript.scrollTop = $transcript.scrollHeight;
  }

  function renderRunFooter(msg) {
    const parts = [];
    if (msg.status === 'blocked') parts.push(`⛔ Blocked: ${msg.reason || 'could not proceed'}`);
    if (msg.changedFiles?.length) {
      parts.push(`${msg.changedFiles.length} file(s) changed`);
    }
    if (msg.usedTools?.length) {
      parts.push(`grounded via ${msg.usedTools.map((t) => t.replace(/^foundry_/, '')).join(', ')}`);
    }
    if (msg.tokensUsed) parts.push(`~${fmtTokens(msg.tokensUsed)} tokens`);
    if (!parts.length) return;

    const div = document.createElement('div');
    div.className = 'entry';
    const bubble = document.createElement('div');
    bubble.className = 'muted';
    bubble.style.fontSize = '11.5px';
    bubble.textContent = parts.join(' · ');
    div.appendChild(bubble);
    $transcript.appendChild(div);
    scrollToEnd(false);
  }

  function fmtTokens(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  // --- clickable `path:line` citations -------------------------------------
  function wireRefs(root) {
    for (const a of root.querySelectorAll('a.ref')) {
      a.addEventListener('click', () => {
        vscode.postMessage({
          type: 'open',
          file: a.getAttribute('data-file'),
          line: Number(a.getAttribute('data-line') || 0),
        });
      });
    }
  }

  // --- markdown ------------------------------------------------------------
  // Escape-first, placeholder-protected: fenced blocks and inline code are
  // pulled out before any inline transform runs, so a regex for **bold** can
  // never reach inside a code sample and corrupt it.
  //
  // The placeholders use private-use code points, which cannot occur in model
  // output and which escapeHtml leaves alone, so a placeholder survives
  // escaping intact. They are written as \u escape sequences rather than pasted
  // characters so they stay visible in source instead of becoming invisible
  // bytes in the file.
  const FENCE_RE = /\uE000F(\d+)\uE001/g;
  const INLINE_RE = /\uE000I(\d+)\uE001/g;
  const LONE_FENCE_RE = /^\uE000F\d+\uE001$/;

  function renderMarkdown(src) {
    /** @type {string[]} */ const fences = [];
    /** @type {string[]} */ const codes = [];

    let text = String(src).replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code) => {
      fences.push(code);
      return `\uE000F${fences.length - 1}\uE001`;
    });

    text = escapeHtml(text);
    text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
      codes.push(code);
      return `\uE000I${codes.length - 1}\uE001`;
    });

    text = text
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    return blocks(text)
      .replace(INLINE_RE, (_m, i) => inlineCode(codes[+i]))
      .replace(FENCE_RE, (_m, i) => `<pre><code>${escapeHtml(fences[+i])}</code></pre>`);
  }

  // A citation like `src/foo.ts:42` becomes a link; anything else stays code.
  function inlineCode(raw) {
    const m = /^([\w./\\@-]+\.[A-Za-z0-9]{1,8})(?::(\d+))?$/.exec(raw);
    if (m) {
      const line = m[2] || '0';
      return `<a class="ref" data-file="${m[1]}" data-line="${line}"><code>${raw}</code></a>`;
    }
    return `<code>${raw}</code>`;
  }

  // Line-oriented block pass: headings, lists, paragraphs. Placeholders are
  // opaque single tokens by construction, so they pass through untouched.
  function blocks(text) {
    const out = [];
    let list = null; // 'ul' | 'ol' | null

    const closeList = () => {
      if (list) {
        out.push(`</${list}>`);
        list = null;
      }
    };

    for (const raw of text.split('\n')) {
      const line = raw.trimEnd();

      if (!line.trim()) {
        closeList();
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        const level = Math.min(heading[1].length + 1, 6); // demote: h1 would dwarf the panel
        out.push(`<h${level}>${heading[2]}</h${level}>`);
        continue;
      }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        if (list !== 'ul') {
          closeList();
          out.push('<ul>');
          list = 'ul';
        }
        out.push(`<li>${bullet[1]}</li>`);
        continue;
      }
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (numbered) {
        if (list !== 'ol') {
          closeList();
          out.push('<ol>');
          list = 'ol';
        }
        out.push(`<li>${numbered[1]}</li>`);
        continue;
      }
      // A standalone fenced-block placeholder must not be wrapped in <p>.
      if (LONE_FENCE_RE.test(line.trim())) {
        closeList();
        out.push(line.trim());
        continue;
      }
      closeList();
      out.push(`<p>${line}</p>`);
    }
    closeList();
    return out.join('');
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  vscode.postMessage({ type: 'ready' });
})();
