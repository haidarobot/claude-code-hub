// Claude Code Hub — a macOS-style web UI for Claude Code running on your server.
import { tr, translateDom, setLang, LANG, U, plural } from './i18n.js';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : (k === 'title' || k === 'placeholder') ? tr(String(v)) : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(tr(String(c))));
  return el;
};
const icon = (id, cls) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); if (cls) s.setAttribute('class', cls); s.innerHTML = `<use href="#i-${id}"/>`; return s; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isTouch = matchMedia('(pointer: coarse)').matches;
const narrow = () => innerWidth <= 820;

// ---------- app state ----------
const S = {
  meta: null, places: [], home: '/home', prefs: {},
  projects: [], sessionsByDir: {}, lives: {}, open: new Set(load('open', [])), showAll: new Set(),
  cur: null,             // the open session
  draftCwd: null,        // folder for a new session
  pending: [], partial: null, attach: [], tab: 'chat', usage: null,
  tools: new Map(),      // tool_use_id -> card element
  fsPath: null, gitFile: null, sendQueue: [],
};
function load(k, d) { try { return JSON.parse(localStorage.getItem('ch.' + k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem('ch.' + k, JSON.stringify(v)); } catch {} }

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}
const cfm = (s) => confirm(tr(s));
const prm = (s, d) => prompt(tr(s), d);
function toast(msg, err) { const t = $('#toast'); t.textContent = tr(msg); t.className = 'toast' + (err ? ' err' : ''); t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), err ? 5000 : 2500); }

// ---------- WebSocket ----------
let ws, wsTimer, wsReady = false;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    wsReady = true;
    ws.send(JSON.stringify({ t: 'visible', v: !document.hidden }));
    if (S.cur && !S.cur.draft) wsSend({ t: 'open', sessionId: S.cur.sessionId || S.cur.key, cwd: S.cur.cwd });
    for (const m of S.sendQueue.splice(0)) ws.send(JSON.stringify(m));
  };
  ws.onclose = () => { wsReady = false; clearTimeout(wsTimer); wsTimer = setTimeout(connect, 1500); };
  ws.onmessage = (e) => { try { onEvent(JSON.parse(e.data)); } catch (err) { console.error(err); } };
}
function wsSend(m) { if (wsReady && ws.readyState === 1) ws.send(JSON.stringify(m)); else S.sendQueue.push(m); }
document.addEventListener('visibilitychange', () => wsSend({ t: 'visible', v: !document.hidden }));

const mine = (ev) => S.cur && (ev.key === S.cur.key || (S.cur.sessionId && ev.key === S.cur.sessionId));

function onEvent(ev) {
  switch (ev.t) {
    case 'lives': S.lives = Object.fromEntries(ev.lives.map((l) => [l.sessionId || l.key, l])); updateDots(); break;
    case 'snapshot': {
      if (S.cur && !(S.cur.draft ? ev.cwd === S.cur.cwd : (ev.key === S.cur.key || ev.sessionId === S.cur.sessionId))) return;
      S.cur = { key: ev.key, sessionId: ev.sessionId, cwd: ev.cwd, live: ev.live, status: ev.status, model: ev.model || S.prefs.model || 'default', effort: ev.effort || S.prefs.effort || 'medium', mode: ev.mode || S.prefs.mode || 'default', title: ev.title, todos: ev.todos };
      S.pending = ev.pending || [];
      S.partial = ev.partial || null;
      renderMessages(ev.messages || []);
      renderStreaming();
      renderPerms(); renderStatus(); renderHeader(); renderComposerBits(); renderInspector();
      refreshSessionsFor(ev.cwd);
      break;
    }
    case 'sid':
      if (S.cur && S.cur.key === ev.from) { S.cur.key = ev.sessionId; S.cur.sessionId = ev.sessionId; save('last', { sessionId: ev.sessionId, cwd: S.cur.cwd }); refreshSessionsFor(S.cur.cwd); }
      break;
    case 'msg': if (mine(ev)) { appendMessage(ev.m, true); if (ev.m.type === 'result') onResult(ev.m); } break;
    case 'delta': if (mine(ev)) onDelta(ev); break;
    case 'state':
      if (mine(ev)) { Object.assign(S.cur, { live: ev.live, status: ev.status, model: ev.model, effort: ev.effort, mode: ev.mode, title: ev.title || S.cur.title, todos: ev.todos }); renderStatus(); renderHeader(); renderComposerBits(); }
      break;
    case 'perm': if (mine(ev)) { S.pending.push(ev.req); renderPerms(); notifyLocal('Claude minta izin', permTitle(ev.req)); } break;
    case 'permDone': if (mine(ev)) { S.pending = S.pending.filter((p) => p.id !== ev.id); renderPerms(); } break;
    case 'progress': if (mine(ev)) { const c = S.tools.get(ev.id); if (c && ev.secs) c.querySelector('.ta').dataset.secs = ` · ${Math.round(ev.secs)} dtk`; } break;
    case 'notice': if (mine(ev)) toast(ev.text); break;
    case 'ratelimit': if (ev.info?.status !== 'allowed') loadUsage(true); break;
    case 'rewound': onRewound(ev); break;
    case 'error': toast(ev.message, true); if (mine(ev) || !ev.key) { if (S.cur) S.cur.status = S.cur.live ? 'idle' : 'off'; renderStatus(); } break;
  }
}

// ---------- boot ----------
async function boot() {
  translateDom();
  connect();
  try {
    const b = await api('/api/boot');
    S.places = b.places; S.home = b.home; S.meta = b.meta; S.auth = b.auth; S.prefs = { model: 'default', effort: 'medium', mode: 'default', ...b.prefs };
    S.terminalUrl = b.terminalUrl ? b.terminalUrl.replace('{proto}', location.protocol).replace('{host}', location.hostname) : null;
    if (!S.terminalUrl) $('[data-tab=term]').hidden = true;
    const acc = b.meta?.account;
    $('#whoName').textContent = b.name || 'Claude Code Hub';
    $('#avatar').textContent = ($('#whoName').textContent[0] || 'C').toUpperCase();
    $('#whoPlan').textContent = acc?.plan ? acc.plan : tr('Belum login Claude');
  } catch (e) { toast('Gagal memuat: ' + e.message, true); }
  await loadProjects();
  const last = load('last', null);
  if (last?.sessionId && !narrow()) openSession(last.sessionId, last.cwd); else newSession(last?.cwd);
  loadUsage(); setInterval(() => loadUsage(), 5 * 60_000);
  setInterval(loadProjects, 60_000);
}

// ---------- sidebar ----------
async function loadProjects() {
  try {
    const r = await api('/api/projects');
    S.projects = r.projects; S.lives = Object.fromEntries(r.lives.map((l) => [l.sessionId || l.key, l]));
    if (!S.open.size && S.projects[0]) S.open.add(S.projects[0].path);
    await Promise.all(S.projects.filter((p) => S.open.has(p.path)).map((p) => loadSessions(p.path)));
    renderSide();
  } catch (e) { toast(e.message, true); }
}
async function loadSessions(dir) { try { S.sessionsByDir[dir] = (await api('/api/sessions?dir=' + encodeURIComponent(dir))).sessions; } catch { S.sessionsByDir[dir] = []; } }
async function refreshSessionsFor(dir) { if (!dir) return; if (!S.projects.some((p) => p.path === dir)) return loadProjects(); S.open.add(dir); await loadSessions(dir); renderSide(); }

function renderSide() {
  const q = $('#search').value.trim().toLowerCase();
  const list = $('#projList'); list.innerHTML = '';
  for (const p of S.projects) {
    const sess = (S.sessionsByDir[p.path] || []).filter((s) => !q || s.title.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    if (q && !sess.length && !p.name.toLowerCase().includes(q)) continue;
    const open = S.open.has(p.path) || !!q;
    const el = h('div', { class: 'proj' + (open ? ' open' : '') },
      h('div', { class: 'proj-head', title: p.path, onclick: async (e) => {
        if (e.target.closest('.icon-btn')) return;
        if (S.open.has(p.path)) S.open.delete(p.path); else { S.open.add(p.path); if (!S.sessionsByDir[p.path]) await loadSessions(p.path); }
        save('open', [...S.open]); renderSide();
      } }, icon('chev', 'chev'), h('span', { class: 'name' }, p.name),
        p.pinned ? h('button', { class: 'icon-btn on', title: 'Disematkan' }, icon('pin')) : null,
        h('button', { class: 'icon-btn', title: 'Sesi baru di folder ini', onclick: () => newSession(p.path) }, icon('plus')),
        h('button', { class: 'icon-btn', title: 'Lainnya', onclick: (e) => projMenu(e, p) }, icon('dots'))),
      h('div', { class: 'proj-sessions' }));
    const box = el.lastChild;
    const max = S.showAll.has(p.path) || q ? 999 : 8;
    for (const s of sess.slice(0, max)) {
      const on = S.cur && (S.cur.sessionId === s.sessionId || S.cur.key === s.sessionId);
      const st = S.lives[s.sessionId]?.status;
      box.append(h('div', { class: 'sess' + (on ? ' on' : ''), 'data-id': s.sessionId, title: s.title, onclick: () => { openSession(s.sessionId, p.path); closeSide(); }, oncontextmenu: (e) => { e.preventDefault(); sessMenu(e, s, p); } },
        h('i', { class: 'dot ' + (st || '') }), h('span', { class: 't' }, s.title), h('span', { class: 'when' }, ago(s.last))));
    }
    if (!sess.length && open && !q) box.append(h('div', { class: 'more' }, 'Belum ada sesi'));
    if (sess.length > max) box.append(h('div', { class: 'more', onclick: () => { S.showAll.add(p.path); renderSide(); } }, `Tampilkan semua (${sess.length})`));
    list.append(el);
  }
  if (!S.projects.length) list.append(h('div', { class: 'more' }, 'Belum ada proyek. Mulai sesi baru.'));
}
function updateDots() {
  for (const el of $$('.sess')) { const st = S.lives[el.dataset.id]?.status; el.querySelector('.dot').className = 'dot ' + (st || ''); }
  const waiting = Object.values(S.lives).some((l) => l.status === 'waiting');
  document.title = (waiting ? '● ' : '') + 'Claude Code';
}
function projMenu(e, p) {
  e.stopPropagation();
  showMenu(e.currentTarget, [
    { label: 'Sesi baru', action: () => newSession(p.path) },
    { label: p.pinned ? 'Lepas sematan' : 'Sematkan di atas', action: async () => { await api('/api/pins', { path: p.path, remove: p.pinned }); loadProjects(); } },
    { label: 'Buka di tab File', action: () => { S.fsPath = p.path; setTab('files'); } },
    { label: 'Salin path', action: () => copy(p.path) },
  ]);
}
function sessMenu(e, s, p) {
  const live = S.lives[s.sessionId];
  showMenu(e, [
    { label: 'Ganti nama…', action: async () => { const t = prm('Nama sesi', s.title); if (t?.trim()) { await api('/api/session/rename', { sessionId: s.sessionId, dir: p.path, title: t.trim() }); refreshSessionsFor(p.path); } } },
    live ? { label: 'Hentikan proses', action: () => wsSend({ t: 'stop', key: s.sessionId }) } : null,
    { sep: true },
    { label: 'Hapus sesi…', danger: true, action: async () => { if (!cfm(`Hapus sesi "${s.title}"? Riwayatnya tidak bisa dikembalikan.`)) return; await api('/api/session/delete', { sessionId: s.sessionId, dir: p.path }); if (S.cur?.sessionId === s.sessionId) newSession(p.path); refreshSessionsFor(p.path); } },
  ].filter(Boolean));
}

// sidebar show/hide
$('#sideOpen').onclick = () => narrow() ? document.body.classList.add('side-open') : (document.body.classList.remove('side-hidden'), save('sideHidden', false));
$('#sideClose').onclick = () => narrow() ? closeSide() : (document.body.classList.add('side-hidden'), save('sideHidden', true));
$('#sideScrim').onclick = closeSide;
function closeSide() { document.body.classList.remove('side-open'); }
if (load('sideHidden', false)) document.body.classList.add('side-hidden');
$('#search').oninput = async () => {
  if ($('#search').value.trim()) await Promise.all(S.projects.filter((p) => !S.sessionsByDir[p.path]).map((p) => loadSessions(p.path)));
  renderSide();
};
$('#refreshBtn').onclick = (e) => showMenu(e.currentTarget, [
  { label: 'Muat ulang', action: () => { loadProjects(); loadUsage(true); api('/api/meta').then((m) => { S.meta = m; }).catch(() => {}); } },
  { label: 'Bahasa', right: LANG === 'id' ? 'Indonesia' : 'English', sub: () => [
    { label: 'English', check: LANG === 'en', action: () => setLang('en') },
    { label: 'Bahasa Indonesia', check: LANG === 'id', action: () => setLang('id') }] },
  S.auth === 'password' ? { sep: true } : null,
  S.auth === 'password' ? { label: 'Keluar', action: async () => { await api('/api/logout', {}).catch(() => {}); location.href = '/login'; } } : null,
].filter(Boolean), { up: true });
$('#newBtn').onclick = () => { newSession(S.cur?.cwd); closeSide(); };

// ---------- open / new session ----------
function resetChat() { S.tools.clear(); S.pending = []; S.partial = null; $('#msgs').innerHTML = ''; renderPerms(); }
function openSession(sessionId, cwd) {
  resetChat();
  S.cur = { key: sessionId, sessionId, cwd, live: false, status: 'off', model: S.prefs.model, effort: S.prefs.effort, mode: S.prefs.mode };
  save('last', { sessionId, cwd });
  $('#empty').innerHTML = ''; $('#msgs').append(h('div', { class: 'm-note' }, 'Memuat…'));
  wsSend({ t: 'open', sessionId, cwd });
  renderHeader(); renderStatus(); renderComposerBits(); renderSide(); setTab('chat'); gitBadge();
}
function newSession(cwd) {
  resetChat();
  S.draftCwd = cwd || S.draftCwd || S.projects[0]?.path || S.home;
  S.cur = { draft: true, cwd: S.draftCwd, status: 'off', model: S.prefs.model, effort: S.prefs.effort, mode: S.prefs.mode };
  renderEmpty(); renderHeader(); renderStatus(); renderComposerBits(); renderSide(); renderInspector(); setTab('chat'); gitBadge();
  if (!isTouch) $('#input').focus();
}
function renderEmpty() {
  const e = $('#empty'); e.innerHTML = '';
  if (!S.cur?.draft) return;
  const recent = S.projects.slice(0, 6);
  const pick = (p) => { S.draftCwd = p; S.cur.cwd = p; renderEmpty(); renderHeader(); gitBadge(); if (!isTouch) $('#input').focus(); };
  e.append(
    h('div', { class: 'spark', html: '<img src="/icon.svg" width="56" height="56" alt="">' }),
    h('h2', {}, 'Mau mengerjakan apa?'),
    h('p', {}, 'Pilih folder kerja, lalu tulis permintaanmu di bawah.'),
    h('div', { class: 'recent' },
      ...recent.map((p) => h('button', { class: p.path === S.cur.cwd ? 'on' : '', onclick: () => pick(p.path) }, icon('folder'), h('div', {}, h('span', { class: 'n' }, p.name), h('span', { class: 'p' }, p.path)))),
      !recent.some((p) => p.path === S.cur.cwd) ? h('button', { class: 'on' }, icon('folder'), h('div', {}, h('span', { class: 'n' }, base(S.cur.cwd)), h('span', { class: 'p' }, S.cur.cwd))) : null,
      h('button', { onclick: () => pickFolder(S.cur.cwd).then((p) => p && pick(p)) }, icon('plus'), h('div', {}, h('span', { class: 'n' }, 'Pilih folder lain…'), h('span', { class: 'p' }, 'home, files, sites, backup')))));
}

// ---------- header ----------
function renderHeader() {
  const c = S.cur;
  $('#title').textContent = c?.draft ? tr('Sesi baru') : (c?.title || titleOf(c?.sessionId) || 'Claude Code Hub');
  $('#subtitle').textContent = c?.cwd ? tilde(c.cwd) + (S.git?.branch ? ' · ' + S.git.branch : '') : '';
}
function titleOf(id) { for (const l of Object.values(S.sessionsByDir)) { const s = l.find((x) => x.sessionId === id); if (s) return s.title; } return ''; }

// ---------- messages ----------
function renderMessages(list) {
  S.results = list.filter((m) => m.type === 'result').map((m) => m.result || {});
  $('#msgs').innerHTML = ''; $('#empty').innerHTML = ''; S.tools.clear(); lastGroup = null; lastAssist = null;
  const frag = document.createDocumentFragment();
  target = frag;
  for (const m of list) appendMessage(m, false);
  target = null;
  $('#msgs').append(frag);
  if (!list.length && S.cur && !S.cur.draft && !S.cur.live) $('#msgs').append(h('div', { class: 'm-note' }, 'Sesi kosong.'));
  scrollBottom(true);
}
let target = null, lastGroup = null, lastAssist = null;
const out = () => target || $('#msgs');

function appendMessage(m, live) {
  const stick = live && nearBottom();
  if (m.type === 'user') {
    const c = m.message?.content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : (c || []);
    const results = blocks.filter((b) => b.type === 'tool_result');
    for (const r of results) fillResult(r, m.tool_use_result);
    const texts = blocks.filter((b) => b.type === 'text').map((b) => cleanUserText(b.text)).filter(Boolean);
    const imgs = blocks.filter((b) => b.type === 'image');
    if (m.parent_tool_use_id) return;
    if (texts.length || imgs.length) {
      lastGroup = null; lastAssist = null;
      const el = h('div', { class: 'm-user', 'data-uuid': m.uuid || '' },
        imgs.length ? h('div', { class: 'imgs' }, imgs.map((i) => h('img', { src: i.source?.data ? `data:${i.source.media_type};base64,${i.source.data}` : '', alt: 'gambar' }))) : null,
        texts.length ? h('div', { class: 'bubble' }, texts.join('\n')) : null,
        h('div', { class: 'acts' },
          h('button', { class: 'icon-btn', title: 'Salin', onclick: () => copy(texts.join('\n')) }, icon('copy')),
          h('button', { class: 'icon-btn', title: 'Kembalikan file ke titik ini', onclick: () => rewind(m.uuid) }, icon('rewind'))));
      out().append(el);
      if (live && texts.length) scrollBottom(true);
    }
  } else if (m.type === 'assistant') {
    if (m.parent_tool_use_id) { subagentActivity(m); return; }
    if (live) clearStreaming();
    for (const b of m.message?.content || []) {
      if (b.type === 'text' && b.text?.trim()) { lastGroup = null; out().append(h('div', { class: 'm-text', html: md(b.text) })); }
      else if (b.type === 'thinking' && b.thinking?.trim()) {
        lastGroup = null;
        out().append(h('details', { class: 'm-think' }, h('summary', {}, icon('chev'), 'Berpikir'), h('div', { class: 'body' }, b.thinking)));
      } else if (b.type === 'tool_use') addTool(b);
    }
  } else if (m.type === 'result') {
    lastGroup = null;
    const r = m.result || {};
    const outTok = r.usage?.output_tokens || 0;
    out().append(h('div', { class: 'm-result' + (r.error ? ' err' : '') },
      [tr(r.error ? `Berhenti: ${r.error === 'error_during_execution' ? 'dihentikan' : r.error}` : 'Selesai'),
        r.duration ? dur(r.duration) : '', outTok ? tr(`${fmtNum(outTok)} token ditulis`) : ''].filter(Boolean).join('  ·  ')));
    for (const [, card] of S.tools) if (card.classList.contains('run')) card.classList.replace('run', 'ok');
  } else if (m.type === 'system' && m.note) out().append(h('div', { class: 'm-note' }, m.note));
  if (stick) scrollBottom();
}

function cleanUserText(t = '') {
  if (/^<local-command-(stdout|stderr)>/.test(t)) { const s = t.replace(/<\/?local-command-(stdout|stderr)>/g, '').trim(); return s ? `↳ ${s.slice(0, 400)}` : ''; }
  const cmd = t.match(/<command-name>(.*?)<\/command-name>/);
  if (cmd) { const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] || ''; return `${cmd[1].startsWith('/') ? '' : '/'}${cmd[1]} ${args}`.trim(); }
  if (/^<command-message>|^Caveat: The messages below/.test(t)) return '';
  return t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

// ---------- tools ----------
const VERB = { Bash: 'perintah', Edit: 'edit', MultiEdit: 'edit', Write: 'file ditulis', Read: 'file dibaca', Grep: 'pencarian', Glob: 'pencarian', WebFetch: 'halaman', WebSearch: 'pencarian web', Task: 'subagen', Agent: 'subagen', TodoWrite: 'daftar tugas', NotebookEdit: 'edit' };
function addTool(b) {
  if (!lastGroup) {
    lastGroup = h('details', { class: 'tgroup' }, h('summary', {}, icon('chev', 'chev'), h('span', { class: 'gs' })), h('div', { class: 'items' }));
    lastGroup._n = {}; out().append(lastGroup);
  }
  const card = h('div', { class: 'tool run', 'data-id': b.id },
    h('div', { class: 'th', onclick: () => card.classList.toggle('open') }, h('i', { class: 'ts' }), h('span', { class: 'tn' }, toolName(b.name)), h('span', { class: 'ta' }, toolArg(b))),
    h('div', { class: 'tb' }, toolBody(b)));
  card._tool = b;
  lastGroup.lastChild.append(card);
  const v = VERB[b.name] || 'langkah'; lastGroup._n[v] = (lastGroup._n[v] || 0) + 1;
  lastGroup.querySelector('.gs').textContent = Object.entries(lastGroup._n).map(([k, n]) => `${n} ${plural(n, k)}`).join(', ') + ` · ${toolName(b.name)} ${toolArg(b)}`.slice(0, 90);
  S.tools.set(b.id, card);
  if (b.name === 'TodoWrite' && S.cur) { S.cur.todos = b.input?.todos; renderInspector(); }
}
function toolName(n) { return n.startsWith('mcp__') ? n.split('__').slice(1).join(' › ') : n; }
function rel(p) { const c = S.cur?.cwd; return p && c && p.startsWith(c + '/') ? p.slice(c.length + 1) : tilde(p || ''); }
function toolArg(b) {
  const i = b.input || {};
  switch (b.name) {
    case 'Bash': return i.description ? `${i.command?.split('\n')[0]}` : i.command || '';
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return rel(i.file_path || i.notebook_path);
    case 'Grep': return `${i.pattern}${i.path ? ' · ' + rel(i.path) : ''}`;
    case 'Glob': return i.pattern;
    case 'WebFetch': return i.url; case 'WebSearch': return i.query;
    case 'Task': case 'Agent': return i.description || i.subagent_type || '';
    case 'ExitPlanMode': return '';
    case 'TodoWrite': { const t = i.todos || []; return `${t.filter((x) => x.status === 'completed').length}/${t.length} selesai`; }
    default: return Object.values(i).find((v) => typeof v === 'string')?.slice(0, 80) || '';
  }
}
function toolBody(b) {
  const i = b.input || {};
  switch (b.name) {
    case 'Bash': return [h('pre', {}, '$ ' + (i.command || '')), i.description ? h('div', { class: 'lbl' }, i.description) : null];
    case 'Edit': return diffEl(i.old_string || '', i.new_string || '');
    case 'MultiEdit': return (i.edits || []).map((e) => diffEl(e.old_string || '', e.new_string || ''));
    case 'Write': return diffEl('', (i.content || '').split('\n').slice(0, 400).join('\n'));
    case 'TodoWrite': return todoList(i.todos);
    case 'Task': case 'Agent': return [h('div', { class: 'lbl' }, i.subagent_type || 'subagen'), h('pre', {}, i.prompt || '')];
    case 'Read': return null;
    default: return h('pre', {}, JSON.stringify(i, null, 2));
  }
}
function fillResult(r, extra) {
  const card = S.tools.get(r.tool_use_id); if (!card) return;
  card.classList.remove('run'); card.classList.add(r.is_error ? 'err' : 'ok');
  if (r.is_error) card.classList.add('open');
  const text = typeof r.content === 'string' ? r.content : (r.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
  const name = card._tool?.name;
  if (name === 'TodoWrite' || ((name === 'Edit' || name === 'Write' || name === 'MultiEdit') && !r.is_error)) return;
  if (!text) return;
  const body = card.querySelector('.tb');
  if (name === 'Task' || name === 'Agent') body.append(h('div', { class: 'lbl' }, 'Hasil'), h('div', { class: 'm-text', html: md(text) }));
  else { const lines = text.split('\n'); body.append(h('div', { class: 'lbl' }, r.is_error ? 'Galat' : 'Keluaran'), h('pre', { class: r.is_error ? 'err' : '' }, lines.length > 300 ? lines.slice(0, 300).join('\n') + `\n… (${lines.length - 300} baris lagi)` : text)); }
}
function subagentActivity(m) {
  const card = S.tools.get(m.parent_tool_use_id); if (!card) return;
  const tu = (m.message?.content || []).find((b) => b.type === 'tool_use');
  if (tu) card.querySelector('.ta').textContent = `${card._tool.input?.description || ''} · ${tu.name} ${toolArg(tu)}`.slice(0, 120);
}
function todoList(t = []) { return h('ul', { class: 'todos' }, t.map((x) => h('li', { class: x.status }, x.status === 'in_progress' ? (x.activeForm || x.content) : x.content))); }

// simple line diff (LCS) for Edit/Write
function lineDiff(a, b) {
  const A = a ? a.split('\n') : [], B = b ? b.split('\n') : [];
  if (A.length * B.length > 250000) return [...A.map((l) => ['d', l]), ...B.map((l) => ['a', l])];
  const n = A.length, m = B.length, dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const outp = []; let i = 0, j = 0;
  while (i < n && j < m) { if (A[i] === B[j]) { outp.push([' ', A[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) outp.push(['d', A[i++]]); else outp.push(['a', B[j++]]); }
  while (i < n) outp.push(['d', A[i++]]); while (j < m) outp.push(['a', B[j++]]);
  return outp;
}
function diffEl(a, b) {
  const box = h('div', { class: 'diff' });
  for (const [k, l] of lineDiff(a, b)) box.append(h('div', { class: k === 'a' ? 'a' : k === 'd' ? 'd' : '' }, (k === 'a' ? '+ ' : k === 'd' ? '- ' : '  ') + l));
  return box;
}
function unifiedDiffEl(text) {
  const box = h('div', { class: 'diff' });
  for (const l of text.split('\n')) {
    if (/^(diff --git|index |--- |\+\+\+ )/.test(l)) continue;
    box.append(h('div', { class: l.startsWith('@@') ? 'h' : l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : '' }, l || ' '));
  }
  return box;
}

// ---------- markdown ----------
marked.setOptions({ gfm: true, breaks: false });
function md(t) {
  const html = DOMPurify.sanitize(marked.parse(t || ''), { ADD_ATTR: ['target'] });
  return html.replace(/<pre>/g, `<pre><button class="icon-btn copy" title="${tr('Salin')}" data-copy><svg><use href="#i-copy"/></svg></button>`).replace(/<a /g, '<a target="_blank" rel="noopener" ');
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) copy(b.parentElement.querySelector('code')?.textContent || ''); });

// ---------- streaming ----------
function onDelta(ev) {
  if (!S.partial) S.partial = { blocks: {} };
  const b = S.partial.blocks[ev.index] || (S.partial.blocks[ev.index] = { kind: ev.kind, text: '' });
  b.text += ev.text;
  if (!renderStreaming.raf) renderStreaming.raf = requestAnimationFrame(() => { renderStreaming.raf = 0; renderStreaming(); });
}
function renderStreaming() {
  let el = $('#streaming');
  const blocks = Object.values(S.partial?.blocks || {});
  if (!blocks.length) { el?.remove(); return; }
  const stick = nearBottom();
  if (!el) { el = h('div', { id: 'streaming', class: 'streaming' }); $('#msgs').append(el); }
  el.innerHTML = '';
  for (const b of blocks) {
    if (b.kind === 'thinking') el.append(h('details', { class: 'm-think' }, h('summary', {}, icon('chev'), 'Berpikir…'), h('div', { class: 'body' }, b.text)));
    else el.append(h('div', { class: 'm-text', html: md(b.text) + '<span class="cursor"></span>' }));
  }
  if (stick) scrollBottom();
}
function clearStreaming() { S.partial = null; $('#streaming')?.remove(); }

// ---------- permissions ----------
function permTitle(p) {
  if (p.tool === 'AskUserQuestion') return 'Claude punya pertanyaan';
  if (p.tool === 'ExitPlanMode') return 'Rencana siap ditinjau';
  const T = { Bash: 'Jalankan perintah ini?', Write: 'Buat / timpa file ini?', Edit: 'Ubah file ini?', MultiEdit: 'Ubah file ini?', NotebookEdit: 'Ubah notebook ini?', WebFetch: 'Buka halaman web ini?', WebSearch: 'Cari di web?', Read: 'Baca file di luar folder kerja?' };
  return T[p.tool] || p.title || `Izinkan ${toolName(p.tool)}?`;
}
function renderPerms() {
  const box = $('#perms'); box.innerHTML = '';
  for (const p of S.pending) box.append(permCard(p));
  renderStatus();
  if (S.pending.length) scrollBottom();
}
function permCard(p) {
  const card = h('div', { class: 'perm' });
  const answer = (a) => { wsSend({ t: 'answer', key: S.cur.key, id: p.id, ...a }); card.style.opacity = .5; card.style.pointerEvents = 'none'; };
  const i = p.input || {};
  if (p.tool === 'AskUserQuestion') {
    card.append(h('div', { class: 'ph' }, icon('chat'), 'Claude bertanya'));
    const forms = (i.questions || []).map((q, qi) => {
      const multi = !!q.multiSelect, name = 'q' + qi + p.id;
      const other = h('input', { type: 'text', placeholder: 'Jawaban lain…', style: 'width:100%;height:30px;border:.5px solid var(--hair);border-radius:7px;background:var(--bg);padding:0 9px;outline:none;margin-top:4px' });
      const el = h('div', { class: 'q' }, h('div', { class: 'qh' }, q.question),
        (q.options || []).map((o) => h('label', {}, h('input', { type: multi ? 'checkbox' : 'radio', name, value: o.label }), h('span', {}, o.label, o.description ? h('small', {}, o.description) : null))), other);
      return { q, el, other, name };
    });
    forms.forEach((f) => card.append(f.el));
    card.append(h('div', { class: 'pa' },
      h('button', { class: 'btn', onclick: () => answer({ behavior: 'deny', message: 'Pengguna melewati pertanyaan ini.' }) }, 'Lewati'),
      h('button', { class: 'btn primary', onclick: () => {
        const answers = {};
        for (const f of forms) {
          const picked = $$(`input[name="${CSS.escape(f.name)}"]:checked`, card).map((x) => x.value);
          if (f.other.value.trim()) picked.push(f.other.value.trim());
          answers[f.q.question] = picked.join(', ');
        }
        answer({ behavior: 'allow', answers });
      } }, 'Kirim jawaban')));
    return card;
  }
  if (p.tool === 'ExitPlanMode') {
    card.append(h('div', { class: 'ph' }, icon('check'), 'Rencana Claude'), h('div', { class: 'plan m-text', html: md(i.plan || '') }));
    const fb = h('input', { placeholder: 'Masukan untuk rencana (opsional)' });
    card.append(h('div', { class: 'pa' }, fb,
      h('button', { class: 'btn', onclick: () => answer({ behavior: 'deny', message: fb.value.trim() || 'Pengguna ingin tetap merencanakan. Perbaiki rencananya dulu.' }) }, 'Tetap rencanakan'),
      h('button', { class: 'btn', onclick: () => answer({ behavior: 'allow', mode: 'default' }) }, 'Setujui, tanya tiap edit'),
      h('button', { class: 'btn primary', onclick: () => answer({ behavior: 'allow', mode: 'acceptEdits' }) }, 'Setujui & jalankan')));
    return card;
  }
  card.append(h('div', { class: 'ph' }, icon('shield'), permTitle(p)));
  const isFile = p.tool === 'Edit' || p.tool === 'MultiEdit' || p.tool === 'Write';
  const desc = p.tool === 'Bash' ? i.description : (p.description || p.reason);
  if (desc && !isFile) card.append(h('div', { class: 'pd' }, desc));
  if (isFile) {
    card.append(h('div', { class: 'pd' }, rel(i.file_path)));
    card.append(p.tool === 'Write' ? diffEl('', (i.content || '').split('\n').slice(0, 200).join('\n')) : p.tool === 'Edit' ? diffEl(i.old_string || '', i.new_string || '') : h('div', {}, (i.edits || []).map((e) => diffEl(e.old_string, e.new_string))));
    card.lastChild.style.marginBottom = '10px';
  } else card.append(h('pre', {}, p.tool === 'Bash' ? '$ ' + i.command : p.blockedPath || JSON.stringify(i, null, 2)));
  const why = h('input', { placeholder: 'Alasan menolak / arahan lain (opsional)' });
  const always = (p.suggestions || []).length;
  card.append(h('div', { class: 'pa' }, why,
    h('button', { class: 'btn danger', onclick: () => answer({ behavior: 'deny', message: why.value.trim() || 'Pengguna menolak tindakan ini.', interrupt: !why.value.trim() }) }, 'Tolak'),
    always ? h('button', { class: 'btn', title: suggestText(p.suggestions), onclick: () => answer({ behavior: 'allow', always: true }) }, 'Selalu izinkan') : null,
    h('button', { class: 'btn primary', onclick: () => answer({ behavior: 'allow' }) }, 'Izinkan')));
  return card;
}
function suggestText(sug = []) {
  return sug.map((s) => s.type === 'addRules' ? s.rules.map((r) => r.toolName + (r.ruleContent ? `(${r.ruleContent})` : '')).join(', ') : s.type === 'setMode' ? `mode ${s.mode}` : s.type === 'addDirectories' ? s.directories.join(', ') : s.type).join('; ');
}

// ---------- working status ----------
function renderStatus() {
  const st = S.cur?.status;
  const running = st === 'running' || (st === 'waiting');
  $('#working').hidden = !(st === 'running' && !S.pending.length);
  const btn = $('#sendBtn');
  const hasText = $('#input').value.trim() || S.attach.length;
  btn.classList.toggle('stop', running && !hasText);
  btn.innerHTML = running && !hasText ? '<svg><use href="#i-stop"/></svg>' : '<svg><use href="#i-up"/></svg>';
  btn.title = running && !hasText ? 'Hentikan (Esc)' : 'Kirim';
  btn.disabled = !running && !hasText;
  clearInterval(renderStatus.t);
  if (st === 'running') { const t0 = renderStatus.t0 = renderStatus.t0 || Date.now(); renderStatus.t = setInterval(() => ($('#workingTime').textContent = dur(Date.now() - t0)), 1000); }
  else renderStatus.t0 = 0;
  updateDots();
}

// ---------- composer ----------
const input = $('#input');
input.addEventListener('input', () => { autosize(); renderStatus(); suggest(); });
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'; }
input.addEventListener('keydown', (e) => {
  if (!$('#pop').hidden && popKey(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch) { e.preventDefault(); submit(); }
  else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); const order = ['default', 'acceptEdits', 'plan']; setMode(order[(order.indexOf(S.cur?.mode) + 1) % order.length]); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('#menu').hidden) return hideMenu(); if (!$('#sheet').hidden) return closeSheet(); if (S.cur?.status === 'running') interrupt(); }
});
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
function submit() {
  const text = input.value.trim();
  const running = S.cur?.status === 'running' || S.cur?.status === 'waiting';
  if (!text && !S.attach.length) { if (running) interrupt(); return; }
  if (!S.cur) newSession();
  askNotifyPermission();
  const msg = { t: 'send', text, images: S.attach.map((a) => ({ media_type: a.type, data: a.data })), model: S.cur.model, effort: S.cur.effort, mode: S.cur.mode };
  if (S.cur.draft) { msg.cwd = S.cur.cwd; $('#empty').innerHTML = ''; }
  else if (S.cur.live) msg.key = S.cur.key;
  else { msg.sessionId = S.cur.sessionId; msg.cwd = S.cur.cwd; }
  wsSend(msg);
  S.cur.status = 'running'; renderStatus.t0 = Date.now();
  input.value = ''; S.attach = []; renderAttach(); autosize(); renderStatus(); hidePop();
}
function interrupt() { if (S.cur?.key) wsSend({ t: 'interrupt', key: S.cur.key }); }

// image attachments
$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
input.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/')); if (files.length) { e.preventDefault(); addFiles(files); } });
$('#composer').addEventListener('dragover', (e) => e.preventDefault());
$('#composer').addEventListener('drop', (e) => { e.preventDefault(); addFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))); });
async function addFiles(files) {
  for (const f of files.slice(0, 8)) {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) { toast('Hanya gambar PNG, JPG, GIF, atau WEBP.', true); continue; }
    const data = await shrink(f);
    S.attach.push({ type: data.type, data: data.b64, url: `data:${data.type};base64,${data.b64}` });
  }
  renderAttach(); renderStatus();
}
async function shrink(f) {
  // shrink big images (max 1600 px) to save tokens and upload faster
  const img = await createImageBitmap(f).catch(() => null);
  if (!img || (img.width <= 1600 && img.height <= 1600 && f.size < 3_500_000)) return { type: f.type, b64: await b64(f) };
  const k = 1600 / Math.max(img.width, img.height), c = document.createElement('canvas');
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.88));
  return { type: 'image/jpeg', b64: await b64(blob) };
}
function b64(blob) { return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); }); }
function renderAttach() {
  const box = $('#attach'); box.innerHTML = '';
  S.attach.forEach((a, i) => box.append(h('div', { class: 'chip' }, h('img', { src: a.url }), h('button', { type: 'button', class: 'x', onclick: () => { S.attach.splice(i, 1); renderAttach(); renderStatus(); } }, icon('x')))));
}

// suggestions for / and @
let popItems = [], popIdx = 0, popKind = null;
async function suggest() {
  const v = input.value, pos = input.selectionStart;
  const before = v.slice(0, pos);
  const slash = /^\/([\w:-]*)$/.exec(before);
  const at = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (slash) {
    const q = slash[1].toLowerCase();
    const cmds = [...(S.meta?.commands || []), { name: 'compact', description: 'Ringkas percakapan untuk menghemat konteks' }, { name: 'clear', description: 'Mulai percakapan baru' }];
    const seen = new Set();
    popItems = cmds.filter((c) => !seen.has(c.name) && seen.add(c.name) && c.name.toLowerCase().includes(q)).slice(0, 40).map((c) => ({ label: '/' + c.name, desc: c.description, insert: '/' + c.name + ' ', cmd: c.name }));
    popKind = 'slash';
  } else if (at && S.cur?.cwd) {
    const q = at[1];
    const r = await api(`/api/fs/search?cwd=${encodeURIComponent(S.cur.cwd)}&q=${encodeURIComponent(q)}`).catch(() => ({ files: [] }));
    if (input.value.slice(0, input.selectionStart) !== before) return;
    popItems = r.files.map((f) => ({ label: f, desc: '', insert: f }));
    popKind = 'at';
  } else return hidePop();
  if (!popItems.length) return hidePop();
  popIdx = 0; drawPop();
}
function drawPop() {
  const p = $('#pop'); p.hidden = false; p.innerHTML = '';
  popItems.forEach((it, i) => p.append(h('div', { class: 'it' + (i === popIdx ? ' on' : ''), onmousedown: (e) => { e.preventDefault(); popIdx = i; popPick(); } }, h('b', {}, it.label), h('span', { class: 'd' }, it.desc || ''))));
  p.children[popIdx]?.scrollIntoView({ block: 'nearest' });
}
function popKey(e) {
  if (e.key === 'ArrowDown') { popIdx = (popIdx + 1) % popItems.length; drawPop(); e.preventDefault(); return true; }
  if (e.key === 'ArrowUp') { popIdx = (popIdx - 1 + popItems.length) % popItems.length; drawPop(); e.preventDefault(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); popPick(); return true; }
  if (e.key === 'Escape') { hidePop(); return true; }
  return false;
}
function popPick() {
  const it = popItems[popIdx]; if (!it) return;
  if (popKind === 'slash' && it.cmd === 'clear') { input.value = ''; hidePop(); newSession(S.cur?.cwd); return; }
  const pos = input.selectionStart, v = input.value;
  if (popKind === 'slash') input.value = it.insert + v.slice(pos);
  else { const start = v.slice(0, pos).lastIndexOf('@') + 1; input.value = v.slice(0, start) + it.insert + ' ' + v.slice(pos); }
  hidePop(); input.focus(); autosize(); renderStatus();
}
function hidePop() { $('#pop').hidden = true; popItems = []; }
input.addEventListener('blur', () => setTimeout(hidePop, 150));

// ---------- model, effort, mode ----------
const MODES = {
  default: { label: 'Tanya dulu', desc: 'Minta izin sebelum mengedit atau menjalankan perintah' },
  acceptEdits: { label: 'Terima edit', desc: 'Edit file langsung, perintah tetap minta izin' },
  plan: { label: 'Rencana', desc: 'Hanya membaca dan menyusun rencana, tanpa mengubah apa pun' },
  auto: { label: 'Otomatis', desc: 'Pengaman otomatis menilai tiap tindakan, jarang bertanya' },
  bypassPermissions: { label: 'Bypass izin', desc: 'Tanpa izin sama sekali. Berbahaya di server ini (sudo).' },
};
const EFFORT = { low: 'Rendah', medium: 'Sedang', high: 'Tinggi', xhigh: 'Sangat tinggi', max: 'Maksimal' };
function modelInfo(v) { return (S.meta?.models || []).find((m) => m.value === v); }
function modelName(v) { const m = modelInfo(v); if (!m) return v === 'default' ? 'Default' : v; return v === 'default' ? 'Default' : m.displayName; }
function renderComposerBits() {
  const c = S.cur || S.prefs;
  const mode = c.mode || 'default';
  const mb = $('#modeBtn'); mb.className = 'pill m-' + mode; mb.innerHTML = ''; mb.append(icon(mode === 'plan' ? 'check' : 'shield'), tr(MODES[mode]?.label || mode));
  const md_ = $('#modelBtn'); md_.innerHTML = ''; md_.append(modelName(c.model || 'default'), h('span', { class: 'sub' }, ' ' + (EFFORT[c.effort] || c.effort || '')));
}
$('#modeBtn').onclick = (e) => showMenu(e.currentTarget, Object.entries(MODES).map(([k, v]) => ({ label: v.label, small: v.desc, check: (S.cur?.mode || S.prefs.mode) === k, danger: k === 'bypassPermissions', action: () => {
  if (k === 'bypassPermissions' && !cfm('Mode Bypass menjalankan semua perintah tanpa bertanya, termasuk sudo. Lanjutkan?')) return;
  setMode(k);
} })), { up: true });
function setMode(k) { if (!S.cur) return; S.cur.mode = k; S.prefs.mode = k === 'bypassPermissions' ? S.prefs.mode : k; api('/api/prefs', { mode: S.prefs.mode }).catch(() => {}); if (S.cur.live) wsSend({ t: 'setMode', key: S.cur.key, mode: k }); renderComposerBits(); }
function setModel(v) { S.cur.model = v; S.prefs.model = v; api('/api/prefs', { model: v }).catch(() => {}); if (S.cur.live) wsSend({ t: 'setModel', key: S.cur.key, model: v }); const lv = modelInfo(v)?.supportedEffortLevels; if (lv && !lv.includes(S.cur.effort)) setEffort(lv.includes('medium') ? 'medium' : lv[0]); renderComposerBits(); }
function setEffort(v) { S.cur.effort = v; S.prefs.effort = v; api('/api/prefs', { effort: v }).catch(() => {}); if (S.cur.live) wsSend({ t: 'setEffort', key: S.cur.key, effort: v }); renderComposerBits(); }
$('#modelBtn').onclick = (e) => modelMenu(e.currentTarget);
function modelMenu(anchor) {
  if (!S.cur) newSession();
  const models = S.meta?.models || [];
  const main = models.filter((m) => !m.value.startsWith('claude-'));
  const older = models.filter((m) => m.value.startsWith('claude-'));
  const cur = S.cur.model || 'default';
  const levels = modelInfo(cur)?.supportedEffortLevels || ['low', 'medium', 'high'];
  const items = [
    ...main.map((m) => ({ label: m.value === 'default' ? 'Default (rekomendasi)' : m.displayName, small: m.value === 'default' ? modelName('default') === 'Default' ? m.description : '' : '', check: cur === m.value, action: () => setModel(m.value) })),
    { sep: true },
    { label: 'Effort', right: EFFORT[S.cur.effort] || S.cur.effort, sub: () => levels.map((l) => ({ label: EFFORT[l], check: S.cur.effort === l, action: () => setEffort(l) })) },
    older.length ? { label: 'Model lain', sub: () => older.map((m) => ({ label: m.displayName, small: m.value, check: cur === m.value, action: () => setModel(m.value) })) } : null,
  ].filter(Boolean);
  if (!models.length) items.unshift({ label: 'Daftar model belum termuat', small: 'Pastikan Claude sudah login di server', action: () => api('/api/meta').then((m) => { S.meta = m; }) });
  showMenu(anchor, items, { up: true });
}

// ---------- macOS-style menus ----------
let menuStack = [];
function showMenu(anchor, items, opts = {}) { menuStack = [{ items, title: null }]; menuOpts = { anchor, ...opts }; drawMenu(); }
let menuOpts = {};
function drawMenu() {
  const m = $('#menu'); m.innerHTML = ''; m.hidden = false;
  const top = menuStack[menuStack.length - 1];
  if (menuStack.length > 1) m.append(h('div', { class: 'mh' }, h('button', { onclick: (e) => { e.stopPropagation(); menuStack.pop(); drawMenu(); } }, icon('back'), 'Kembali'), top.title));
  for (const it of top.items) {
    if (it.sep) { m.append(h('div', { class: 'sep' })); continue; }
    m.append(h('div', { class: 'mi' + (it.danger ? ' danger' : ''), onclick: (e) => {
      e.stopPropagation();
      if (it.sub) { menuStack.push({ items: it.sub(), title: it.label }); drawMenu(); return; }
      hideMenu(); it.action?.();
    } },
      it.check !== undefined ? (it.check ? icon('check', 'ck') : h('span', { style: 'width:15px' })) : null,
      h('div', { class: 'l' }, it.label, it.small ? h('small', {}, it.small) : null),
      it.right || it.sub ? h('span', { class: 'r' }, it.right || '', it.sub ? icon('chev') : null) : null));
  }
  // position
  const a = menuOpts.anchor;
  const r = a.getBoundingClientRect ? a.getBoundingClientRect() : { left: a.clientX, right: a.clientX, top: a.clientY, bottom: a.clientY };
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = Math.min(Math.max(8, r.left), innerWidth - mw - 8);
  let y = menuOpts.up ? r.top - mh - 6 : r.bottom + 4;
  if (y < 8) y = r.bottom + 4; if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  m.style.left = x + 'px'; m.style.top = y + 'px';
}
function hideMenu() { $('#menu').hidden = true; menuStack = []; }
document.addEventListener('click', (e) => { if (!$('#menu').hidden && !e.target.closest('#menu') && !e.target.closest('.pill, .icon-btn')) hideMenu(); }, true);
addEventListener('resize', hideMenu);

// ---------- tab ----------
$('#tabs').onclick = (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); };
function setTab(t) {
  S.tab = t;
  for (const b of $$('#tabs button')) b.classList.toggle('on', b.dataset.tab === t);
  for (const v of $$('.view')) v.classList.toggle('on', v.id === 'view-' + t);
  if (t === 'files') loadFiles(S.fsPath && S.fsPath.startsWith('/') ? S.fsPath : S.cur?.cwd || S.home);
  if (t === 'git') loadGit();
  if (t === 'term' && S.terminalUrl && !$('#term').src) $('#term').src = S.terminalUrl;
}

// ---------- Files ----------
async function loadFiles(dir) {
  S.fsPath = dir;
  try {
    const r = await api('/api/fs/list?path=' + encodeURIComponent(dir));
    const cr = $('#fCrumbs'); cr.innerHTML = '';
    const parts = r.path.split('/').filter(Boolean);
    cr.append(h('button', { onclick: () => loadFiles('/') }, '/'));
    parts.forEach((p, i) => cr.append(h('button', { onclick: () => loadFiles('/' + parts.slice(0, i + 1).join('/')) }, p)));
    const list = $('#fList'); list.innerHTML = '';
    if (r.parent) list.append(h('div', { class: 'row dir', onclick: () => loadFiles(r.parent) }, icon('back'), h('span', { class: 'nm' }, '..')));
    for (const it of r.items) list.append(h('div', { class: 'row' + (it.dir ? ' dir' : ''), title: it.name, ondblclick: () => it.dir && loadFiles(it.path), onclick: (e) => { $$('#fList .row').forEach((x) => x.classList.remove('on')); e.currentTarget.classList.add('on'); it.dir ? loadFiles(it.path) : viewFile(it.path); } },
      icon(it.dir ? 'folder' : 'file'), h('span', { class: 'nm' }, it.name), h('span', { class: 'meta' }, it.dir ? '' : size(it.size))));
    if (!r.items.length) list.append(h('div', { class: 'placeholder' }, 'Folder kosong'));
    if (!$('#fView').childElementCount) $('#fView').append(h('div', { class: 'placeholder' }, 'Pilih file untuk melihat isinya'));
  } catch (e) { toast(e.message, true); }
}
async function viewFile(p) {
  const head = $('#fHead'), v = $('#fView');
  $('#view-files .split').classList.add('viewing');
  head.innerHTML = ''; head.append(...[
    narrow() ? h('button', { class: 'icon-btn', onclick: () => $('#view-files .split').classList.remove('viewing') }, icon('back')) : null,
    h('b', {}, p.split('/').pop())].filter(Boolean),
    h('button', { class: 'btn', onclick: () => { input.value += (input.value && !input.value.endsWith(' ') ? ' ' : '') + '@' + rel(p) + ' '; setTab('chat'); input.focus(); autosize(); renderStatus(); } }, 'Sebut di chat'),
    h('button', { class: 'icon-btn', title: 'Salin path', onclick: () => copy(p) }, icon('copy')));
  v.innerHTML = `<div class="placeholder">${tr('Memuat…')}</div>`;
  try {
    const r = await api('/api/fs/read?path=' + encodeURIComponent(p));
    v.innerHTML = '';
    if (r.kind === 'image') v.append(h('img', { src: `data:${r.mime};base64,${r.data}` }));
    else if (r.kind === 'binary') v.append(h('div', { class: 'placeholder' }, `File biner (${size(r.size)})`));
    else {
      if (/\.md$/i.test(p)) v.append(h('div', { class: 'm-text', style: 'padding:16px 22px;max-width:780px', html: md(r.text) }));
      else { const c = h('div', { class: 'code' }); const lines = r.text.split('\n'); for (const l of lines.slice(0, 20000)) c.append(h('div', {}, l || ' ')); v.append(c); }
      if (r.truncated) v.append(h('div', { class: 'placeholder' }, 'Hanya 1 MB pertama yang ditampilkan.'));
    }
  } catch (e) { v.innerHTML = ''; v.append(h('div', { class: 'placeholder' }, e.message)); }
}

// ---------- Git ----------
async function gitBadge() {
  const cwd = S.cur?.cwd; if (!cwd) return;
  try { S.git = await api('/api/git/status?cwd=' + encodeURIComponent(cwd)); } catch { S.git = { repo: false }; }
  $('#gitCount').textContent = S.git.repo && S.git.files.length ? (S.git.files.length > 99 ? '99+' : S.git.files.length) : '';
  renderHeader(); renderInspector();
}
async function loadGit() {
  await gitBadge();
  const g = S.git, head = $('#gHead'), list = $('#gList');
  head.innerHTML = ''; list.innerHTML = '';
  $('#dView').innerHTML = ''; $('#dHead').innerHTML = '';
  if (!g?.repo) { list.append(h('div', { class: 'placeholder' }, 'Folder ini bukan repositori git.')); $('.commit-box').hidden = true; return; }
  $('.commit-box').hidden = false;
  head.append(icon('branch'), h('b', {}, g.branch || '(detached)'), h('span', {}, `· ${g.files.length} berubah`), h('span', { class: 'grow' }),
    h('button', { class: 'icon-btn', title: 'Muat ulang', onclick: loadGit }, icon('refresh')));
  if (g.files.length) list.append(h('div', { class: 'row', onclick: () => showDiff(null) }, icon('file'), h('span', { class: 'nm' }, 'Semua perubahan')));
  for (const f of g.files) {
    const st = f.x === '?' ? '?' : (f.x !== ' ' ? f.x : f.y);
    list.append(h('div', { class: 'row', title: f.path, onclick: (e) => { $$('#gList .row').forEach((x) => x.classList.remove('on')); e.currentTarget.classList.add('on'); showDiff(f.path); } },
      h('span', { class: 'st ' + st }, st === '?' ? 'U' : st), h('span', { class: 'nm' }, f.path)));
  }
  if (!g.files.length) list.append(h('div', { class: 'placeholder', style: 'height:auto' }, 'Tidak ada perubahan.'));
  if (g.commits.length) { list.append(h('div', { class: 'sec-title' }, 'Commit terakhir')); for (const c of g.commits) list.append(h('div', { class: 'commit' }, c.subject, h('small', {}, `${c.hash} · ${c.author} · ${c.when}`))); }
  if (!narrow() && g.files.length) showDiff(null);
}
async function showDiff(file) {
  $('#view-git .split').classList.add('viewing');
  const head = $('#dHead'), v = $('#dView');
  head.innerHTML = ''; head.append(...[narrow() ? h('button', { class: 'icon-btn', onclick: () => $('#view-git .split').classList.remove('viewing') }, icon('back')) : null, h('b', {}, file || 'Semua perubahan')].filter(Boolean));
  v.innerHTML = `<div class="placeholder">${tr('Memuat…')}</div>`;
  try {
    const r = await api(`/api/git/diff?cwd=${encodeURIComponent(S.cur.cwd)}${file ? '&file=' + encodeURIComponent(file) : ''}`);
    v.innerHTML = ''; v.append(r.diff ? unifiedDiffEl(r.diff) : h('div', { class: 'placeholder' }, 'Tidak ada diff.'));
  } catch (e) { v.innerHTML = ''; v.append(h('div', { class: 'placeholder' }, e.message)); }
}
$('#gCommit').onclick = async () => {
  const msg = $('#gMsg').value.trim(); if (!msg) return toast('Tulis pesan commit dulu.', true);
  if (!cfm(`Commit semua perubahan (${S.git?.files.length || 0} file) dengan pesan:\n\n${msg}`)) return;
  try { const r = await api('/api/git/commit', { cwd: S.cur.cwd, message: msg }); toast(r.out || 'Commit berhasil'); $('#gMsg').value = ''; loadGit(); } catch (e) { toast(e.message, true); }
};

// ---------- Inspector ----------
$('#infoBtn').onclick = () => { document.body.classList.toggle('insp'); save('insp', document.body.classList.contains('insp')); renderInspector(true); };
if (load('insp', false) && innerWidth > 1100) document.body.classList.add('insp');
async function renderInspector(fetchCtx) {
  const box = $('#inspector'); if (!document.body.classList.contains('insp')) return;
  const c = S.cur || {};
  if (fetchCtx !== false && c.live && c.key) api('/api/context?key=' + encodeURIComponent(c.key)).then((ctx) => { S.ctx = ctx; drawInspector(); }).catch(() => {});
  drawInspector();
}
function drawInspector() {
  const box = $('#inspector'); const c = S.cur || {};
  box.innerHTML = '';
  if (narrow() || innerWidth <= 1100) box.append(h('div', { style: 'display:flex;justify-content:flex-end;padding:4px 8px 0' }, h('button', { class: 'icon-btn', onclick: () => { document.body.classList.remove('insp'); save('insp', false); } }, icon('x'))));
  box.append(h('div', { class: 'isec' }, h('h4', {}, 'Lingkungan'), h('div', { class: 'kv' },
    icon('folder'), h('span', { title: c.cwd }, tilde(c.cwd || '—')),
    icon('branch'), h('span', {}, S.git?.repo ? S.git.branch || '(detached)' : 'bukan repo git'),
    icon('tool'), h('span', {}, `${modelName(c.model || 'default')} · ${tr(EFFORT[c.effort] || '')}`),
    icon('shield'), h('span', {}, MODES[c.mode]?.label || c.mode || ''),
    icon('chat'), h('span', {}, c.live ? (c.status === 'running' ? 'Sedang bekerja' : c.status === 'waiting' ? 'Menunggu izin' : 'Aktif') : c.draft ? 'Belum dimulai' : 'Tidak aktif (lanjutkan dengan mengirim pesan)'))));
  const ctx = S.ctx;
  if (c.live && ctx?.categories) {
    const used = ctx.categories.filter((x) => x.kind === 'used' || x.kind === 'buffer');
    const sec = h('div', { class: 'isec' }, h('h4', {}, 'Konteks', h('span', {}, `${fmtNum(ctx.totalTokens)} / ${fmtNum(ctx.maxTokens)}`)));
    const bar = h('div', { class: 'ctx-bar' });
    for (const x of used) bar.append(h('i', { style: `width:${(x.tokens / ctx.maxTokens) * 100}%;background:${ctxColor(x)}` }));
    sec.append(h('div', { style: 'font-size:12px;color:var(--text2)' }, `${Math.round(ctx.percentage)}% terpakai`), bar);
    for (const x of used.filter((x) => x.tokens > 0)) sec.append(h('div', { class: 'ctx-row' }, h('b', { style: `background:${ctxColor(x)}` }), h('span', { class: 'n' }, x.name), h('span', {}, fmtNum(x.tokens)), h('span', { class: 'pct' }, ((x.tokens / ctx.maxTokens) * 100).toFixed(1) + '%')));
    box.append(sec);
  }
  const u = S.usage;
  const lim = h('div', { class: 'isec' }, h('h4', {}, 'Batas pemakaian', h('button', { class: 'icon-btn', title: 'Perbarui', onclick: () => loadUsage(true) }, icon('refresh'))));
  if (u?.windows?.length) for (const w of u.windows) lim.append(limitRow(w));
  else lim.append(h('div', { style: 'font-size:12px;color:var(--text2)' }, u ? 'Data batas tidak tersedia untuk akun ini.' : 'Memuat…'));
  if (u?.plan) lim.append(h('div', { style: 'font-size:11px;color:var(--text3)' }, 'Paket: ' + u.plan));
  box.append(lim);
  const tot = sessionTotals();
  if (tot.turns) box.append(h('div', { class: 'isec' }, h('h4', {}, 'Sesi ini'),
    h('div', { class: 'stat' }, h('span', {}, 'Giliran'), tot.turns), h('div', { class: 'stat' }, h('span', {}, 'Token keluar'), fmtNum(tot.out)),
    h('div', { class: 'stat' }, h('span', {}, 'Waktu kerja'), dur(tot.ms)), h('div', { class: 'stat' }, h('span', {}, 'Setara biaya API'), '$' + tot.cost.toFixed(2))));
  if (c.todos?.length) box.append(h('div', { class: 'isec' }, h('h4', {}, 'Tugas', h('span', {}, `${c.todos.filter((t) => t.status === 'completed').length}/${c.todos.length}`)), todoList(c.todos)));
}
function sessionTotals() { let turns = 0, out = 0, ms = 0, cost = 0; for (const r of S.results || []) { turns++; out += r.usage?.output_tokens || 0; ms += r.duration || 0; cost += r.cost || 0; } return { turns, out, ms, cost }; }
function ctxColor(x) { return { system_prompt: '#8e8e93', system_tools: '#ff9f0a', mcp_tools: '#30d158', memory_files: '#bf5af2', skills: '#64d2ff', messages: '#0a84ff', custom_agents: '#ff375f', autocompact_buffer: '#d1d1d6', compact_buffer: '#d1d1d6' }[x.id] || '#8e8e93'; }
function limitRow(w) {
  const pct = Math.round(w.pct);
  return h('div', { class: 'lim' }, h('div', { class: 'top' }, w.label, h('span', {}, pct + '%')),
    h('div', { class: 'bar' }, h('i', { class: pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : '', style: `width:${Math.min(100, pct)}%` })),
    w.resetsAt ? h('small', {}, 'Reset ' + when(w.resetsAt)) : null);
}
async function loadUsage(force) {
  try { S.usage = await api('/api/usage' + (force ? '?force=1' : '')); } catch { return; }
  const box = $('#usageMini'); box.innerHTML = '';
  for (const w of (S.usage.windows || []).slice(0, 2)) {
    const pct = Math.round(w.pct);
    box.append(h('div', { class: 'um-row', title: w.resetsAt ? 'Reset ' + when(w.resetsAt) : '' }, h('span', {}, w.label), h('span', {}, pct + '%'),
      h('div', { class: 'bar' }, h('i', { class: pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : '', style: `width:${Math.min(100, pct)}%` }))));
  }
  box.onclick = () => { document.body.classList.add('insp'); renderInspector(); closeSide(); };
  drawInspector();
}

// ---------- end of a turn ----------
function onResult(m) {
  S.results = S.results || []; S.results.push(m.result || {});
  clearStreaming();
  if (S.cur) S.cur.status = 'idle';
  renderStatus(); gitBadge(); renderInspector(); loadUsage();
  notifyLocal('Claude selesai', S.cur?.title || '');
  if (S.tab === 'git') loadGit();
}

// ---------- rewind ----------
function rewind(uuid) {
  if (!S.cur?.live) return toast('Kirim pesan dulu agar sesi aktif, lalu coba lagi.', true);
  if (!uuid) return;
  wsSend({ t: 'rewind', key: S.cur.key, uuid, dryRun: true });
}
function onRewound(ev) {
  const r = ev.result || {};
  if (!r.canRewind) return toast(r.error || 'Tidak bisa mengembalikan file ke titik ini.', true);
  if (ev.dryRun) {
    const n = r.filesChanged?.length ?? r.filesChanged ?? 0;
    if (cfm(`Kembalikan ${Array.isArray(r.filesChanged) ? r.filesChanged.length : n} file ke keadaan sebelum pesan ini?\n(+${r.insertions || 0} / -${r.deletions || 0} baris). Percakapan tidak dihapus.`)) wsSend({ t: 'rewind', key: ev.key, uuid: ev.uuid });
  } else { toast('File sudah dikembalikan.'); gitBadge(); }
}

// ---------- Finder-style folder picker ----------
function pickFolder(start) {
  return new Promise((resolve) => {
    let cur = start || S.home, sel = null;
    const card = $('#sheetCard'); card.innerHTML = '';
    const list = h('div', { class: 'scroll list' }), crumbs = h('div', { class: 'crumbs' }), pathEl = h('div', { class: 'path' });
    const places = h('div', { class: 'places' }, h('div', { class: 'mh' }, 'Lokasi'), S.places.map((p) => h('div', { class: 'row', onclick: () => go(p.path) }, icon(p.icon), h('span', { class: 'nm' }, p.name))),
      S.projects.length ? h('div', { class: 'mh', style: 'margin-top:10px' }, 'Proyek') : null, S.projects.slice(0, 8).map((p) => h('div', { class: 'row', onclick: () => go(p.path) }, icon('folder'), h('span', { class: 'nm' }, p.name))));
    async function go(dir) {
      try {
        const r = await api('/api/fs/list?dirs=1&path=' + encodeURIComponent(dir));
        cur = r.path; sel = null; pathEl.textContent = cur;
        crumbs.innerHTML = ''; const parts = cur.split('/').filter(Boolean);
        crumbs.append(h('button', { onclick: () => go('/') }, '/'));
        parts.forEach((p, i) => crumbs.append(h('button', { onclick: () => go('/' + parts.slice(0, i + 1).join('/')) }, p)));
        list.innerHTML = '';
        if (r.parent) list.append(h('div', { class: 'row dir', onclick: () => go(r.parent) }, icon('back'), h('span', { class: 'nm' }, '..')));
        for (const it of r.items) {
          const row = h('div', { class: 'row dir', ondblclick: () => go(it.path), onclick: () => { if (isTouch) return go(it.path); $$('.row', list).forEach((x) => x.classList.remove('on')); row.classList.add('on'); sel = it.path; pathEl.textContent = it.path; } }, icon('folder'), h('span', { class: 'nm' }, it.name), h('span', { class: 'meta' }, icon('chev')));
          list.append(row);
        }
        if (!r.items.length) list.append(h('div', { class: 'placeholder', style: 'height:auto' }, 'Tidak ada subfolder'));
      } catch (e) { toast(e.message, true); }
    }
    const done = (v) => { closeSheet(); resolve(v); };
    card.append(h('div', { class: 'sheet-head' }, icon('folder'), 'Pilih folder kerja'),
      h('div', { class: 'picker' }, places, h('div', { class: 'main' }, crumbs, list)),
      h('div', { class: 'sheet-foot' }, pathEl,
        h('button', { class: 'btn', onclick: async () => { const n = prm('Nama folder baru'); if (!n?.trim()) return; try { const r = await api('/api/fs/mkdir', { path: (sel || cur) + '/' + n.trim() }); go(r.path); } catch (e) { toast(e.message, true); } } }, 'Folder baru'),
        h('button', { class: 'btn', onclick: () => done(null) }, 'Batal'),
        h('button', { class: 'btn primary', onclick: () => done(sel || cur) }, 'Pilih')));
    $('#sheet').hidden = false; $('#sheet').onclick = (e) => { if (e.target.id === 'sheet') done(null); };
    go(cur);
  });
}
function closeSheet() { $('#sheet').hidden = true; }

// ---------- browser notifications ----------
function askNotifyPermission() { if ('Notification' in window && Notification.permission === 'default' && isSecureContext) Notification.requestPermission().catch(() => {}); }
function notifyLocal(title, body) { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') { try { new Notification(title, { body, icon: '/icon.svg', tag: 'claude-hub' }); } catch {} } }

// ---------- scrolling ----------
const scroller = $('#scroller');
function nearBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120; }
function scrollBottom(force) { requestAnimationFrame(() => { if (force || nearBottom()) scroller.scrollTop = scroller.scrollHeight; }); }
scroller.addEventListener('scroll', () => $('#toBottom').classList.toggle('show', !nearBottom()));
$('#toBottom').onclick = () => { scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' }); };

// ---------- utilities ----------
function copy(t) { navigator.clipboard?.writeText(t).then(() => toast('Disalin'), () => toast('Gagal menyalin', true)); }
function tilde(p) { return p && S.home && p.startsWith(S.home) ? '~' + p.slice(S.home.length) : p; }
function base(p) { return (p || '').split('/').filter(Boolean).pop() || '/'; }
function fmtNum(n) { n = Number(n) || 0; return n >= 1e6 ? (n / 1e6).toFixed(1) + ' ' + U.M : n >= 1000 ? (n / 1000).toFixed(1) + U.k : String(n); }
function size(b) { return b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : b >= 1e3 ? Math.round(b / 1e3) + ' KB' : b + ' B'; }
function dur(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s} ${U.s}` : s < 3600 ? `${Math.floor(s / 60)} ${U.m} ${s % 60} ${U.s}` : `${Math.floor(s / 3600)} ${U.h} ${Math.floor((s % 3600) / 60)} ${U.m}`; }
function ago(t) { if (!t) return ''; const s = (Date.now() - t) / 1000; if (s < 60) return U.now; if (s < 3600) return Math.floor(s / 60) + ' ' + U.m; if (s < 86400) return Math.floor(s / 3600) + ' ' + U.h; if (s < 172800) return U.yest; return Math.floor(s / 86400) + ' ' + U.d; }
function when(iso) { const d = new Date(iso); if (isNaN(d)) return ''; const sameDay = d.toDateString() === new Date().toDateString(); return d.toLocaleString(U.locale, sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
addEventListener('resize', () => { if (!narrow()) closeSide(); });

boot();
