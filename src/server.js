#!/usr/bin/env node
// Claude Code Hub: a macOS-style web UI for Claude Code, running on your own server.
// Listens on 127.0.0.1 by default. Put it behind a login (AUTH_PASSWORD), your own
// reverse-proxy auth (AUTH_MODE=proxy), or a private network such as Tailscale.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { query, listSessions, renameSession, deleteSession, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { Live, lives, fromHistory } from './live.js';
import * as F from './files.js';
import * as Auth from './auth.js';
import { notifyEnabled } from './notify.js';

const PUBLIC = path.join(config.root, 'public');
const STATE_FILE = path.join(config.stateDir, 'state.json');

// ---------- small persistent state (pinned projects, preferences) ----------
let state = { pins: [], prefs: {} };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
function saveState() {
  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

// ---------- account, models, commands, usage (no tokens spent) ----------
let meta = null, metaAt = 0, metaBusy = null;
async function withProbe(fn) {
  const live = [...lives.values()].find((l) => l.status !== 'closed' && l.q);
  if (live) return fn(live.q);
  async function* idle() { await new Promise(() => {}); }
  const q = query({ prompt: idle(), options: { cwd: os.homedir(), pathToClaudeCodeExecutable: config.claudeBin, settingSources: ['user'] } });
  try { return await Promise.race([fn(q), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 30000))]); } finally { q.close(); }
}
async function getMeta(force) {
  if (meta && !force && Date.now() - metaAt < 10 * 60_000) return meta;
  if (metaBusy) return metaBusy;
  metaBusy = withProbe(async (q) => {
    const [account, models, commands] = await Promise.all([q.accountInfo().catch(() => null), q.supportedModels().catch(() => []), q.supportedCommands().catch(() => [])]);
    return { account: account && { plan: account.subscriptionType, provider: account.apiProvider }, models, commands: commands.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint })) };
  }).then((m) => { meta = m; metaAt = Date.now(); return m; }).finally(() => { metaBusy = null; });
  return metaBusy;
}
let usageCache = null, usageAt = 0;
async function getUsage(force) {
  if (usageCache && !force && Date.now() - usageAt < 60_000) return usageCache;
  const u = await withProbe((q) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
  const rl = u?.rate_limits || {};
  // Labels are Indonesian source strings; the browser translates them (public/i18n.js).
  const pick = (k, label) => rl[k] && rl[k].utilization != null ? { key: k, label, pct: rl[k].utilization, resetsAt: rl[k].resets_at } : null;
  const windows = [pick('five_hour', 'Sesi 5 jam'), pick('seven_day', 'Mingguan'), pick('seven_day_opus', 'Mingguan Opus'), pick('seven_day_sonnet', 'Mingguan Sonnet'),
    ...(rl.model_scoped || []).filter((m) => m.utilization != null).map((m) => ({ key: m.display_name, label: `Mingguan ${m.display_name}`, pct: m.utilization, resetsAt: m.resets_at }))].filter(Boolean);
  usageCache = { plan: u?.subscription_type, available: !!u?.rate_limits_available, windows };
  usageAt = Date.now();
  return usageCache;
}

// ---------- projects & sessions ----------
async function projects() {
  const all = await listSessions({ limit: 500 }).catch(() => []);
  const map = new Map();
  for (const p of state.pins) map.set(p, { path: p, pinned: true, last: 0, count: 0 });
  for (const s of all) {
    if (!s.cwd) continue;
    const p = map.get(s.cwd) || { path: s.cwd, pinned: false, last: 0, count: 0 };
    p.count++; p.last = Math.max(p.last, s.lastModified || 0);
    map.set(s.cwd, p);
  }
  for (const l of lives.values()) if (!map.has(l.cwd)) map.set(l.cwd, { path: l.cwd, pinned: false, last: Date.now(), count: 0 });
  return [...map.values()].map((p) => ({ ...p, name: path.basename(p.path) || p.path, exists: fs.existsSync(p.path) }))
    .filter((p) => p.exists || p.pinned)
    .sort((a, b) => (b.pinned - a.pinned) || b.last - a.last);
}
async function sessions(dir) {
  const list = await listSessions({ dir, limit: 200 }).catch(() => []);
  const out = list.filter((s) => !s.cwd || s.cwd === dir).map((s) => {
    const l = lives.get(s.sessionId);
    return { sessionId: s.sessionId, title: s.customTitle || s.summary || s.firstPrompt || 'Untitled session', last: s.lastModified, branch: s.gitBranch, live: !!l, status: l ? l.info().status : 'off' };
  });
  for (const l of new Set(lives.values())) if (l.cwd === dir && !out.some((s) => s.sessionId === (l.sessionId || l.key)))
    out.unshift({ sessionId: l.sessionId || l.key, title: l.title || 'New session', last: Date.now(), live: true, status: l.info().status });
  return out.sort((a, b) => b.last - a.last);
}
function livesInfo() { return [...new Set(lives.values())].map((l) => l.info()); }
function closeLive(id) { for (const l of new Set(lives.values())) if (l.sessionId === id || l.key === id) l.close(); }

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
  'x-frame-options': 'SAMEORIGIN',
  'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-src *; base-uri 'none'; form-action 'self'",
};
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
  res.end(JSON.stringify(body));
}
async function body(req) {
  let raw = ''; for await (const c of req) { raw += c; if (raw.length > 1 << 20) throw F.err(413, 'Request too large'); }
  try { return JSON.parse(raw || '{}'); } catch { throw F.err(400, 'Invalid JSON'); }
}
function sameOrigin(req) {
  const o = req.headers.origin; if (!o) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

const routes = {
  'GET /api/boot': async () => ({ name: config.displayName, auth: config.auth, places: await F.places(), meta: await getMeta().catch(() => null), prefs: state.prefs, home: os.homedir(), terminalUrl: config.terminalUrl, notify: notifyEnabled }),
  'GET /api/meta': async () => getMeta(true),
  'GET /api/usage': async (u) => getUsage(u.searchParams.get('force') === '1'),
  'GET /api/projects': async () => ({ projects: await projects(), lives: livesInfo() }),
  'GET /api/sessions': async (u) => ({ sessions: await sessions(u.searchParams.get('dir')) }),
  'POST /api/pins': async (u, req) => { const b = await body(req); const p = String(b.path || ''); if (!p.startsWith('/')) throw F.err(400, 'Invalid path'); state.pins = state.pins.filter((x) => x !== p); if (!b.remove) state.pins.unshift(p); saveState(); return { ok: true }; },
  'POST /api/prefs': async (u, req) => { const b = await body(req); const allowed = ['model', 'effort', 'mode']; for (const k of allowed) if (typeof b[k] === 'string') state.prefs[k] = b[k]; saveState(); return { ok: true }; },
  'POST /api/session/rename': async (u, req) => { const b = await body(req); const title = String(b.title || '').slice(0, 120); await renameSession(b.sessionId, title, { dir: b.dir }); for (const l of new Set(lives.values())) if (l.sessionId === b.sessionId) l.title = title; return { ok: true }; },
  'POST /api/session/delete': async (u, req) => { const b = await body(req); closeLive(b.sessionId); await deleteSession(b.sessionId, { dir: b.dir }); return { ok: true }; },
  'GET /api/context': async (u) => { const l = lives.get(u.searchParams.get('key')); return l ? (await l.context()) || {} : {}; },
  'GET /api/fs/list': async (u) => F.list(u.searchParams.get('path'), { dirsOnly: u.searchParams.get('dirs') === '1', hidden: u.searchParams.get('hidden') === '1' }),
  'GET /api/fs/read': async (u) => F.read(u.searchParams.get('path')),
  'GET /api/fs/search': async (u) => ({ files: await F.search(u.searchParams.get('cwd'), u.searchParams.get('q')) }),
  'POST /api/fs/mkdir': async (u, req) => { const b = await body(req); if (!String(b.path || '').startsWith('/')) throw F.err(400, 'Invalid path'); const p = path.resolve(b.path); await fsp.mkdir(p, { recursive: true }); return { ok: true, path: p }; },
  'GET /api/git/status': async (u) => F.gitStatus(u.searchParams.get('cwd')),
  'GET /api/git/diff': async (u) => F.gitDiff(u.searchParams.get('cwd'), u.searchParams.get('file')),
  'POST /api/git/commit': async (u, req) => { const b = await body(req); return F.gitCommit(b.cwd, b.message, b.files); },
};

const PUBLIC_FILES = new Set(['/login', '/login.html', '/style.css', '/login.js', '/i18n.js', '/icon.svg', '/icon-180.png', '/manifest.webmanifest']);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    // --- built-in login ---
    if (u.pathname === '/api/login' && req.method === 'POST') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Origin rejected' });
      const b = await body(req);
      const r = Auth.login(req, String(b.password || ''));
      if (!r.ok) return send(res, r.code, { error: r.error });
      return send(res, 200, { ok: true }, { 'set-cookie': r.cookie });
    }
    if (u.pathname === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': Auth.logoutCookie(req) });
    if (!PUBLIC_FILES.has(u.pathname) && !Auth.allowed(req)) {
      if (u.pathname.startsWith('/api/')) return send(res, 401, { error: 'Sign in required' });
      res.writeHead(302, { location: '/login' }); return res.end();
    }
    if (u.pathname.startsWith('/api/')) {
      const h = routes[`${req.method} ${u.pathname}`];
      if (!h) return send(res, 404, { error: 'Not found' });
      if (req.method === 'POST' && !sameOrigin(req)) return send(res, 403, { error: 'Origin rejected' });
      return send(res, 200, await h(u, req));
    }
    let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p === '/login') p = '/login.html';
    if (p === '/' || !path.extname(p)) p = '/index.html';
    const file = path.join(PUBLIC, p);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': p.includes('/vendor/') ? 'public, max-age=604800' : 'no-cache', ...SECURITY_HEADERS });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, typeof e.code === 'number' ? e.code : 500, { error: e.message });
  }
});

// ---------- WebSocket ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 40 << 20 });
const clients = new Set();
server.on('upgrade', (req, sock, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !sameOrigin(req) || !Auth.allowed(req)) return sock.destroy();
  wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws, req));
});
function broadcastLives() { const s = JSON.stringify({ t: 'lives', lives: livesInfo() }); for (const c of clients) if (c.readyState === 1) c.send(s); }
setInterval(() => { for (const c of clients) if (c.readyState === 1) c.ping(); }, 25000);

wss.on('connection', (ws) => {
  clients.add(ws); ws.visible = true; ws.watching = null;
  const reply = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  const watch = (live) => { if (ws.watching && ws.watching !== live) ws.watching.subs.delete(ws); ws.watching = live; live?.subs.add(ws); };
  ws.on('close', () => { clients.delete(ws); ws.watching?.subs.delete(ws); });
  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    try {
      const live = m.key ? lives.get(m.key) : null;
      switch (m.t) {
        case 'visible': ws.visible = !!m.v; break;
        case 'open': {
          const l = lives.get(m.sessionId);
          if (l) { watch(l); reply(l.snapshot()); break; }
          watch(null);
          const hist = await getSessionMessages(m.sessionId, { dir: m.cwd }).catch(() => []);
          reply({ t: 'snapshot', key: m.sessionId, sessionId: m.sessionId, cwd: m.cwd, live: false, status: 'off', messages: hist.map(fromHistory), pending: [] });
          break;
        }
        case 'send': {
          let l = live;
          if (!l) {
            if (!m.cwd || !fs.existsSync(m.cwd)) return reply({ t: 'error', message: 'Folder not found.' });
            l = new Live({ cwd: m.cwd, resume: m.sessionId || undefined, model: m.model, effort: m.effort, mode: m.mode, title: m.title });
            watch(l); await l.start(); reply(l.snapshot());
          }
          const content = [];
          for (const img of (m.images || []).slice(0, 8)) if (/^image\/(png|jpeg|gif|webp)$/.test(img.media_type)) content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
          if (m.text) content.push({ type: 'text', text: String(m.text) });
          if (!content.length) break;
          l.send(content.length === 1 && content[0].type === 'text' ? content[0].text : content, m.text || '');
          broadcastLives();
          break;
        }
        case 'answer': live?.answer(m.id, m); broadcastLives(); break;
        case 'interrupt': await live?.interrupt(); break;
        case 'setModel': await live?.setModel(m.model); break;
        case 'setMode': await live?.setMode(m.mode); break;
        case 'setEffort': await live?.setEffort(m.effort); break;
        case 'rewind': {
          if (!live) break;
          const r = await live.rewind(m.uuid, !!m.dryRun).catch((e) => ({ canRewind: false, error: e.message }));
          reply({ t: 'rewound', key: m.key, uuid: m.uuid, dryRun: !!m.dryRun, result: r });
          break;
        }
        case 'stop': if (m.key) closeLive(m.key); setTimeout(broadcastLives, 500); break;
      }
    } catch (e) { reply({ t: 'error', message: String(e.message || e).slice(0, 400) }); }
  });
});

// Session status changes → tell every client (status dots in the sidebar).
const origEmit = Live.prototype.emit;
Live.prototype.emit = function (ev) { origEmit.call(this, ev); if (ev.t === 'state' || ev.t === 'sid') broadcastLives(); };

server.listen(config.port, config.host, () => {
  console.log(`Claude Code Hub on http://${config.host}:${config.port} (auth: ${config.auth})`);
  if (config.auth === 'none') console.log('No login configured: only reachable from this machine. Set AUTH_PASSWORD to allow other devices.');
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { for (const l of new Set(lives.values())) l.close(); process.exit(0); });
