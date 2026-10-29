// DOM overlay: menus, loading, HUD and results.
import { heatCSS } from '../render/shaderLib.js';
import { formatTime } from '../util.js';

const SCREENS = ['menu', 'loading', 'ready', 'pause', 'results'];
const GRADE_COLORS = { S: '#ffd25a', A: '#46d9ff', B: '#9b66ff', C: '#ff3fa4', D: '#ff2a3d' };

export class UI {
  constructor(handlers) {
    this.h = handlers;
    const $ = (id) => document.getElementById(id);
    this.$ = $;
    this.screens = Object.fromEntries(SCREENS.map((s) => [s, $(`screen-${s}`)]));
    this.hud = $('hud');
    this.el = {
      score: $('hud-score'),
      mult: $('hud-mult'),
      combo: $('hud-combo'),
      comboN: $('hud-combo-n'),
      od: $('hud-od'),
      odFill: $('hud-od-fill'),
      odLabel: $('hud-od-label'),
      time: $('hud-time'),
      title: $('hud-title'),
      played: $('hud-played'),
      countdown: $('countdown'),
      toasts: $('toasts'),
    };
    this.last = {};
    this.shownScore = 0;

    // The launcher's build adds this meta tag, so the link only shows when served from there.
    const hubUrl = document.querySelector('meta[name="hub-url"]')?.content;
    if (hubUrl) {
      $('hub-link').href = hubUrl;
      $('hub-link').hidden = false;
    }

    $('file-input').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) handlers.onFile(file);
    });
    $('btn-demo').addEventListener('click', () => handlers.onDemo());
    $('btn-start').addEventListener('click', () => handlers.onStart());
    $('btn-back').addEventListener('click', () => handlers.onMenu());
    $('btn-resume').addEventListener('click', () => handlers.onResume());
    $('btn-restart').addEventListener('click', () => handlers.onRestart());
    $('btn-quit').addEventListener('click', () => handlers.onMenu());
    $('btn-again').addEventListener('click', () => handlers.onRestart());
    $('btn-new').addEventListener('click', () => handlers.onMenu());
    $('btn-pause').addEventListener('click', () => handlers.onPause());
    this.el.od.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      handlers.onOverdrive();
    });

    for (const group of document.querySelectorAll('.segmented[data-setting="difficulty"]')) {
      group.addEventListener('click', (e) => {
        const value = e.target.closest('button')?.dataset.value;
        if (value) handlers.onDifficulty(value);
      });
    }

    const settingsChanged = () =>
      handlers.onSettings({
        music: Number($('set-music').value),
        sfx: Number($('set-sfx').value),
        offset: Number($('set-offset').value),
        quality: $('set-quality').checked,
      });
    for (const id of ['set-music', 'set-sfx', 'set-offset']) $(id).addEventListener('input', settingsChanged);
    $('set-quality').addEventListener('change', settingsChanged);

    // Drag and drop anywhere on the page.
    const overlay = $('drop-overlay');
    let depth = 0;
    const acceptsDrop = () => handlers.canDrop();
    window.addEventListener('dragenter', (e) => {
      if (!acceptsDrop() || !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      depth++;
      overlay.hidden = false;
    });
    window.addEventListener('dragover', (e) => {
      if (acceptsDrop()) e.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) overlay.hidden = true;
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      const file = e.dataTransfer?.files?.[0];
      if (file && acceptsDrop()) handlers.onFile(file);
    });
  }

  show(name) {
    for (const [key, el] of Object.entries(this.screens)) el.hidden = key !== name;
    this.hud.hidden = !(name === 'playing' || name === 'pause');
    if (name !== 'menu') this.$('menu-error').hidden = true;
  }

  showError(message) {
    const el = this.$('menu-error');
    el.textContent = message;
    el.hidden = false;
  }

  setSettings(s) {
    this.$('set-music').value = s.music;
    this.$('set-sfx').value = s.sfx;
    this.$('set-offset').value = s.offset;
    this.$('set-offset-val').textContent = `${s.offset > 0 ? '+' : ''}${s.offset} ms`;
    this.$('set-quality').checked = s.quality;
    for (const btn of document.querySelectorAll('.segmented[data-setting="difficulty"] button')) {
      const on = btn.dataset.value === s.difficulty;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
    }
  }

  setLoading(title, stage, progress) {
    this.$('load-name').textContent = title;
    this.$('load-stage').textContent = stage;
    this.$('load-bar').style.width = `${Math.round(progress * 100)}%`;
  }

  showReady({ title, features, chart, best }) {
    this.$('ready-title').textContent = title;
    drawGraph(this.$('ready-graph'), features.intensity);
    const stats = [
      [formatTime(features.duration), 'Length'],
      [Math.round(features.bpm), 'BPM'],
      [chart.notesTotal, 'Notes'],
      [chart.hazardsTotal, 'Hazards'],
    ];
    this.$('ready-stats').innerHTML = stats.map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`).join('');
    this.$('ready-best').innerHTML = best
      ? `Best on this difficulty: <b>${best.score.toLocaleString()}</b> · grade ${best.grade}`
      : 'No score on this difficulty yet.';
  }

  setHudSong(title, features) {
    this.el.title.textContent = title;
    drawGraph(this.$('hud-graph'), features.intensity);
    this.duration = features.duration;
    this.last = {};
    this.shownScore = 0;
    this.el.toasts.replaceChildren();
    this.hud.classList.remove('hit');
  }

  updateHud(s, dt) {
    const L = this.last;
    this.shownScore += (s.score - this.shownScore) * Math.min(1, dt * 12);
    if (s.score - this.shownScore < 1) this.shownScore = s.score;
    const shown = Math.round(this.shownScore);
    if (L.score !== shown) this.el.score.textContent = shown.toLocaleString();
    L.score = shown;

    if (L.mult !== s.multiplier) {
      this.el.mult.textContent = `x${s.multiplier}`;
      this.el.mult.classList.toggle('high', s.multiplier >= 4);
      L.mult = s.multiplier;
    }
    if (L.combo !== s.combo) {
      this.el.comboN.textContent = s.combo;
      this.el.combo.classList.toggle('on', s.combo > 0);
      this.el.combo.classList.remove('bump');
      if (s.combo > 0) {
        void this.el.combo.offsetWidth;
        this.el.combo.classList.add('bump');
      }
      L.combo = s.combo;
    }

    const odFrac = s.overdriveActive ? s.overdrive / s.overdriveMax : s.charge;
    const odPct = Math.round(odFrac * 100);
    if (L.od !== odPct) {
      this.el.odFill.style.width = `${odPct}%`;
      L.od = odPct;
    }
    const odState = s.overdriveActive ? 'active' : s.charge >= 1 ? 'ready' : 'idle';
    if (L.odState !== odState) {
      this.el.od.classList.toggle('ready', odState === 'ready');
      this.el.od.classList.toggle('active', odState === 'active');
      this.el.odLabel.textContent = odState === 'ready' ? 'Overdrive ready · Space' : 'Overdrive';
      L.odState = odState;
    }

    const elapsed = Math.max(0, Math.min(s.t, s.duration));
    const timeText = `${formatTime(elapsed)} / ${formatTime(s.duration)}`;
    if (L.time !== timeText) {
      this.el.time.textContent = timeText;
      L.time = timeText;
    }
    this.el.played.style.width = `${((elapsed / s.duration) * 100).toFixed(2)}%`;

    let cd = '';
    if (s.t < 0 && s.t >= -3) cd = String(Math.ceil(-s.t));
    else if (s.t >= 0 && s.t < 0.6) cd = 'GO';
    if (L.cd !== cd) {
      this.el.countdown.textContent = cd;
      this.el.countdown.classList.remove('tick');
      if (cd) {
        void this.el.countdown.offsetWidth;
        this.el.countdown.classList.add('tick');
      }
      L.cd = cd;
    }
  }

  toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    el.addEventListener('animationend', () => el.remove());
    this.el.toasts.replaceChildren(el);
  }

  hit() {
    this.hud.classList.remove('hit');
    void this.hud.offsetWidth;
    this.hud.classList.add('hit');
  }

  overdriveReady() {
    if (this.last.readyToasted) return;
    this.last.readyToasted = true;
    this.toast('OVERDRIVE READY', 'gold');
  }

  overdriveUsed() {
    this.last.readyToasted = false;
  }

  showResults(r) {
    this.$('res-song').textContent = `${r.title} · ${r.difficulty}`;
    const grade = this.$('res-grade');
    grade.textContent = r.grade;
    grade.style.setProperty('--grade', GRADE_COLORS[r.grade] || '#9b66ff');
    this.$('res-score').textContent = r.score.toLocaleString();
    const best = this.$('res-best');
    best.classList.toggle('new', r.newBest);
    best.textContent = r.newBest ? 'New best' : `Best ${r.best.toLocaleString()}`;
    const stats = [
      ['Accuracy', `${(r.accuracy * 100).toFixed(1)}%`],
      ['Collected', `${r.collected} / ${r.total}`],
      ['Max combo', r.maxCombo],
      ['Hazards hit', `${r.hits} / ${r.hazards}`],
      ['Smashed', r.smashed],
      ['Clean run', r.hits === 0 ? 'Yes' : 'No'],
    ];
    this.$('res-stats').innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  }
}

// Intensity overview drawn as heat-colored columns.
function drawGraph(canvas, values) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const cols = Math.max(1, Math.floor(w / 4));
  const per = values.length / cols;
  for (let c = 0; c < cols; c++) {
    let v = 0;
    const start = Math.floor(c * per);
    const end = Math.min(values.length, Math.floor((c + 1) * per));
    for (let i = start; i < end; i++) v = Math.max(v, values[i]);
    const bh = Math.max(2, v * (h - 4));
    ctx.fillStyle = heatCSS(v, 0.92);
    ctx.fillRect(c * 4, h - bh, 3, bh);
  }
}
