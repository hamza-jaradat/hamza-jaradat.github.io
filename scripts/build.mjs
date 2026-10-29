// Builds the whole site into dist/, ready for GitHub Pages:
//   dist/index.html          the launcher page, rendered from hub/index.html
//   dist/games/<slug>/       each game: its build output, or its files if it has no build step
//   dist/covers/<slug>.<ext> cover images named in each game.json
//   dist/games.json          the game list as data
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gamesDir = path.join(root, 'games');
const hubDir = path.join(root, 'hub');
const out = path.join(root, 'dist');
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX = /^#[0-9a-f]{3,8}$/i;
const STATIC_IGNORE = new Set(['node_modules', '.git', 'game.json', 'package-lock.json']);
const FONTS = [
  ['orbitron', 600],
  ['orbitron', 800],
  ['rajdhani', 500],
  ['rajdhani', 700],
];

function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    // Strip a byte-order mark: some Windows editors add one, and JSON.parse rejects it.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`${path.relative(root, file)} is not valid JSON: ${err.message}`);
  }
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Short content hash, used as ?v= so browsers drop cached copies whenever a file changes
// (GitHub Pages lets browsers cache files for 10 minutes).
const fingerprint = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 8);

// Lets a game show an "All games" link only when it is served from the hub.
function addHubMeta(indexFile) {
  const html = fs.readFileSync(indexFile, 'utf8');
  if (html.includes('name="hub-url"')) return;
  fs.writeFileSync(indexFile, html.replace(/<\/head>/i, '  <meta name="hub-url" content="../../" />\n  </head>'));
}

function buildGame(slug) {
  const dir = path.join(gamesDir, slug);
  const meta = readJSON(path.join(dir, 'game.json'), null);
  if (!meta) {
    console.warn(`• skipping games/${slug}: no game.json`);
    return null;
  }
  if (!SLUG.test(slug)) {
    throw new Error(`games/${slug}: the folder name becomes the URL, so use lowercase letters, numbers and dashes`);
  }

  const target = path.join(out, 'games', slug);
  const pkg = readJSON(path.join(dir, 'package.json'), null);
  if (pkg?.scripts?.build) {
    console.log(`\n▸ ${slug}: npm run build`);
    execSync('npm run build', { cwd: dir, stdio: 'inherit' });
    const built = path.join(dir, meta.output ?? 'dist');
    if (!fs.existsSync(built)) {
      throw new Error(`games/${slug}: the build produced no ${path.relative(dir, built)}/ (set "output" in game.json)`);
    }
    fs.cpSync(built, target, { recursive: true });
  } else {
    console.log(`\n▸ ${slug}: static files`);
    fs.cpSync(dir, target, { recursive: true, filter: (src) => !STATIC_IGNORE.has(path.basename(src)) });
  }

  const index = path.join(target, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`games/${slug}: there is no index.html in the output`);
  addHubMeta(index);

  let cover = null;
  if (meta.cover) {
    const src = path.join(dir, meta.cover);
    if (!fs.existsSync(src)) throw new Error(`games/${slug}: cover image "${meta.cover}" not found`);
    cover = `covers/${slug}${path.extname(src).toLowerCase()}`;
    fs.mkdirSync(path.join(out, 'covers'), { recursive: true });
    fs.copyFileSync(src, path.join(out, cover));
    cover += `?v=${fingerprint(src)}`;
  }

  return {
    slug,
    title: meta.title || slug,
    description: meta.description || '',
    tags: Array.isArray(meta.tags) ? meta.tags.map(String) : [],
    controls: meta.controls || '',
    accent: HEX.test(meta.accent ?? '') ? meta.accent : null,
    added: String(meta.added ?? ''),
    hidden: !!meta.hidden,
    cover,
    url: `games/${slug}/`,
  };
}

// --- Launcher page markup ------------------------------------------------------
function cover(g, lazy) {
  const style = g.accent ? ` style="--accent: ${g.accent}"` : '';
  const inner = g.cover
    ? `<img src="${esc(g.cover)}" alt=""${lazy ? ' loading="lazy"' : ''} decoding="async" />`
    : `<span class="cover-letter" aria-hidden="true">${esc(g.title.charAt(0).toUpperCase())}</span>`;
  return `<div class="cover"${style}>${inner}</div>`;
}

const tagList = (tags) => (tags.length ? `<ul class="tags">${tags.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');

function hero(g) {
  return `
        <section class="hero" aria-labelledby="hero-title">
          <a class="hero-cover" href="${esc(g.url)}" tabindex="-1" aria-hidden="true">${cover(g, false)}</a>
          <div class="hero-body">
            <p class="eyebrow">Latest</p>
            <h2 id="hero-title">${esc(g.title)}</h2>
            <p class="hero-desc">${esc(g.description)}</p>
            ${tagList(g.tags)}
            ${g.controls ? `<p class="controls"><span>Controls</span> ${esc(g.controls)}</p>` : ''}
            <a class="play" href="${esc(g.url)}">Play now</a>
          </div>
        </section>`;
}

function card(g) {
  const search = [g.title, g.description, ...g.tags].join(' ').toLowerCase();
  const tags = g.tags.map((t) => t.toLowerCase()).join('|');
  return `
            <a class="card" href="${esc(g.url)}" data-search="${esc(search)}" data-tags="${esc(tags)}">
              ${cover(g, true)}
              <div class="card-body">
                <h3>${esc(g.title)}</h3>
                <p>${esc(g.description)}</p>
                ${tagList(g.tags)}
              </div>
            </a>`;
}

function toolbar(games) {
  // Filter case-insensitively, but label each chip the way the tag was first written.
  const labels = new Map();
  for (const t of games.flatMap((g) => g.tags)) if (!labels.has(t.toLowerCase())) labels.set(t.toLowerCase(), t);
  const chips = [...labels]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, label]) => `<button type="button" class="chip" data-tag="${esc(key)}" aria-pressed="false">${esc(label)}</button>`);
  return `
          <div class="toolbar">
            <input type="search" id="search" placeholder="Search games" aria-label="Search games" autocomplete="off" />
            <div class="chips" role="group" aria-label="Filter by tag">
              <button type="button" class="chip active" data-tag="" aria-pressed="true">All</button>
              ${chips.join('\n              ')}
            </div>
          </div>`;
}

function content(games) {
  if (games.length === 0) {
    return `
        <section class="empty">
          <h2>No games yet</h2>
          <p>Add a folder under <code>games/</code> with a <code>game.json</code>, then rebuild.</p>
        </section>`;
  }
  let html = hero(games[0]);
  if (games.length > 1) {
    html += `
        <section class="all" aria-labelledby="all-title">
          <h2 id="all-title">All games</h2>${games.length > 3 ? toolbar(games) : ''}
          <div class="grid" id="grid">${games.map(card).join('')}
          </div>
          <p class="no-match" id="no-match" hidden>No games match that search.</p>
        </section>`;
  }
  return html;
}

function copyFonts() {
  const dir = path.join(out, 'fonts');
  fs.mkdirSync(dir, { recursive: true });
  for (const [family, weight] of FONTS) {
    const src = path.join(root, 'node_modules', '@fontsource', family, 'files', `${family}-latin-${weight}-normal.woff2`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, `${family}-${weight}.woff2`));
    else console.warn(`• font ${family} ${weight} not found; run npm install`);
  }
}

// --- Build ---------------------------------------------------------------------
const site = { title: 'Arcade', tagline: '', ...readJSON(path.join(root, 'site.json'), {}) };

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(hubDir, out, { recursive: true });
copyFonts();

const slugs = fs.existsSync(gamesDir)
  ? fs
      .readdirSync(gamesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  : [];
const games = slugs.map(buildGame).filter(Boolean);
const listed = games
  .filter((g) => !g.hidden)
  .sort((a, b) => b.added.localeCompare(a.added) || a.title.localeCompare(b.title));

const count = `${listed.length} game${listed.length === 1 ? '' : 's'}`;
// Version the launcher's own files, so a new page never runs with a stale cached script.
const versioned = (match, attr, file) => {
  const local = path.join(hubDir, file);
  return fs.existsSync(local) ? `${attr}="${file}?v=${fingerprint(local)}"` : match;
};

// Replacer functions, so a "$" in a title or description is kept literally.
const page = fs
  .readFileSync(path.join(hubDir, 'index.html'), 'utf8')
  .replace(/\b(href|src)="([^"#?:]+\.(?:css|js|svg))"/g, versioned)
  .replaceAll('{{title}}', () => esc(site.title))
  .replaceAll('{{tagline}}', () => esc(site.tagline))
  .replaceAll('{{count}}', () => count)
  .replaceAll('{{year}}', () => String(new Date().getFullYear()))
  .replace('{{content}}', () => content(listed));
fs.writeFileSync(path.join(out, 'index.html'), page);
fs.writeFileSync(
  path.join(out, 'games.json'),
  JSON.stringify({ site, games: listed.map(({ hidden, ...g }) => g) }, null, 2),
);
fs.writeFileSync(path.join(out, '.nojekyll'), '');

const hiddenCount = games.length - listed.length;
console.log(`\n✓ Built ${count}${hiddenCount ? ` (+${hiddenCount} hidden)` : ''} into dist/`);
