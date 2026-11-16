// A running Claude Code session (Claude Agent SDK). One session = one Claude Code process.
// It keeps working when the browser or phone is closed; a client that reconnects gets the
// history plus everything still in progress.
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import { notify } from './notify.js';
import { config } from './config.js';

const IDLE_CLOSE_MS = config.idleCloseMin * 60_000;
const MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

class Pushable {
  items = []; waiters = []; done = false;
  push(v) { const w = this.waiters.shift(); if (w) w({ value: v, done: false }); else this.items.push(v); }
  end() { this.done = true; for (const w of this.waiters.splice(0)) w({ value: undefined, done: true }); }
  [Symbol.asyncIterator]() {
    return { next: () => this.items.length ? Promise.resolve({ value: this.items.shift(), done: false })
      : this.done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => this.waiters.push(r)) };
  }
}

/** All running sessions, keyed by sessionId (or a temporary id until the CLI reports one). */
export const lives = new Map();

export class Live {
  constructor({ cwd, resume, model, effort, mode, title }) {
    this.key = resume || `baru-${randomUUID()}`;
    this.sessionId = resume || null;
    this.cwd = cwd;
    this.model = model || 'default';
    this.effort = EFFORTS.includes(effort) ? effort : 'medium';
    this.mode = MODES.includes(mode) ? mode : 'default';
    this.title = title || '';
    this.status = 'idle';          // idle | running | closed
    this.base = [];                // history from before this process started (resume)
    this.log = [];                 // messages since the process started
    this.partial = null;           // text still streaming {id, blocks: {index: {kind, text}}}
    this.pending = new Map();      // permission requests waiting for an answer
    this.subs = new Set();         // websockets watching this session
    this.turnStart = 0;
    this.lastResult = null;
    this.rateLimit = null;
    this.todos = null;
    lives.set(this.key, this);
  }

  async start() {
    if (this.sessionId) {
      try { this.base = await getSessionMessages(this.sessionId, { dir: this.cwd }); } catch { this.base = []; }
    }
    this.input = new Pushable();
    this.q = query({
      prompt: this.input,
      options: {
        cwd: this.cwd,
        resume: this.sessionId || undefined,
        model: this.model === 'default' ? undefined : this.model,
        effort: this.effort,
        permissionMode: this.mode,
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        enableFileCheckpointing: true,
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        pathToClaudeCodeExecutable: config.claudeBin,
        env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'claude-hub' },
        canUseTool: (tool, input, opts) => this.askPermission(tool, input, opts),
        stderr: (d) => { if (/error/i.test(d)) console.error(`[${this.key.slice(0, 8)}]`, d.trim().slice(0, 300)); },
      },
    });
    this.pump();
    this.touch();
  }

  async pump() {
    try {
      for await (const m of this.q) this.onMessage(m);
    } catch (e) {
      this.emit({ t: 'error', message: String(e?.message || e).slice(0, 500) });
    } finally {
      this.status = 'closed';
      for (const p of this.pending.values()) p.resolve({ behavior: 'deny', message: 'Session closed.' });
      this.pending.clear();
      this.emit({ t: 'state', ...this.info() });
      lives.delete(this.key); if (this.sessionId) lives.delete(this.sessionId);
      clearTimeout(this.idleTimer);
    }
  }

  onMessage(m) {
    if (m.type === 'system' && m.subtype === 'init') {
      if (!this.sessionId || this.sessionId !== m.session_id) {
        const old = this.key;
        this.sessionId = m.session_id;
        lives.set(this.sessionId, this);
        this.emit({ t: 'sid', from: old, sessionId: this.sessionId });
      }
      this.initInfo = { model: m.model, tools: m.tools?.length, mcp: m.mcp_servers, version: m.claude_code_version, commands: m.slash_commands };
      return;
    }
    if (m.type === 'stream_event') return this.onStream(m);
    if (m.type === 'rate_limit_event') { this.rateLimit = m.rate_limit_info; this.emit({ t: 'ratelimit', info: m.rate_limit_info }); return; }
    if (m.type === 'assistant' || m.type === 'user') {
      if (m.type === 'assistant' && m.parent_tool_use_id == null) this.partial = null;
      if (m.type === 'user' && m.isReplay) return;
      for (const b of m.message?.content || []) if (b.type === 'tool_use' && b.name === 'TodoWrite') this.todos = b.input?.todos || null;
      const msg = { type: m.type, uuid: m.uuid, message: m.message, parent_tool_use_id: m.parent_tool_use_id ?? null, tool_use_result: m.type === 'user' ? slim(m.tool_use_result) : undefined };
      this.log.push(msg);
      this.emit({ t: 'msg', m: msg });
      return;
    }
    if (m.type === 'result') {
      this.status = 'idle';
      this.partial = null;
      this.lastResult = { subtype: m.subtype, cost: m.total_cost_usd, duration: m.duration_ms, turns: m.num_turns, usage: m.usage, modelUsage: m.modelUsage, error: m.subtype !== 'success' ? (m.errors || []).join('\n') || m.subtype : null };
      const msg = { type: 'result', uuid: m.uuid || randomUUID(), result: this.lastResult };
      this.log.push(msg);
      this.emit({ t: 'msg', m: msg });
      this.emit({ t: 'state', ...this.info() });
      const took = Date.now() - this.turnStart;
      if (took > 45_000 && !this.anyoneWatching()) notify(`✅ Claude finished (${Math.round(took / 1000)}s)\n${this.label()}`);
      this.touch();
      return;
    }
    if (m.type === 'system' && m.subtype === 'compact_boundary') { this.emit({ t: 'msg', m: { type: 'system', uuid: m.uuid, note: 'Percakapan diringkas (compact).' } }); return; }
    if (m.type === 'system' && m.subtype === 'status') { this.emit({ t: 'status', status: m.status }); return; }
    if (m.type === 'system' && m.subtype === 'api_retry') { this.emit({ t: 'notice', text: `Mencoba ulang ke API (${m.attempt ?? ''})…` }); return; }
    if (m.type === 'tool_progress') { this.emit({ t: 'progress', id: m.tool_use_id, name: m.tool_name, secs: m.elapsed_time_seconds }); return; }
  }

  onStream(m) {
    if (m.parent_tool_use_id) return;
    const ev = m.event;
    if (ev.type === 'message_start') { this.partial = { id: ev.message?.id, blocks: {} }; return; }
    if (!this.partial) this.partial = { id: null, blocks: {} };
    if (ev.type === 'content_block_start') {
      const kind = ev.content_block?.type === 'thinking' ? 'thinking' : ev.content_block?.type === 'text' ? 'text' : null;
      if (kind) this.partial.blocks[ev.index] = { kind, text: '' };
      return;
    }
    if (ev.type === 'content_block_delta') {
      const d = ev.delta; const b = this.partial.blocks[ev.index];
      const text = d.type === 'text_delta' ? d.text : d.type === 'thinking_delta' ? d.thinking : null;
      if (b && text) { b.text += text; this.emit({ t: 'delta', index: ev.index, kind: b.kind, text }); }
    }
  }

  // ---------- permissions ----------
  askPermission(tool, input, opts) {
    const id = randomUUID();
    return new Promise((resolve) => {
      const req = { id, tool, input, title: opts.title, description: opts.description, displayName: opts.displayName, reason: opts.decisionReason, blockedPath: opts.blockedPath, suggestions: opts.suggestions || [], toolUseID: opts.toolUseID, at: Date.now() };
      this.pending.set(id, { ...req, resolve });
      this.emit({ t: 'perm', req });
      this.emit({ t: 'state', ...this.info() });
      opts.signal?.addEventListener('abort', () => { if (this.pending.delete(id)) { this.emit({ t: 'permDone', id }); this.emit({ t: 'state', ...this.info() }); } });
      req.timer = setTimeout(() => {
        if (this.pending.has(id) && !this.anyoneWatching()) notify(`🔐 Claude needs permission: ${tool}\n${summarize(tool, input)}\n${this.label()}`);
      }, 20_000);
    });
  }

  answer(id, a) {
    const p = this.pending.get(id); if (!p) return false;
    this.pending.delete(id); clearTimeout(p.timer);
    let res;
    if (a.behavior === 'deny') res = { behavior: 'deny', message: a.message || 'The user denied this.', interrupt: !!a.interrupt };
    else {
      res = { behavior: 'allow', updatedInput: p.input };
      if (p.tool === 'AskUserQuestion' && a.answers) res.updatedInput = { ...p.input, answers: a.answers };
      if (a.always && p.suggestions.length) res.updatedPermissions = p.suggestions;
      if (p.tool === 'ExitPlanMode' && MODES.includes(a.mode)) {
        res.updatedPermissions = [{ type: 'setMode', mode: a.mode, destination: 'session' }];
        this.mode = a.mode;
      }
    }
    p.resolve(res);
    this.emit({ t: 'permDone', id });
    this.emit({ t: 'state', ...this.info() });
    return true;
  }

  // ---------- commands from the browser ----------
  send(content, text) {
    this.status = 'running'; this.turnStart = Date.now(); this.partial = null;
    const msg = { type: 'user', uuid: randomUUID(), message: { role: 'user', content }, parent_tool_use_id: null };
    if (!this.title && text) this.title = text.slice(0, 80);
    this.log.push(msg);
    this.emit({ t: 'msg', m: msg });
    this.emit({ t: 'state', ...this.info() });
    // the CLI uses this uuid for its file checkpoint, so "restore files" can point at this message
    this.input.push({ type: 'user', uuid: msg.uuid, message: { role: 'user', content }, parent_tool_use_id: null });
    this.touch();
  }
  async interrupt() { try { await this.q.interrupt(); } catch {} }
  async setModel(m) { this.model = m || 'default'; await this.q.setModel(m === 'default' ? undefined : m); this.emit({ t: 'state', ...this.info() }); }
  async setMode(m) { if (!MODES.includes(m)) return; this.mode = m; await this.q.setPermissionMode(m); this.emit({ t: 'state', ...this.info() }); }
  async setEffort(e) { if (!EFFORTS.includes(e)) return; this.effort = e; await this.q.applyFlagSettings({ effortLevel: e }); this.emit({ t: 'state', ...this.info() }); }
  async context() { try { return await this.q.getContextUsage({ detail: 'summary' }); } catch { return null; } }
  async usage() { try { return await this.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }); } catch { return null; } }
  async rewind(uuid, dryRun) { return this.q.rewindFiles(uuid, { dryRun }); }
  close() { try { this.input.end(); this.q.close(); } catch {} }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { if (this.status === 'idle' && !this.pending.size) this.close(); else this.touch(); }, IDLE_CLOSE_MS);
  }

  // ---------- broadcasting ----------
  emit(ev) { const s = JSON.stringify({ ...ev, key: this.sessionId || this.key }); for (const ws of this.subs) if (ws.readyState === 1) ws.send(s); }
  anyoneWatching() { for (const ws of this.subs) if (ws.visible) return true; return false; }
  label() { return `📁 ${this.cwd}${this.title ? `\n💬 ${this.title}` : ''}`; }
  info() {
    return { sessionId: this.sessionId, key: this.key, cwd: this.cwd, model: this.model, effort: this.effort, mode: this.mode, status: this.pending.size ? 'waiting' : this.status, title: this.title, live: this.status !== 'closed', todos: this.todos, lastResult: this.lastResult };
  }
  snapshot() {
    return { t: 'snapshot', ...this.info(), messages: [...this.base.map(fromHistory), ...this.log], partial: this.partial, pending: [...this.pending.values()].map(({ resolve, timer, ...r }) => r) };
  }
}

/** Convert a JSONL history message to the same shape as a live message. */
export function fromHistory(h) {
  return { type: h.type, uuid: h.uuid, message: h.message, parent_tool_use_id: h.parent_tool_use_id ?? null };
}

function slim(r) {
  if (!r || typeof r !== 'object') return undefined;
  const o = {};
  for (const k of ['structuredPatch', 'filePath', 'type', 'stdout', 'stderr', 'interrupted', 'isImage', 'originalFile']) if (k in r) o[k] = k === 'originalFile' ? undefined : r[k];
  return o;
}

function summarize(tool, input = {}) {
  const s = input.command || input.file_path || input.path || input.url || input.pattern || input.description || '';
  return String(s).slice(0, 200);
}
