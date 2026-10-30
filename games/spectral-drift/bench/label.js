// The label page: listen to a song, compare the analysis with your labels, fix them, save.
// Served by the game's dev server at /bench/label.html (see devServer.js).
import { analyzeBuffer } from '../src/audio/analyzer.js';
import { normalizeLabels } from './labels.js';
import { METRICS, overall, scoreSong } from './metrics.js';

const $ = (id) => document.getElementById(id);
const COLORS = { analysis: '#5fe1ff', labels: '#ff3fa4', drop: '#ffd66e' };
const key = (t) => Math.round(t * 1000);

const state = {
  file: null,
  buffer: null,
  analysis: null,
  labels: {},
  saved: '{}',
  undo: [],
  selected: null, // { kind: 'beats' | 'sections' | 'drops', index }
  span: 12, // seconds shown in the detail view
  playing: false,
  offset: 0, // the playhead while paused
  startedAt: 0, // audio-clock time at which the song's t = 0 played
  source: null,
  clickedUpTo: 0,
};
let audio = null;

init();

async function init() {
  wire();
  try {
    const { dir, songs } = await (await fetch('/__bench/songs')).json();
    $('folder').textContent = dir;
    renderSongs(songs);
  } catch {
    $('folder').textContent = 'unavailable: open this page through the game\'s dev server (npm run dev)';
  }
  requestAnimationFrame(frame);
}

function renderSongs(songs) {
  $('empty').hidden = songs.length > 0;
  $('songs').replaceChildren(
    ...songs.map(({ file, labeled }) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.file = file;
      btn.textContent = file;
      if (labeled) btn.append(Object.assign(document.createElement('span'), { className: 'done', textContent: ' ✓' }));
      btn.addEventListener('click', () => openSong(file));
      li.append(btn);
      return li;
    }),
  );
  markCurrent();
}

function markCurrent() {
  for (const btn of $('songs').querySelectorAll('button')) btn.classList.toggle('current', btn.dataset.file === state.file);
}

async function openSong(file) {
  if (dirty() && !confirm('Discard your unsaved changes?')) return;
  pause();
  Object.assign(state, { file, buffer: null, analysis: null, labels: {}, saved: '{}', undo: [], selected: null, offset: 0 });
  $('editor').hidden = false;
  $('title').textContent = file;
  markCurrent();
  try {
    setStatus('Loading…');
    audio ??= new AudioContext();
    const bytes = await (await fetch(`/__bench/audio?file=${encodeURIComponent(file)}`)).arrayBuffer();
    const buffer = await audio.decodeAudioData(bytes);
    if (state.file !== file) return;
    state.buffer = buffer;
    const analysis = await analyzeBuffer(buffer, (p) => state.file === file && setStatus(`Analyzing… ${Math.round(p * 100)}%`));
    const { labels } = await (await fetch(`/__bench/labels?file=${encodeURIComponent(file)}`)).json();
    if (state.file !== file) return;
    state.analysis = analysis;
    state.labels = labels ?? {};
    state.saved = JSON.stringify(normalizeLabels(state.labels));
    refresh();
  } catch (err) {
    if (state.file === file) setStatus(`Couldn't open this song: ${err.message}`);
  }
}

// --- Playback ---------------------------------------------------------------------

const duration = () => state.buffer?.duration ?? 0;
const time = () => (state.playing ? audio.currentTime - state.startedAt : state.offset);

function play() {
  if (!state.buffer || state.playing) return;
  audio.resume();
  const from = Math.min(Math.max(0, state.offset), Math.max(0, duration() - 0.05));
  const src = audio.createBufferSource();
  src.buffer = state.buffer;
  src.connect(audio.destination);
  src.start(0, from);
  src.onended = () => {
    if (state.source !== src) return;
    state.offset = duration();
    state.playing = false;
    state.source = null;
    $('play').textContent = 'Play';
  };
  Object.assign(state, { source: src, playing: true, startedAt: audio.currentTime - from, clickedUpTo: from });
  $('play').textContent = 'Pause';
}

function pause() {
  if (!state.playing) return;
  state.offset = time();
  state.source.onended = null;
  state.source.stop();
  Object.assign(state, { source: null, playing: false });
  $('play').textContent = 'Play';
}

function seek(t) {
  const wasPlaying = state.playing;
  pause();
  state.offset = Math.min(Math.max(0, t), duration());
  if (wasPlaying) play();
}

// Metronome clicks on your beats (higher on downbeats), scheduled just ahead of the music.
function scheduleClicks() {
  if (!state.playing || !$('clicks').checked) return;
  const now = time();
  const until = now + 0.2;
  const downs = new Set((state.labels.downbeats ?? []).map(key));
  for (const b of state.labels.beats ?? []) {
    if (b >= until) break;
    if (b < state.clickedUpTo || b < now - 0.01) continue;
    const at = state.startedAt + b;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = downs.has(key(b)) ? 1760 : 1100;
    gain.gain.setValueAtTime(0.3, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + 0.06);
  }
  state.clickedUpTo = Math.max(state.clickedUpTo, until);
}

// --- Editing -------------------------------------------------------------------------

function edit(change) {
  state.undo.push(JSON.stringify(state.labels));
  if (state.undo.length > 200) state.undo.shift();
  const labels = structuredClone(state.labels);
  change(labels);
  state.labels = labels;
  refresh();
}

const sorted = (list) => [...list].sort((a, b) => a - b);
const nearestIndex = (list, t) => {
  let best = -1;
  for (let i = 0; i < list.length; i++) if (best < 0 || Math.abs(list[i] - t) < Math.abs(list[best] - t)) best = i;
  return best;
};

// Where a section or drop marked at t belongs: the nearest bar line, or else the nearest
// beat, when one is close (pressing a key a moment late still lands on the bar).
function snap(t) {
  const { beats = [], downbeats = [] } = state.labels;
  const bar = downbeats.length > 1 ? (downbeats[downbeats.length - 1] - downbeats[0]) / (downbeats.length - 1) : 2;
  const d = nearestIndex(downbeats, t);
  if (d >= 0 && Math.abs(downbeats[d] - t) < 0.5 * bar) return downbeats[d];
  const b = nearestIndex(beats, t);
  if (b >= 0 && Math.abs(beats[b] - t) < 0.25) return beats[b];
  return t;
}

const ACTIONS = {
  'from-analysis'() {
    const a = state.analysis;
    if (!a) return;
    if (Object.keys(normalizeLabels(state.labels)).length && !confirm('Replace your labels with the analysis?')) return;
    edit((l) => {
      for (const k of Object.keys(l)) delete l[k];
      l.beats = Array.from(a.beats);
      l.downbeats = Array.from(a.downbeats);
      l.sections = a.sections.map((s) => ({ start: s.start, label: s.drop ? 'drop' : s.build ? 'build' : s.breakdown ? 'breakdown' : s.kind }));
      l.drops = Array.from(a.drops);
    });
  },
  'nudge-back': () => shiftBeats(-0.01),
  'nudge-fwd': () => shiftBeats(0.01),
  double() {
    edit((l) => {
      const b = l.beats ?? [];
      l.beats = b.flatMap((t, i) => (i < b.length - 1 ? [t, (t + b[i + 1]) / 2] : [t]));
    });
  },
  half() {
    edit((l) => {
      const b = l.beats ?? [];
      const downs = new Set((l.downbeats ?? []).map(key));
      const phase = Math.max(0, b.findIndex((t) => downs.has(key(t)))) % 2;
      l.beats = b.filter((_, i) => i % 2 === phase);
      const kept = new Set(l.beats.map(key));
      l.downbeats = (l.downbeats ?? []).filter((t) => kept.has(key(t)));
    });
  },
  'add-beat'() {
    const t = time();
    edit((l) => {
      l.beats = l.beats ?? [];
      if (!l.beats.some((b) => Math.abs(b - t) < 0.02)) l.beats = sorted([...l.beats, t]);
    });
  },
  'toggle-down'() {
    const t = time();
    edit((l) => {
      l.beats = l.beats ?? [];
      let i = nearestIndex(l.beats, t);
      if (i < 0 || Math.abs(l.beats[i] - t) > 0.25) {
        l.beats = sorted([...l.beats, t]);
        i = l.beats.indexOf(t);
      }
      const b = l.beats[i];
      const downs = l.downbeats ?? [];
      l.downbeats = downs.some((d) => key(d) === key(b)) ? downs.filter((d) => key(d) !== key(b)) : sorted([...downs, b]);
    });
  },
  'bars-here'() {
    const t = time();
    edit((l) => {
      const b = l.beats ?? [];
      const k = nearestIndex(b, t);
      if (k < 0) return;
      l.downbeats = [...(l.downbeats ?? []).filter((d) => d < b[k] - 0.01), ...b.filter((_, i) => i >= k && (i - k) % 4 === 0)];
    });
  },
  section() {
    const t = snap(time());
    const secs = state.labels.sections ?? [];
    const near = secs.findIndex((s) => Math.abs(s.start - t) < 0.3);
    const name = prompt(near >= 0 ? 'Rename this section:' : 'Name of the section that starts here:', near >= 0 ? secs[near].label : String.fromCharCode(65 + Math.min(25, secs.length)));
    if (name === null) return;
    edit((l) => {
      l.sections = l.sections ?? [];
      if (near >= 0) l.sections[near].label = name;
      else {
        if (!l.sections.some((s) => s.start <= 1) && t > 1) l.sections.push({ start: 0, label: 'intro' });
        l.sections.push({ start: t, label: name });
        l.sections.sort((a, b) => a.start - b.start);
      }
    });
  },
  drop() {
    const t = snap(time());
    edit((l) => {
      const drops = l.drops ?? [];
      const near = drops.findIndex((d) => Math.abs(d - t) < 0.5);
      l.drops = near >= 0 ? drops.filter((_, i) => i !== near) : sorted([...drops, t]);
    });
  },
  delete() {
    const sel = state.selected;
    if (!sel) return;
    state.selected = null;
    edit((l) => {
      const list = l[sel.kind];
      if (!list) return;
      const [removed] = list.splice(sel.index, 1);
      if (sel.kind === 'beats' && l.downbeats) l.downbeats = l.downbeats.filter((d) => key(d) !== key(removed));
    });
  },
  undo() {
    if (!state.undo.length) return;
    state.labels = JSON.parse(state.undo.pop());
    state.selected = null;
    refresh();
  },
  async save() {
    if (!state.file) return;
    const file = state.file;
    setStatus('Saving…');
    try {
      const res = await fetch(`/__bench/labels?file=${encodeURIComponent(file)}`, { method: 'PUT', body: JSON.stringify(normalizeLabels(state.labels)) });
      if (!res.ok) throw new Error((await res.json()).error);
      const { labels } = await res.json();
      if (state.file !== file) return;
      // Keep what the file now holds (times rounded to 0.1 ms), so it reads as saved.
      state.labels = labels;
      state.saved = JSON.stringify(normalizeLabels(labels));
      const { songs } = await (await fetch('/__bench/songs')).json();
      renderSongs(songs);
      refresh();
    } catch (err) {
      setStatus(`Couldn't save: ${err.message}`);
    }
  },
};

function shiftBeats(dt) {
  edit((l) => {
    if (l.beats) l.beats = l.beats.map((t) => t + dt);
    if (l.downbeats) l.downbeats = l.downbeats.map((t) => t + dt);
  });
}

function nudgeSelected(dt) {
  const sel = state.selected;
  if (!sel) return;
  edit((l) => {
    const list = l[sel.kind];
    if (sel.kind === 'sections') list[sel.index].start += dt;
    else {
      const old = list[sel.index];
      list[sel.index] = old + dt;
      if (sel.kind === 'beats' && l.downbeats) l.downbeats = l.downbeats.map((d) => (key(d) === key(old) ? old + dt : d));
    }
  });
}

// The mark nearest time t in your lane, within `tol` seconds (drops and sections first).
function markAt(t, tol) {
  for (const kind of ['drops', 'sections', 'beats']) {
    const times = (state.labels[kind] ?? []).map((m) => (kind === 'sections' ? m.start : m));
    const i = nearestIndex(times, t);
    if (i >= 0 && Math.abs(times[i] - t) <= tol) return { kind, index: i };
  }
  return null;
}

// --- Drawing ---------------------------------------------------------------------------

function frame() {
  scheduleClicks();
  drawOverview();
  drawDetail();
  $('time').textContent = `${clock(time())} / ${clock(duration())}`;
  requestAnimationFrame(frame);
}

function surface(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}

function drawIntensity(g, x, t0, t1, h, alpha) {
  const a = state.analysis;
  if (!a) return;
  g.fillStyle = `rgba(155, 102, 255, ${alpha})`;
  g.beginPath();
  g.moveTo(x(t0), h);
  const step = Math.max(1, Math.floor(((t1 - t0) * a.frameRate) / 600));
  for (let f = Math.max(0, Math.floor(t0 * a.frameRate)); f < Math.min(a.intensity.length, t1 * a.frameRate); f += step) {
    g.lineTo(x(f / a.frameRate), h - a.intensity[f] * h * 0.9);
  }
  g.lineTo(x(t1), h);
  g.fill();
}

function drawOverview() {
  const { g, w, h } = surface($('overview'));
  if (!state.analysis) return;
  const d = duration();
  const x = (t) => (t / d) * w;
  drawIntensity(g, x, 0, d, h, 0.45);
  const secs = state.labels.sections ?? [];
  secs.forEach((s, i) => {
    g.fillStyle = COLORS.labels;
    g.fillRect(x(s.start), 0, 1, h);
    if (i % 2) {
      g.fillStyle = 'rgba(255, 255, 255, 0.06)';
      g.fillRect(x(s.start), 0, x(secs[i + 1]?.start ?? d) - x(s.start), h);
    }
  });
  for (const t of state.analysis.drops) triangle(g, x(t), h, -7, COLORS.analysis);
  for (const t of state.labels.drops ?? []) triangle(g, x(t), 0, 7, COLORS.drop);
  const t0 = time() - state.span * 0.25;
  g.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  g.strokeRect(x(t0) + 0.5, 0.5, x(t0 + state.span) - x(t0), h - 1);
  g.fillStyle = '#fff';
  g.fillRect(x(time()), 0, 1.5, h);
}

function drawDetail() {
  const { g, w, h } = surface($('detail'));
  if (!state.analysis) return;
  const t0 = time() - state.span * 0.25;
  const t1 = t0 + state.span;
  const x = (t) => ((t - t0) / state.span) * w;
  drawIntensity(g, x, t0, t1, h, 0.16);
  g.font = '11px system-ui, sans-serif';
  g.fillStyle = 'rgba(255, 255, 255, 0.4)';
  for (let s = Math.ceil(Math.max(0, t0)); s < t1; s++) {
    g.fillRect(x(s), h - 4, 1, 4);
    if (s % 5 === 0) g.fillText(clock(s).replace(/\.\d$/, ''), x(s) + 3, h - 6);
  }
  const a = state.analysis;
  const lane = (h - 14) / 2;
  drawLane(g, x, w, 0, lane, { beats: a.beats, downbeats: a.downbeats, sections: a.sections.map((s) => ({ start: s.start, label: s.drop ? 'drop' : s.build ? 'build' : s.kind })), drops: a.drops }, COLORS.analysis, 'Analysis');
  drawLane(g, x, w, lane + 2, lane, state.labels, COLORS.labels, 'Your labels', state.selected);
  g.fillStyle = '#fff';
  g.fillRect(x(time()) - 0.5, 0, 1.5, h);
}

function drawLane(g, x, w, y, h, marks, color, name, selected) {
  // The song's high points (osu! kiai), as a faint gold band.
  g.fillStyle = 'rgba(255, 214, 110, 0.1)';
  for (const hl of marks.highlights ?? []) g.fillRect(x(hl.start), y, x(hl.end) - x(hl.start), h);
  const secs = marks.sections ?? [];
  secs.forEach((s, i) => {
    const a = x(s.start);
    const b = x(secs[i + 1]?.start ?? duration());
    if (b < 0 || a > w) return;
    if (i % 2) {
      g.fillStyle = 'rgba(255, 255, 255, 0.05)';
      g.fillRect(a, y, b - a, h);
    }
    g.fillStyle = color;
    g.fillRect(a - 1, y, 2, h);
    g.fillStyle = 'rgba(255, 255, 255, 0.85)';
    g.fillText(s.label, Math.max(a + 5, 5), y + 30);
    if (selected?.kind === 'sections' && selected.index === i) outline(g, a - 4, y, 8, h);
  });
  const downs = new Set(Array.from(marks.downbeats ?? [], key));
  g.fillStyle = color;
  const beats = marks.beats ?? [];
  for (let i = 0; i < beats.length; i++) {
    const px = x(beats[i]);
    if (px < -2 || px > w + 2) continue;
    const down = downs.has(key(beats[i]));
    g.globalAlpha = down ? 1 : 0.6;
    g.fillRect(px - (down ? 1 : 0.5), down ? y + h * 0.35 : y + h * 0.65, down ? 2 : 1, down ? h * 0.65 : h * 0.35);
    if (selected?.kind === 'beats' && selected.index === i) outline(g, px - 4, y + h * 0.3, 8, h * 0.7);
  }
  g.globalAlpha = 1;
  (marks.drops ?? []).forEach((t, i) => {
    const px = x(t);
    g.fillStyle = COLORS.drop;
    g.fillRect(px - 1, y, 2, h);
    triangle(g, px, y, 8, COLORS.drop);
    if (selected?.kind === 'drops' && selected.index === i) outline(g, px - 5, y, 10, h);
  });
  g.fillStyle = 'rgba(11, 7, 22, 0.7)';
  g.fillRect(4, y + 3, g.measureText(name).width + 8, 15);
  g.fillStyle = color;
  g.fillText(name, 8, y + 14);
}

function triangle(g, px, y, size, color) {
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(px - Math.abs(size) * 0.6, y);
  g.lineTo(px + Math.abs(size) * 0.6, y);
  g.lineTo(px, y + size);
  g.fill();
}

function outline(g, x, y, w, h) {
  g.strokeStyle = '#fff';
  g.lineWidth = 1.5;
  g.strokeRect(x, y + 1, w, h - 2);
}

// --- Page ---------------------------------------------------------------------------------

function refresh() {
  const l = state.labels;
  $('no-drops').checked = Array.isArray(l.drops) && l.drops.length === 0;
  $('no-drops').disabled = (l.drops?.length ?? 0) > 0;
  const has = Object.keys(normalizeLabels(l)).length > 0;
  setStatus(dirty() ? 'Unsaved changes' : has ? 'Saved' : 'Not labeled yet: start by copying the analysis, then fix what it got wrong.', dirty());
  renderScores();
}

function renderScores() {
  const table = $('scores');
  const score = state.analysis ? scoreSong(normalizeLabels(state.labels), state.analysis) : {};
  const rows = METRICS.filter((m) => score[m.key] !== undefined).map((m) => [m.label, score[m.key].toFixed(3), m.hint]);
  if (score.beatMode && score.beatMode !== 'as found' && score.beatAnyF > score.beatF + 0.05) rows.push(['', '', `The analysis's beats fit best at ${score.beatMode}.`]);
  if (score.beatShift !== undefined) rows.push(['Beat timing', `${score.beatShift > 0 ? '+' : ''}${Math.round(score.beatShift)} ms`, 'how late the analysis\'s beats sit against yours, typically']);
  if (rows.length) rows.push(['Overall', overall(score).toFixed(3), 'weighted mean, as the benchmark scores it']);
  table.replaceChildren(
    ...(rows.length ? rows : [['', '', 'Add labels to see how the analysis scores against them.']]).map((cells) => {
      const tr = document.createElement('tr');
      cells.forEach((c, i) => tr.append(Object.assign(document.createElement(i ? 'td' : 'th'), { textContent: c })));
      return tr;
    }),
  );
}

function dirty() {
  return state.file !== null && JSON.stringify(normalizeLabels(state.labels)) !== state.saved;
}

function setStatus(text, warn = false) {
  $('status').textContent = text;
  $('status').classList.toggle('dirty', warn);
}

function clock(t) {
  const m = Math.floor(t / 60);
  return `${m}:${(t - 60 * m).toFixed(1).padStart(4, '0')}`;
}

function wire() {
  $('play').addEventListener('click', () => (state.playing ? pause() : play()));
  $('zoom-in').addEventListener('click', () => (state.span = Math.max(3, state.span / 1.5)));
  $('zoom-out').addEventListener('click', () => (state.span = Math.min(120, state.span * 1.5)));
  $('no-drops').addEventListener('change', (e) =>
    edit((l) => {
      if (e.target.checked) l.drops = [];
      else delete l.drops;
    }),
  );
  for (const btn of document.querySelectorAll('[data-act]')) btn.addEventListener('click', () => ACTIONS[btn.dataset.act]());

  $('overview').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * duration());
  });
  $('detail').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = time() - state.span * 0.25 + ((e.clientX - r.left) / r.width) * state.span;
    const hit = e.clientY - r.top > r.height / 2 ? markAt(t, (8 / r.width) * state.span) : null;
    state.selected = hit;
    if (!hit) seek(t);
  });

  window.addEventListener('keydown', (e) => {
    if (!state.analysis || e.target.matches?.('input[type="text"], textarea')) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 's') ACTIONS.save();
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') ACTIONS.undo();
    else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (k === ' ') state.playing ? pause() : play();
    else if (k === 'ArrowLeft' || k === 'ArrowRight') {
      const dir = k === 'ArrowLeft' ? -1 : 1;
      if (state.selected) nudgeSelected(dir * (e.shiftKey ? 0.001 : 0.01));
      else seek(time() + dir * 2);
    } else if (k === 'b' || k === 'B') ACTIONS['add-beat']();
    else if (k === 'D') ACTIONS['bars-here']();
    else if (k === 'd') ACTIONS['toggle-down']();
    else if (k === 's' || k === 'S') ACTIONS.section();
    else if (k === 'x' || k === 'X') ACTIONS.drop();
    else if (k === 'c' || k === 'C') $('clicks').checked = !$('clicks').checked;
    else if (k === 'Delete' || k === 'Backspace') ACTIONS.delete();
    else if (k === 'Escape') state.selected = null;
    else if (k === '+' || k === '=') $('zoom-in').click();
    else if (k === '-') $('zoom-out').click();
    else return;
    e.preventDefault();
  });
  window.addEventListener('beforeunload', (e) => dirty() && e.preventDefault());
  // Buttons let go of focus after a click, so Space keeps meaning play/pause.
  document.addEventListener('click', (e) => e.target.closest?.('button')?.blur());
}
