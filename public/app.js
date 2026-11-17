// Minimal chat client: no framework, no build step.
const $ = (s) => document.querySelector(s);
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const state = { conversationId: localStorage.getItem('conversationId') || null, busy: false };

const messagesEl = $('#messages');
const input = $('#input');
const sendBtn = $('#send');

// ---------- rendering ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Small, safe markdown: escape first, then a handful of block and inline rules. */
function renderMarkdown(md, sources = []) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const inline = (t) => t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[(\d{1,3})\]/g, (m, n) => {
      const s = byN.get(Number(n));
      return s ? `<a class="cite" href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(s.title)}">${n}</a>` : m;
    });

  const lines = escapeHtml(md).split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { out.push(`<h${Math.max(3, h[1].length + 1)}>${inline(h[2])}</h${Math.max(3, h[1].length + 1)}>`); i++; continue; }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(inline(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, '')));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${x}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s+|\s*\|)/.test(lines[i])) para.push(inline(lines[i++]));
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
    else { out.push(`<p>${inline(line)}</p>`); i++; }
  }
  return out.join('');
}

const fmtTime = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function hideEmpty() {
  const e = $('#empty');
  if (e) e.remove();
}

function addUser(text, at = Date.now()) {
  hideEmpty();
  const el = document.createElement('div');
  el.className = 'msg user';
  el.innerHTML = `<div class="bubble"></div><div class="when">${fmtTime(at)}</div>`;
  el.querySelector('.bubble').textContent = text;
  messagesEl.appendChild(el);
  scroll();
}

function addAssistant() {
  hideEmpty();
  const el = document.createElement('div');
  el.className = 'msg assistant';
  el.innerHTML = `<div class="chips"></div><div class="status" hidden></div><div class="bubble"></div><div class="sources"></div><div class="foot"></div>`;
  messagesEl.appendChild(el);
  return {
    el,
    text: '',
    sources: [],
    setStatus(t) { const s = el.querySelector('.status'); s.hidden = !t; s.textContent = t || ''; },
    addChip(label, cls = '') {
      const c = document.createElement('span');
      c.className = `chip ${cls}`;
      c.textContent = label;
      el.querySelector('.chips').appendChild(c);
    },
    render() { el.querySelector('.bubble').innerHTML = renderMarkdown(this.text, this.sources); },
    renderSources(onlyCited) {
      const list = onlyCited ? this.sources.filter((s) => this.text.includes(`[${s.n}]`)) : this.sources;
      el.querySelector('.sources').innerHTML = list.slice(0, 12).map((s) => {
        let host = s.url;
        try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch {}
        return `<a class="source" href="${escapeHtml(s.url)}" target="_blank" rel="noopener" title="${escapeHtml(s.title)}"><span class="n">${s.n}</span><span class="t">${escapeHtml(host)} · ${escapeHtml(s.title)}</span></a>`;
      }).join('');
    },
    setFoot(html) { el.querySelector('.foot').innerHTML = html; },
    error(msg) { el.querySelector('.bubble').innerHTML = `<div class="error">${escapeHtml(msg)}</div>`; },
  };
}

function scroll() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- streaming ----------

async function send(text) {
  if (state.busy || !text.trim()) return;
  state.busy = true;
  sendBtn.disabled = true;
  addUser(text);
  const a = addAssistant();
  a.setStatus('Thinking');
  const started = performance.now();
  let firstToken = null;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, conversationId: state.conversationId, tz }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const e = JSON.parse(data);
        switch (e.type) {
          case 'meta':
            if (state.conversationId !== e.conversationId) {
              state.conversationId = e.conversationId;
              localStorage.setItem('conversationId', e.conversationId);
            }
            break;
          case 'status': a.setStatus(e.text); break;
          case 'recall': a.addChip(e.label, e.found ? 'recall' : 'recall none'); break;
          case 'sources': a.sources = e.sources; a.renderSources(false); break;
          case 'delta':
            if (firstToken === null) { firstToken = performance.now() - started; a.setStatus(''); }
            a.text += e.text;
            a.render();
            scroll();
            break;
          case 'done': {
            a.setStatus('');
            a.renderSources(true);
            const total = ((performance.now() - started) / 1000).toFixed(1);
            const ft = firstToken !== null ? `first word ${(firstToken / 1000).toFixed(1)}s · ` : '';
            a.setFoot(`<span>${ft}total ${total}s</span><a href="/debug/turn/${e.turnId}" target="_blank">trace</a>`);
            break;
          }
          case 'error': a.setStatus(''); a.error(e.message); break;
        }
      }
    }
  } catch (err) {
    a.setStatus('');
    a.error(err.message || String(err));
  } finally {
    state.busy = false;
    sendBtn.disabled = false;
    loadConversations();
    input.focus();
  }
}

// ---------- history, nudges, health ----------

async function loadConversations() {
  const list = await fetch('/api/conversations').then((r) => r.json()).catch(() => []);
  const nav = $('#conversations');
  nav.innerHTML = '';
  for (const c of list) {
    const b = document.createElement('button');
    b.className = c.id === state.conversationId ? 'active' : '';
    b.innerHTML = `<span></span><span class="when">${c.last_at ? fmtTime(c.last_at) : ''}</span>`;
    b.firstChild.textContent = c.first_question || 'New conversation';
    b.onclick = () => openConversation(c.id);
    nav.appendChild(b);
  }
}

async function openConversation(id) {
  state.conversationId = id;
  localStorage.setItem('conversationId', id);
  $('#sidebar').classList.remove('open');
  messagesEl.innerHTML = '';
  const turns = await fetch(`/api/conversations/${id}`).then((r) => r.json()).catch(() => []);
  for (const t of turns) {
    if (t.role === 'user') addUser(t.content, t.createdAt);
    else {
      const a = addAssistant();
      a.text = t.content;
      a.sources = t.sources || [];
      if (t.meta?.range?.label) a.addChip(`About ${t.meta.range.label}`, 'recall');
      a.render();
      a.renderSources(true);
      a.setFoot(`<span>${fmtTime(t.createdAt)}</span><a href="/debug/turn/${t.id}" target="_blank">trace</a>`);
    }
  }
  loadConversations();
  scroll();
}

function newChat() {
  state.conversationId = null;
  localStorage.removeItem('conversationId');
  location.reload();
}

async function loadNudges() {
  const list = await fetch('/api/nudges').then((r) => r.json()).catch(() => []);
  const box = $('#nudges');
  box.hidden = !list.length;
  box.innerHTML = '';
  for (const n of list) {
    const el = document.createElement('div');
    el.className = 'nudge';
    const links = (n.sources || []).slice(0, 2).map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.title)}</a>`).join(' · ');
    el.innerHTML = `<span class="label">Changed</span><span class="body">${escapeHtml(n.summary)}${links ? `<br><small>${links}</small>` : ''}</span><button aria-label="Dismiss">×</button>`;
    el.querySelector('button').onclick = async () => {
      await fetch(`/api/nudges/${n.id}/seen`, { method: 'POST' });
      loadNudges();
    };
    box.appendChild(el);
  }
}

async function loadHealth() {
  const h = await fetch('/api/health').then((r) => r.json()).catch(() => null);
  const el = $('#health');
  if (!h) return;
  el.innerHTML = h.ok
    ? `Search: ${h.searchProviders.join(' + ')}<br>Model: ${h.models.answer}`
    : `<span class="bad">${h.problems.map(escapeHtml).join('<br>')}</span>`;
}

// ---------- wiring ----------

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = '';
  input.style.height = 'auto';
  send(text);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
});
document.querySelectorAll('.suggestions button').forEach((b) => b.addEventListener('click', () => send(b.dataset.q)));
$('#newChat').onclick = newChat;
$('#toggleSidebar').onclick = () => $('#sidebar').classList.toggle('open');

loadHealth();
loadNudges();
setInterval(loadNudges, 60_000);
if (state.conversationId) openConversation(state.conversationId); else loadConversations();
input.focus();
