// Copies the two browser libraries from node_modules into public/vendor (runs after npm install).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });
const files = [
  ['node_modules/marked/lib/marked.umd.js', 'marked.min.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'purify.min.js'],
];
let copied = 0;
for (const [from, to] of files) {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) continue; // e.g. `npm install --package-lock-only`
  fs.copyFileSync(src, path.join(out, to));
  copied++;
}
console.log(`vendor: copied ${copied}/${files.length} files to public/vendor`);
