// Scaffolds a new game from templates/starter and links it into the workspace.
// Usage: npm run new-game -- "My Game Title"
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const title = process.argv.slice(2).join(' ').trim();
if (!title) {
  console.error('Usage: npm run new-game -- "My Game Title"');
  process.exit(1);
}

const slug = title
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');
if (!slug) {
  console.error('Pick a title with at least one letter or number in it.');
  process.exit(1);
}
const dir = path.join(root, 'games', slug);
if (fs.existsSync(dir)) {
  console.error(`games/${slug} already exists.`);
  process.exit(1);
}

// Placeholder values, escaped for the kind of file they land in.
const date = new Date().toISOString().slice(0, 10);
const escapers = {
  '.json': (s) => JSON.stringify(s).slice(1, -1),
  '.html': (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
};

function* files(d) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, entry.name);
    if (entry.isDirectory()) yield* files(p);
    else yield p;
  }
}

fs.cpSync(path.join(root, 'templates', 'starter'), dir, { recursive: true });
for (const file of files(dir)) {
  const escape = escapers[path.extname(file)] ?? ((s) => s);
  const text = fs.readFileSync(file, 'utf8');
  const filled = text
    .replaceAll('{{title}}', () => escape(title))
    .replaceAll('{{slug}}', () => slug)
    .replaceAll('{{date}}', () => date);
  if (filled !== text) fs.writeFileSync(file, filled);
}

console.log(`Created games/${slug}. Linking it into the workspace…\n`);
execSync('npm install', { cwd: root, stdio: 'inherit' });
console.log(`
✓ games/${slug} is ready.
  Play it while you work:  npm run dev -w games/${slug}
  Describe it:             games/${slug}/game.json (title, description, tags, cover)
  Publish:                 commit and push; it shows up on the launcher automatically.
`);
