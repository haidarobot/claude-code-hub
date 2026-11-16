// Authentication.
//   password — built-in login page; a signed, HttpOnly cookie keeps you signed in for 30 days.
//   proxy    — a reverse proxy in front (Caddy forward_auth, Authelia, Cloudflare Access…) already checked the user.
//   none     — no login; config.js only allows this when listening on localhost.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const COOKIE = 'chub_session';
const MAX_AGE = 30 * 24 * 3600;
let secret;
function getSecret() {
  if (secret) return secret;
  const file = path.join(config.stateDir, 'secret');
  try { secret = fs.readFileSync(file); } catch {
    fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
    secret = crypto.randomBytes(32);
    fs.writeFileSync(file, secret, { mode: 0o600 });
  }
  return secret;
}
// Changing AUTH_PASSWORD invalidates every existing session.
const pwTag = () => crypto.createHash('sha256').update(config.password).digest('hex').slice(0, 12);
const sign = (v) => crypto.createHmac('sha256', getSecret()).update(v).digest('base64url');

function readCookie(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

export function allowed(req) {
  if (config.auth !== 'password') return true;
  const c = readCookie(req); if (!c) return false;
  const [exp, tag, sig] = c.split('.');
  if (!exp || !sig || Number(exp) < Date.now() / 1000 || tag !== pwTag()) return false;
  const good = sign(`${exp}.${tag}`);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

const isHttps = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
const cookieAttrs = (req, maxAge) => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

const fails = new Map(); // ip -> [timestamps]
export function login(req, password) {
  if (config.auth !== 'password') return { ok: false, code: 400, error: 'Password login is not enabled.' };
  const ip = req.socket.remoteAddress || '?';
  const recent = (fails.get(ip) || []).filter((t) => Date.now() - t < 10 * 60_000);
  if (recent.length >= 10) return { ok: false, code: 429, error: 'Terlalu banyak percobaan. Tunggu sebentar.' };
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(config.password).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    recent.push(Date.now()); fails.set(ip, recent);
    return { ok: false, code: 401, error: 'Kata sandi salah.' };
  }
  fails.delete(ip);
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const value = `${exp}.${pwTag()}`;
  return { ok: true, cookie: `${COOKIE}=${value}.${sign(value)}; ${cookieAttrs(req, MAX_AGE)}` };
}

export function logoutCookie(req) { return `${COOKIE}=; ${cookieAttrs(req, 0)}`; }
