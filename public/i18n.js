// Translations. The UI source text is Indonesian; this maps it to English.
// Language: saved choice, otherwise the browser language (id → Indonesian, everything else → English).
let saved = null;
try { saved = localStorage.getItem('ch.lang'); } catch {}
export const LANG = saved || ((navigator.language || 'en').toLowerCase().startsWith('id') ? 'id' : 'en');
document.documentElement.lang = LANG;

export function setLang(l) { try { localStorage.setItem('ch.lang', l); } catch {} location.reload(); }

const EN = {
  // sidebar & header
  'Sesi baru': 'New session', 'Cari sesi': 'Search sessions', 'Tutup sidebar': 'Hide sidebar', 'Sidebar': 'Sidebar',
  'Muat ulang daftar': 'Reload list', 'Batas pemakaian': 'Usage limits', 'Info sesi': 'Session info',
  'Chat': 'Chat', 'File': 'Files', 'Perubahan': 'Changes', 'Terminal': 'Terminal',
  'Belum ada proyek. Mulai sesi baru.': 'No projects yet. Start a new session.', 'Belum ada sesi': 'No sessions yet',
  'Disematkan': 'Pinned', 'Sesi baru di folder ini': 'New session in this folder', 'Lainnya': 'More',
  'Lepas sematan': 'Unpin', 'Sematkan di atas': 'Pin to top', 'Buka di tab File': 'Open in Files tab', 'Salin path': 'Copy path',
  'Ganti nama…': 'Rename…', 'Hentikan proses': 'Stop process', 'Hapus sesi…': 'Delete session…', 'Nama sesi': 'Session name',
  'Belum login Claude': 'Claude not signed in', 'Bahasa': 'Language', 'Pengaturan': 'Settings', 'Keluar': 'Sign out', 'Muat ulang': 'Reload',
  // empty state
  'Mau mengerjakan apa?': 'What are we building?', 'Pilih folder kerja, lalu tulis permintaanmu di bawah.': 'Pick a working folder, then type your request below.',
  'Pilih folder lain…': 'Choose another folder…', 'home, files, sites, backup': 'Browse the server',
  // composer
  'Tanya Claude, / untuk perintah, @ untuk file': 'Ask Claude, / for commands, @ for files', 'Lampirkan gambar': 'Attach image',
  'Kirim (Enter)': 'Send (Enter)', 'Kirim': 'Send', 'Hentikan (Esc)': 'Stop (Esc)', 'Claude sedang bekerja…': 'Claude is working…',
  'Ke bawah': 'Jump to bottom', 'Ringkas percakapan untuk menghemat konteks': 'Summarize the conversation to save context',
  'Mulai percakapan baru': 'Start a new conversation', 'Hanya gambar PNG, JPG, GIF, atau WEBP.': 'Only PNG, JPG, GIF or WEBP images.',
  // modes & effort
  'Tanya dulu': 'Ask first', 'Terima edit': 'Accept edits', 'Rencana': 'Plan', 'Otomatis': 'Auto', 'Bypass izin': 'Bypass permissions',
  'Minta izin sebelum mengedit atau menjalankan perintah': 'Asks before editing files or running commands',
  'Edit file langsung, perintah tetap minta izin': 'Edits files directly, still asks before commands',
  'Hanya membaca dan menyusun rencana, tanpa mengubah apa pun': 'Reads and plans only, changes nothing',
  'Pengaman otomatis menilai tiap tindakan, jarang bertanya': 'A safety classifier reviews each action, rarely asks',
  'Tanpa izin sama sekali. Berbahaya di server ini (sudo).': 'No permission checks at all. Dangerous on a server.',
  'Mode Bypass menjalankan semua perintah tanpa bertanya, termasuk sudo. Lanjutkan?': 'Bypass mode runs every command without asking, including sudo. Continue?',
  'Rendah': 'Low', 'Sedang': 'Medium', 'Tinggi': 'High', 'Sangat tinggi': 'Extra high', 'Maksimal': 'Max',
  'Default (rekomendasi)': 'Default (recommended)', 'Model lain': 'More models', 'Kembali': 'Back',
  'Daftar model belum termuat': 'Model list not loaded', 'Pastikan Claude sudah login di server': 'Make sure Claude is signed in on the server',
  // messages
  'Memuat…': 'Loading…', 'Sesi kosong.': 'Empty session.', 'Berpikir': 'Thinking', 'Berpikir…': 'Thinking…', 'Selesai': 'Done',
  'Salin': 'Copy', 'Disalin': 'Copied', 'Gagal menyalin': 'Copy failed', 'Kembalikan file ke titik ini': 'Restore files to this point',
  'Keluaran': 'Output', 'Galat': 'Error', 'Hasil': 'Result', 'subagen': 'subagents', 'Percakapan diringkas (compact).': 'Conversation compacted.',
  'perintah': 'commands', 'edit': 'edits', 'file ditulis': 'files written', 'file dibaca': 'files read', 'pencarian': 'searches',
  'halaman': 'pages', 'pencarian web': 'web searches', 'daftar tugas': 'todo updates', 'langkah': 'steps',
  // permissions
  'Claude minta izin': 'Claude needs permission', 'Claude punya pertanyaan': 'Claude has a question', 'Rencana siap ditinjau': 'Plan ready for review',
  'Jalankan perintah ini?': 'Run this command?', 'Buat / timpa file ini?': 'Create / overwrite this file?', 'Ubah file ini?': 'Edit this file?',
  'Ubah notebook ini?': 'Edit this notebook?', 'Buka halaman web ini?': 'Fetch this web page?', 'Cari di web?': 'Search the web?',
  'Baca file di luar folder kerja?': 'Read a file outside the working folder?',
  'Claude bertanya': 'Claude asks', 'Jawaban lain…': 'Other answer…', 'Lewati': 'Skip', 'Kirim jawaban': 'Send answer',
  'Rencana Claude': "Claude's plan", 'Masukan untuk rencana (opsional)': 'Feedback on the plan (optional)', 'Tetap rencanakan': 'Keep planning',
  'Setujui, tanya tiap edit': 'Approve, ask for each edit', 'Setujui & jalankan': 'Approve & run',
  'Alasan menolak / arahan lain (opsional)': 'Reason or other instructions (optional)', 'Tolak': 'Deny', 'Selalu izinkan': 'Always allow', 'Izinkan': 'Allow',
  'Pengguna melewati pertanyaan ini.': 'The user skipped this question.', 'Pengguna menolak tindakan ini.': 'The user denied this action.',
  'Pengguna ingin tetap merencanakan. Perbaiki rencananya dulu.': 'The user wants to keep planning. Revise the plan first.',
  // files & git
  'Folder kosong': 'Empty folder', 'Pilih file untuk melihat isinya': 'Select a file to preview it', 'Sebut di chat': 'Mention in chat',
  'Hanya 1 MB pertama yang ditampilkan.': 'Only the first 1 MB is shown.', 'Pesan commit': 'Commit message', 'Commit': 'Commit',
  'Folder ini bukan repositori git.': 'This folder is not a git repository.', 'Semua perubahan': 'All changes', 'Tidak ada perubahan.': 'No changes.',
  'Commit terakhir': 'Recent commits', 'Tidak ada diff.': 'No diff.', 'Tulis pesan commit dulu.': 'Write a commit message first.', 'Commit berhasil': 'Committed',
  // inspector
  'Lingkungan': 'Environment', 'bukan repo git': 'not a git repo', 'Sedang bekerja': 'Working', 'Menunggu izin': 'Waiting for permission', 'Aktif': 'Active',
  'Belum dimulai': 'Not started', 'Tidak aktif (lanjutkan dengan mengirim pesan)': 'Inactive (send a message to resume)', 'Konteks': 'Context',
  'Perbarui': 'Refresh', 'Data batas tidak tersedia untuk akun ini.': 'Limits are not available for this account.',
  'Sesi ini': 'This session', 'Giliran': 'Turns', 'Token keluar': 'Output tokens', 'Waktu kerja': 'Working time', 'Setara biaya API': 'API cost equivalent',
  'Tugas': 'Tasks', 'Sesi 5 jam': '5-hour session', 'Mingguan': 'Weekly',
  // picker & rewind
  'Pilih folder kerja': 'Choose a working folder', 'Lokasi': 'Locations', 'Proyek': 'Projects', 'Folder baru': 'New folder', 'Batal': 'Cancel', 'Pilih': 'Choose',
  'Nama folder baru': 'New folder name', 'Tidak ada subfolder': 'No subfolders',
  'Kirim pesan dulu agar sesi aktif, lalu coba lagi.': 'Send a message first so the session is active, then try again.',
  'Tidak bisa mengembalikan file ke titik ini.': 'Cannot restore files to this point.', 'File sudah dikembalikan.': 'Files restored.',
  'Claude selesai': 'Claude finished',
  // login
  'Masuk': 'Sign in', 'Kata sandi': 'Password', 'Kata sandi salah.': 'Wrong password.', 'Terlalu banyak percobaan. Tunggu sebentar.': 'Too many attempts. Please wait.',
};

const PATTERNS = [
  [/^Tampilkan semua \((\d+)\)$/, 'Show all ($1)'],
  [/^(\d+) token ditulis$/, '$1 tokens written'],
  [/^([\d.,]+\s?\S*) token ditulis$/, '$1 tokens written'],
  [/^Berhenti: dihentikan$/, 'Stopped'],
  [/^Berhenti: (.*)$/, 'Stopped: $1'],
  [/^· (\d+) berubah$/, '· $1 changed'],
  [/^(\d+)% terpakai$/, '$1% used'],
  [/^Paket: (.*)$/, 'Plan: $1'],
  [/^Reset (.*)$/, 'Resets $1'],
  [/^Mingguan (.*)$/, 'Weekly $1'],
  [/^File biner \((.*)\)$/, 'Binary file ($1)'],
  [/^Gagal memuat: (.*)$/, 'Failed to load: $1'],
  [/^Hapus sesi "(.*)"\? Riwayatnya tidak bisa dikembalikan\.$/s, 'Delete session "$1"? Its history cannot be recovered.'],
  [/^Commit semua perubahan \((\d+) file\) dengan pesan:\n\n([\s\S]*)$/, 'Commit all changes ($1 files) with message:\n\n$2'],
  [/^Kembalikan (\d+) file ke keadaan sebelum pesan ini\?\n\(\+(\d+) \/ -(\d+) baris\)\. Percakapan tidak dihapus\.$/, 'Restore $1 files to their state before this message?\n(+$2 / -$3 lines). The conversation is kept.'],
  [/^\n… \((\d+) baris lagi\)$/, '\n… ($1 more lines)'],
  [/^Mencoba ulang ke API \((.*)\)…$/, 'Retrying the API ($1)…'],
];

/** Translate a UI string (keeps surrounding whitespace). */
export function tr(s) {
  if (LANG === 'id' || typeof s !== 'string' || !s) return s;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  const core = m[2];
  if (EN[core] != null) return m[1] + EN[core] + m[3];
  for (const [re, rep] of PATTERNS) if (re.test(core)) return m[1] + core.replace(re, rep) + m[3];
  return s;
}

/** Translate static text in index.html. */
export function translateDom(root = document.body) {
  if (LANG === 'id') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) { const t = tr(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t; }
  for (const el of root.querySelectorAll('[title],[placeholder]')) {
    for (const a of ['title', 'placeholder']) if (el.hasAttribute(a)) el.setAttribute(a, tr(el.getAttribute(a)));
  }
}

/** Units for durations and relative times. */
export const U = LANG === 'id'
  ? { s: 'dtk', m: 'mnt', h: 'j', now: 'baru', yest: 'kemarin', d: 'hr', locale: 'id-ID', k: 'rb', M: 'jt' }
  : { s: 's', m: 'min', h: 'h', now: 'now', yest: 'yesterday', d: 'd', locale: 'en-GB', k: 'k', M: 'M' };

const SINGULAR = { commands: 'command', edits: 'edit', 'files written': 'file written', 'files read': 'file read', searches: 'search', pages: 'page', 'web searches': 'web search', 'todo updates': 'todo update', steps: 'step', subagents: 'subagent' };
/** "3 commands" / "1 command" in English; Indonesian has no plural form. */
export function plural(n, word) { const w = tr(word); return LANG === 'en' && n === 1 ? (SINGULAR[w] || w) : w; }
