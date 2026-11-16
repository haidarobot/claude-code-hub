import { tr, translateDom } from './i18n.js';

translateDom();
const form = document.getElementById('login');
const err = document.getElementById('err');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.hidden = true;
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pw').value }) });
  if (r.ok) { location.href = '/'; return; }
  const j = await r.json().catch(() => ({}));
  err.textContent = tr(j.error || 'Kata sandi salah.');
  err.hidden = false;
  form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake');
});
