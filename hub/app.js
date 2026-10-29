// Search and tag filtering for the game grid (the build only adds the toolbar once there are 4+ games).
const grid = document.getElementById('grid');
const search = document.getElementById('search');

if (grid && search) {
  const cards = [...grid.querySelectorAll('.card')];
  const chips = [...document.querySelectorAll('.chip')];
  const noMatch = document.getElementById('no-match');
  let tag = '';

  const apply = () => {
    const query = search.value.trim().toLowerCase();
    let shown = 0;
    for (const card of cards) {
      const match =
        (!query || card.dataset.search.includes(query)) && (!tag || card.dataset.tags.split('|').includes(tag));
      card.hidden = !match;
      if (match) shown++;
    }
    noMatch.hidden = shown > 0;
  };

  search.addEventListener('input', apply);
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      tag = chip.dataset.tag;
      for (const c of chips) {
        c.classList.toggle('active', c === chip);
        c.setAttribute('aria-pressed', String(c === chip));
      }
      apply();
    });
  }
}

// --- Other arcades: read another arcade's games.json and list its games ---------------
// Remote lists are untrusted: cards are built with DOM APIs (no innerHTML), links must be
// http(s) and resolve against the remote address, and strings are length-capped.
const STORAGE_KEY = 'arcade:sources';
const TIMEOUT_MS = 6000;
// IP literals, localhost and .local names are recognised as local-network targets by browsers.
const LOCAL_HOST = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]|[^/:]+\.local)(?::\d+)?$/i;

const form = document.getElementById('connect');
const input = document.getElementById('connect-address');
const formError = document.getElementById('connect-error');
const sourcesEl = document.getElementById('sources');
const sources = new Map();

class ArcadeError extends Error {
  constructor(kind, status) {
    super(kind);
    this.kind = kind;
    this.status = status;
  }
}

function loadSaved() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...sources.keys()].reverse()));
  } catch {
    // storage unavailable: sources just won't be remembered
  }
}

// Accepts "192.168.1.20:8080", "my-pc.local:8080", "friend.github.io" or a full URL.
function toBase(text) {
  let s = text.trim();
  if (!s) throw new Error('empty');
  if (!/^https?:\/\//i.test(s)) {
    const hostPart = s.split('/')[0];
    const plain = LOCAL_HOST.test(hostPart) || /:\d+$/.test(hostPart);
    s = `${plain ? 'http' : 'https'}://${s}`;
  }
  const url = new URL(s);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/[^/]+\.(html?|json)$/i, '');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

async function fetchArcade(base) {
  const options = { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) };
  // Chrome lets this HTTPS page reach a plain-HTTP host name on the local network only with this hint.
  if (location.protocol === 'https:' && base.protocol === 'http:' && !LOCAL_HOST.test(base.host)) {
    options.targetAddressSpace = 'local';
  }
  const res = await fetch(new URL('games.json', base), options);
  if (!res.ok) throw new ArcadeError(res.status === 404 ? 'no-list' : 'http', res.status);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new ArcadeError('not-arcade');
  }
  return parseArcade(data, base);
}

function parseArcade(data, base) {
  if (!data || !Array.isArray(data.games)) throw new ArcadeError('not-arcade');
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const link = (v) => {
    if (typeof v !== 'string' || !v) return null;
    try {
      const url = new URL(v, base);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  };
  const games = [];
  for (const g of data.games.slice(0, 200)) {
    const url = link(g?.url);
    if (!url) continue;
    games.push({
      url,
      title: text(g.title, 80) || 'Untitled',
      description: text(g.description, 280),
      tags: Array.isArray(g.tags) ? g.tags.filter((t) => typeof t === 'string').slice(0, 8).map((t) => t.slice(0, 24)) : [],
      cover: link(g.cover),
      accent: /^#[0-9a-f]{3,8}$/i.test(g.accent ?? '') ? g.accent : null,
    });
  }
  return { title: text(data.site?.title, 60), games };
}

function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content != null) node.textContent = content;
  return node;
}

function remoteCard(g) {
  const card = el('a', 'card');
  card.href = g.url;
  const cover = el('div', 'cover');
  if (g.accent) cover.style.setProperty('--accent', g.accent);
  const letter = () => cover.replaceChildren(el('span', 'cover-letter', g.title.charAt(0).toUpperCase()));
  if (g.cover) {
    const img = el('img');
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', letter, { once: true });
    img.src = g.cover;
    cover.append(img);
  } else {
    letter();
  }
  const body = el('div', 'card-body');
  body.append(el('h3', null, g.title));
  if (g.description) body.append(el('p', null, g.description));
  if (g.tags.length) {
    const tags = el('ul', 'tags');
    for (const t of g.tags) tags.append(el('li', null, t));
    body.append(tags);
  }
  card.append(cover, body);
  return card;
}

function explain(err, base) {
  const where = base.host;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return `No answer from ${where}. Check the address, that both devices are on the same network, and that it's running npm run serve.`;
  }
  if (err instanceof ArcadeError) {
    if (err.kind === 'no-list') return `${where} answered, but has no game list (games.json), so it isn't an arcade.`;
    if (err.kind === 'not-arcade') return `${where} answered, but not with an arcade game list.`;
    return `${where} answered with an error (HTTP ${err.status}).`;
  }
  if (location.protocol === 'https:' && base.protocol === 'http:') {
    return `Your browser blocked this secure page from reading ${where}. In Chrome or Edge, allow access to devices on your local network when asked (or in this site's settings). In any browser, Open visits that arcade directly.`;
  }
  return `Couldn't read games from ${where}. Make sure it's running npm run serve (which lets other arcades read it) and that both devices are on the same network.`;
}

function sourceView(href) {
  let view = sources.get(href);
  if (view) return view;
  const section = el('section', 'source');
  const head = el('div', 'source-head');
  const names = el('div', 'source-names');
  const title = el('h3', null, new URL(href).host);
  names.append(title, el('p', 'source-addr', href));
  const actions = el('div', 'source-actions');
  const retry = el('button', 'ghost', 'Retry');
  retry.type = 'button';
  retry.hidden = true;
  const open = el('a', 'ghost', 'Open');
  open.href = href;
  open.target = '_blank';
  open.rel = 'noopener';
  const remove = el('button', 'ghost', 'Remove');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove ${href}`);
  actions.append(retry, open, remove);
  head.append(names, actions);
  const status = el('p', 'source-status');
  status.setAttribute('role', 'status');
  const games = el('div', 'grid');
  section.append(head, status, games);
  sourcesEl.prepend(section);

  view = { section, title, status, games, retry };
  retry.addEventListener('click', () => connect(href));
  remove.addEventListener('click', () => {
    section.remove();
    sources.delete(href);
    save();
  });
  sources.set(href, view);
  return view;
}

async function connect(href) {
  const view = sourceView(href);
  const base = new URL(href);
  view.status.hidden = false;
  view.status.classList.remove('error');
  view.status.textContent = 'Connecting…';
  view.retry.hidden = true;
  view.games.replaceChildren();
  try {
    const arcade = await fetchArcade(base);
    if (arcade.title) view.title.textContent = arcade.title;
    view.games.replaceChildren(...arcade.games.map(remoteCard));
    view.status.textContent = arcade.games.length ? '' : 'Connected, but this arcade has no games listed yet.';
    view.status.hidden = arcade.games.length > 0;
  } catch (err) {
    view.status.classList.add('error');
    view.status.textContent = explain(err, base);
    view.retry.hidden = false;
  }
}

if (form) {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    formError.hidden = true;
    let base;
    try {
      base = toBase(input.value);
    } catch {
      formError.textContent = 'Enter an address like 192.168.1.20:8080 or a URL.';
      formError.hidden = false;
      return;
    }
    if (base.href === new URL('./', location.href).href) {
      formError.textContent = "That's this arcade.";
      formError.hidden = false;
      return;
    }
    input.value = '';
    sources.get(base.href)?.section.remove();
    sources.delete(base.href);
    connect(base.href);
    save();
  });

  for (const href of loadSaved().reverse()) connect(href);
}
