// Push notifications when Claude needs permission or finishes a long task while
// nobody has the page open. Supports Telegram, ntfy, or any shell command.
import { execFile } from 'node:child_process';
import { config } from './config.js';

const n = config.notify;
let last = 0;

export const notifyEnabled = !!((n.telegramToken && n.telegramChat) || n.ntfyUrl || n.command);

export function notify(text) {
  if (!notifyEnabled || Date.now() - last < 3000) return;
  last = Date.now();
  const msg = `Claude Code Hub\n${text}`.slice(0, 3500);
  if (n.telegramToken && n.telegramChat) {
    fetch(`https://api.telegram.org/bot${n.telegramToken}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: n.telegramChat, text: msg, disable_web_page_preview: true }),
    }).catch((e) => console.error('notify telegram:', e.message));
  }
  if (n.ntfyUrl) fetch(n.ntfyUrl, { method: 'POST', body: msg, headers: { Title: 'Claude Code Hub' } }).catch((e) => console.error('notify ntfy:', e.message));
  if (n.command) {
    // The message is passed as the last argument, never through a shell.
    const [cmd, ...args] = n.command.split(/\s+/).filter(Boolean);
    execFile(cmd, [...args, msg], { timeout: 15000 }, (e) => { if (e) console.error('notify command:', e.message.split('\n')[0]); });
  }
}
