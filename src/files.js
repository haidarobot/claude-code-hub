// Folders, files and git for the side panels. Read-only, except for git commit.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.js';

const HIDE = new Set(['node_modules', '.git', 'lost+found', '__pycache__', '.cache', '.npm']);

export function err(code, msg) { return Object.assign(new Error(msg), { code }); }
function abs(p) { if (typeof p !== 'string' || !p.startsWith('/')) throw err(400, 'Path must be absolute.'); return path.resolve(p); }

export async function places() {
  const out = [];
  for (const p of config.places) { try { await fs.access(p.path); out.push(p); } catch {} }
  return out;
}

export async function list(dir, { dirsOnly = false, hidden = false } = {}) {
  dir = abs(dir);
  const ents = await fs.readdir(dir, { withFileTypes: true }).catch((e) => { throw err(e.code === 'EACCES' ? 403 : 404, e.code === 'EACCES' ? 'No permission to read this folder.' : 'Folder not found.'); });
  const items = [];
  for (const e of ents) {
    if (!hidden && e.name.startsWith('.')) continue;
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = (await fs.stat(path.join(dir, e.name))).isDirectory(); } catch { continue; } }
    if (dirsOnly && !isDir) continue;
    let size = 0, mtime = 0;
    if (!isDir) { try { const s = await fs.stat(path.join(dir, e.name)); size = s.size; mtime = s.mtimeMs; } catch {} }
    items.push({ name: e.name, path: path.join(dir, e.name), dir: isDir, size, mtime });
  }
  items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'id', { numeric: true }));
  return { path: dir, parent: dir === '/' ? null : path.dirname(dir), items };
}

const TEXT_MAX = 1_000_000;
const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
export async function read(file) {
  file = abs(file);
  const st = await fs.stat(file).catch(() => { throw err(404, 'File not found.'); });
  if (st.isDirectory()) throw err(400, 'This is a folder.');
  const ext = path.extname(file).toLowerCase();
  if (IMG[ext]) {
    if (st.size > 8_000_000) throw err(413, 'Image too large to preview.');
    return { kind: 'image', mime: IMG[ext], data: (await fs.readFile(file)).toString('base64'), size: st.size };
  }
  const fh = await fs.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, TEXT_MAX));
    await fh.read(buf, 0, buf.length, 0);
    if (buf.subarray(0, 8000).includes(0)) return { kind: 'binary', size: st.size };
    return { kind: 'text', text: buf.toString('utf8'), size: st.size, truncated: st.size > TEXT_MAX };
  } finally { await fh.close(); }
}

/** File search for @mentions: git ls-files when available, otherwise a bounded folder walk. */
export async function search(cwd, q) {
  cwd = abs(cwd); q = String(q || '').toLowerCase();
  let files = await run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], cwd, 4000).then((o) => o.split('\n').filter(Boolean)).catch(() => null);
  if (!files) {
    files = [];
    const walk = async (d, rel, depth) => {
      if (files.length > 5000 || depth > 6) return;
      let ents = []; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.name.startsWith('.') || HIDE.has(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { files.push(r + '/'); await walk(path.join(d, e.name), r, depth + 1); } else files.push(r);
      }
    };
    await walk(cwd, '', 0);
  }
  const scored = [];
  for (const f of files) {
    const lf = f.toLowerCase(); const base = lf.split('/').filter(Boolean).pop() || lf;
    const i = q ? lf.indexOf(q) : 0;
    if (i < 0) continue;
    scored.push([base.startsWith(q) ? 0 : base.includes(q) ? 1 : 2, f.length, f]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.slice(0, 30).map((s) => s[2]);
}

// ---------- git ----------
function run(cmd, args, cwd, timeout = 10000) {
  return new Promise((res, rej) => execFile(cmd, args, { cwd, timeout, maxBuffer: 20 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
    (e, out, se) => e ? rej(err(400, (se || e.message).trim().slice(0, 400))) : res(out)));
}

export async function gitStatus(cwd) {
  cwd = abs(cwd);
  const top = await run('git', ['rev-parse', '--show-toplevel'], cwd).then((s) => s.trim()).catch(() => null);
  if (!top) return { repo: false };
  const [branch, status, log] = await Promise.all([
    run('git', ['branch', '--show-current'], cwd).then((s) => s.trim()).catch(() => ''),
    run('git', ['status', '--porcelain=v1', '-uall'], cwd),
    run('git', ['log', '-n', '15', '--pretty=format:%h%x1f%s%x1f%an%x1f%ar'], cwd).catch(() => ''),
  ]);
  const files = status.split('\n').filter(Boolean).slice(0, 500).map((l) => ({ x: l[0], y: l[1], path: l.slice(3).replace(/^.* -> /, '') }));
  const commits = log.split('\n').filter(Boolean).map((l) => { const [hash, subject, author, when] = l.split('\x1f'); return { hash, subject, author, when }; });
  return { repo: true, top, branch, files, commits };
}

export async function gitDiff(cwd, file) {
  cwd = abs(cwd);
  const args = file ? ['--', file] : [];
  let diff = await run('git', ['diff', 'HEAD', '--no-color', '--no-ext-diff', ...args], cwd).catch(() => run('git', ['diff', '--no-color', ...args], cwd));
  // untracked new files
  const untracked = file ? (diff ? [] : [file])
    : (await run('git', ['ls-files', '--others', '--exclude-standard'], cwd).catch(() => '')).split('\n').filter(Boolean).slice(0, 30);
  for (const f of untracked) {
    try {
      const st = await fs.stat(path.join(cwd, f)); if (st.size > 300_000) continue;
      const t = await fs.readFile(path.join(cwd, f), 'utf8'); if (t.includes('\0')) continue;
      diff += `${diff ? '\n' : ''}@@ ${f} (new file) @@\n` + t.split('\n').slice(0, 2000).map((l) => '+' + l).join('\n');
    } catch {}
  }
  return { diff: diff.slice(0, 2_000_000) };
}

export async function gitCommit(cwd, message, files) {
  cwd = abs(cwd);
  message = String(message || '').trim();
  if (message.length < 2) throw err(400, 'Commit message is empty.');
  if (Array.isArray(files) && files.length) await run('git', ['add', '--', ...files], cwd);
  else await run('git', ['add', '-A'], cwd);
  const out = await run('git', ['commit', '-m', message], cwd);
  return { ok: true, out: out.trim().split('\n')[0] };
}
