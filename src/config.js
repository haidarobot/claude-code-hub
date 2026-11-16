// All settings come from environment variables (see .env.example).
// A `.env` file next to package.json is loaded too, so a plain `npm start` works.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch {}

const env = process.env;
const home = os.homedir();
const localClaude = path.join(home, '.local/bin/claude');

function parsePlaces(v) {
  // "Name=/path,Other=/other/path": folders shown in the folder picker
  const list = (v || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const i = s.indexOf('=');
    return i > 0 ? { name: s.slice(0, i).trim(), path: path.resolve(s.slice(i + 1).trim()) } : { name: path.basename(s) || s, path: path.resolve(s) };
  });
  return [{ name: 'Home', path: home, icon: 'home' }, ...list.map((p) => ({ ...p, icon: 'disk' }))];
}

export const config = {
  root: ROOT,
  host: env.HOST || '127.0.0.1',
  port: Number(env.PORT || 3010),
  stateDir: env.STATE_DIR || path.join(home, '.claude-hub'),
  // Claude Code binary. Empty = the CLI bundled with the Agent SDK.
  claudeBin: env.CLAUDE_BIN || (fs.existsSync(localClaude) ? localClaude : undefined),
  places: parsePlaces(env.PLACES),
  // Optional web terminal shown as a tab, e.g. "{proto}//{host}:7681/"
  terminalUrl: env.TERMINAL_URL || null,
  displayName: env.DISPLAY_NAME || os.userInfo().username,
  // Auth: password (built-in login), proxy (a reverse proxy already authenticates), none (localhost only)
  password: env.AUTH_PASSWORD || '',
  trustProxy: env.AUTH_MODE === 'proxy',
  idleCloseMin: Number(env.IDLE_CLOSE_MIN || 30),
  notify: {
    telegramToken: env.TELEGRAM_BOT_TOKEN || '',
    telegramChat: env.TELEGRAM_CHAT_ID || '',
    ntfyUrl: env.NTFY_URL || '',
    command: env.NOTIFY_COMMAND || '',
  },
};
config.auth = config.password ? 'password' : config.trustProxy ? 'proxy' : 'none';

const loopback = ['127.0.0.1', '::1', 'localhost'].includes(config.host);
if (config.auth === 'none' && !loopback) {
  console.error(`Refusing to listen on ${config.host} without authentication.\nSet AUTH_PASSWORD, or AUTH_MODE=proxy if a reverse proxy handles login, or use HOST=127.0.0.1.`);
  process.exit(1);
}
