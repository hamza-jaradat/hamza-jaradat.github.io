import '@fontsource/orbitron/600.css';
import '@fontsource/orbitron/800.css';
import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/700.css';
import './style.css';

import { openAnalysis } from './audio/analyzer.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { DEMO_TITLE, generateDemoSong } from './audio/demoSong.js';
import { readGenre } from './audio/tags.js';
import { DIFFICULTIES, LEAD_IN, OVERDRIVE_DURATION } from './config.js';
import { Attract } from './game/Attract.js';
import { buildChart } from './game/Chart.js';
import { GENRES, genreFromTag } from './game/genres.js';
import { Input } from './game/Input.js';
import { Session } from './game/Session.js';
import { Track } from './game/Track.js';
import { World } from './render/World.js';
import { UI } from './ui/UI.js';
import { hashString } from './util.js';

const SETTINGS_KEY = 'spectral-drift:settings';
const BEST_KEY = 'spectral-drift:best';
const GENRE_KEY = 'spectral-drift:genres'; // the genre picked for each song, unless Auto
const DEFAULT_SETTINGS = { music: 85, sfx: 50, offset: 0, quality: true, difficulty: 'normal' };

// Yield so the loading text can paint; a timer (unlike rAF) also fires in background tabs.
const yieldToUI = () => new Promise((r) => setTimeout(r, 16));

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode); settings just won't persist
  }
}

class App {
  constructor() {
    this.settings = readJSON(SETTINGS_KEY, DEFAULT_SETTINGS);
    if (!DIFFICULTIES[this.settings.difficulty]) this.settings.difficulty = 'normal';
    this.world = new World(document.getElementById('scene'));
    this.audio = new AudioEngine();
    this.input = new Input();
    this.ui = new UI({
      onFile: (f) => this.loadFile(f),
      onDemo: () => this.loadDemo(),
      onStart: () => this.start(),
      onMenu: () => this.toMenu(),
      onPause: () => this.pause(),
      onResume: () => this.resume(),
      onRestart: () => this.start(),
      onOverdrive: () => this.overdrive(),
      onDifficulty: (d) => this.setDifficulty(d),
      onGenre: (g) => this.setGenre(g),
      onSettings: (s) => this.updateSettings(s),
      canDrop: () => this.state === 'menu' || this.state === 'ready' || this.state === 'results',
    });
    this.attract = new Attract(this.world);
    this.attract.activate();
    this.song = null;
    this.session = null;
    this.busy = false;
    this.applySettings();

    this.input.onOverdrive = () => this.overdrive();
    this.input.onPause = () => (this.state === 'paused' ? this.resume() : this.pause());
    window.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('visibilitychange', () => document.hidden && this.pause());
    window.addEventListener('blur', () => this.pause());

    this.setState('menu');
    this.last = performance.now();
    this.world.renderer.setAnimationLoop((now) => this.frame(now));
  }

  setState(state) {
    this.state = state;
    this.ui.show(state === 'playing' ? 'playing' : state === 'paused' ? 'pause' : state);
    this.input.enabled = state === 'playing';
    document.body.style.cursor = state === 'playing' ? 'none' : '';
  }

  // --- Settings -------------------------------------------------------------
  applySettings() {
    const s = this.settings;
    this.audio.setMusicVolume(s.music / 100);
    this.audio.setSfxVolume(s.sfx / 100);
    this.audio.offset = s.offset / 1000;
    if (this.world.highQuality !== s.quality) this.world.setQuality(s.quality);
    this.ui.setSettings(s);
    writeJSON(SETTINGS_KEY, s);
  }

  updateSettings(partial) {
    Object.assign(this.settings, partial);
    this.applySettings();
  }

  setDifficulty(d) {
    if (!DIFFICULTIES[d] || d === this.settings.difficulty) return;
    this.updateSettings({ difficulty: d });
    this.audio.ui();
    // While busy, a genre change is rebuilding the level, with this difficulty.
    if (this.state === 'ready' && this.song && !this.busy) {
      this.buildLevel();
      this.showReady();
    }
  }

  // The genre to play the song as: 'auto' (what its tag says) or one of GENRES. Analysis
  // params can differ by genre, so the song is interpreted again, then the level rebuilt.
  async setGenre(choice) {
    const song = this.song;
    if (!song || this.busy || this.state !== 'ready' || choice === song.choice) return;
    if (choice !== 'auto' && !GENRES[choice]) return;
    const choices = readJSON(GENRE_KEY, {});
    if (choice === 'auto') delete choices[song.key];
    else choices[song.key] = choice;
    writeJSON(GENRE_KEY, choices);
    song.choice = choice;
    this.audio.ui();
    const genre = choice === 'auto' ? song.auto : choice;
    if (genre !== song.genre) {
      this.busy = true;
      this.ui.genreWorking(choice);
      try {
        song.features = await song.analysis.interpret(GENRES[genre].params);
        song.genre = genre;
      } catch (err) {
        console.error(err);
      } finally {
        this.busy = false;
      }
      if (this.song !== song || this.state !== 'ready') return; // left for the menu meanwhile
      this.buildLevel();
    }
    this.showReady();
  }

  // --- Loading ----------------------------------------------------------------
  async loadFile(file) {
    if (this.busy) return;
    const title = file.name.replace(/\.[^.]+$/, '');
    await this.load(title, `file:${file.name}:${file.size}`, async () => {
      this.ui.setLoading(title, 'Reading file…', 0.03);
      const data = await file.arrayBuffer();
      const tag = readGenre(data); // before decoding, which may take the bytes over
      this.ui.setLoading(title, 'Decoding audio…', 0.08);
      try {
        return { buffer: await this.audio.decode(data), tag, genre: genreFromTag(tag) };
      } catch {
        throw new Error('This browser could not decode that file. Try MP3, OGG, WAV, FLAC or M4A.');
      }
    });
  }

  async loadDemo() {
    if (this.busy) return;
    this.audio.ensure();
    await this.load(DEMO_TITLE, 'demo:first-light', async () => {
      this.ui.setLoading(DEMO_TITLE, 'Composing the demo track…', 0.04);
      return { buffer: await generateDemoSong(), tag: null, genre: 'electronic' };
    });
  }

  // getSong resolves to { buffer, tag, genre }: the audio, its genre tag, and the genre
  // that tag names (or null).
  async load(title, key, getSong) {
    this.busy = true;
    this.audio.stop();
    this.setState('loading');
    this.song?.analysis.dispose();
    this.song = null;
    try {
      const { buffer, tag, genre: tagged } = await getSong();
      if (buffer.duration < 8) throw new Error('That clip is too short. Pick a song at least 8 seconds long.');
      const auto = tagged ?? 'any';
      const choice = readJSON(GENRE_KEY, {})[key] ?? 'auto';
      const genre = choice === 'auto' || !GENRES[choice] ? auto : choice;
      const STAGES = { beats: 'Listening for beats…', notes: 'Finding the melody…' };
      this.ui.setLoading(title, STAGES.beats, 0.12);
      const analysis = await openAnalysis(buffer, GENRES[genre].params, (p, stage) => this.ui.setLoading(title, STAGES[stage] ?? STAGES.beats, 0.12 + p * 0.8));
      this.ui.setLoading(title, 'Building the road…', 0.95);
      await yieldToUI();
      this.song = { title, buffer, features: analysis.features, analysis, key, seed: hashString(key), tag, auto, choice, genre };
      this.buildLevel();
      this.showReady();
    } catch (err) {
      console.error(err);
      this.attract.activate();
      this.setState('menu');
      this.ui.showError(err?.message || 'Something went wrong while loading that song.');
    } finally {
      this.busy = false;
    }
  }

  buildLevel() {
    const diff = DIFFICULTIES[this.settings.difficulty];
    const { features, seed, genre } = this.song;
    const style = GENRES[genre];
    this.track = new Track(features, { speedMul: diff.speed, seed, style: style.track });
    this.chart = buildChart(features, diff, seed, style.chart);
    this.world.setTrack(this.track, features, this.chart, seed);
    this.session = new Session({
      features,
      track: this.track,
      chart: this.chart,
      world: this.world,
      audio: this.audio,
      input: this.input,
      hud: this.ui,
    });
  }

  showReady() {
    const { title, features, choice, genre, auto, tag } = this.song;
    this.ui.showReady({
      title,
      features,
      chart: this.chart,
      best: this.bests()[this.bestKey()],
      genre: { choice, genre, auto, tag },
    });
    this.setState('ready');
  }

  // --- Flow -------------------------------------------------------------------
  start() {
    if (this.busy || !this.session || !['ready', 'paused', 'results'].includes(this.state)) return;
    document.activeElement?.blur?.();
    this.session.reset();
    this.ui.setHudSong(this.song.title, this.song.features);
    this.ui.overdriveUsed();
    this.audio.play(this.song.buffer, LEAD_IN);
    this.setState('playing');
  }

  pause() {
    if (this.state !== 'playing') return;
    this.audio.pause();
    this.setState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    document.activeElement?.blur?.();
    this.audio.resume();
    this.setState('playing');
  }

  toMenu() {
    this.audio.stop();
    if (this.audio.paused) this.audio.resume();
    this.attract.activate();
    this.setState('menu');
  }

  overdrive() {
    if (this.state !== 'playing' || !this.session) return;
    const before = this.session.score.overdriveActive;
    this.session.activateOverdrive();
    if (!before && this.session.score.overdriveActive) this.ui.overdriveUsed();
  }

  finish() {
    const s = this.session.score;
    const grade = s.grade();
    const bests = this.bests();
    const key = this.bestKey();
    const prev = bests[key];
    const newBest = !prev || s.score > prev.score;
    if (newBest) {
      bests[key] = { score: s.score, grade };
      writeJSON(BEST_KEY, bests);
    }
    const genre = this.song.genre === 'any' ? '' : ` · ${GENRES[this.song.genre].label}`;
    this.ui.showResults({
      title: this.song.title,
      difficulty: DIFFICULTIES[this.settings.difficulty].label + genre,
      grade,
      score: s.score,
      best: newBest ? s.score : prev.score,
      newBest,
      accuracy: s.accuracy,
      collected: s.collected,
      total: this.chart.notesTotal,
      maxCombo: s.maxCombo,
      hits: s.hits,
      hazards: this.chart.hazardsTotal,
      smashed: s.smashed,
      holdsDone: s.holdsDone,
      holds: this.chart.holdsTotal,
    });
    this.setState('results');
  }

  bests() {
    return readJSON(BEST_KEY, {});
  }

  // Per song and difficulty; a genre other than the song's own (Auto's) charts it
  // differently, so it keeps its own best.
  bestKey() {
    const { key, genre, auto } = this.song;
    return `${key}|${this.settings.difficulty}${genre === auto ? '' : `|${genre}`}`;
  }

  onKey(e) {
    if (e.code === 'Escape' || e.code === 'KeyP') {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
    } else if (e.code === 'Enter' || (e.code === 'Space' && this.state !== 'playing')) {
      if (this.state === 'ready' || this.state === 'results') {
        e.preventDefault();
        this.start();
      }
    } else if (e.code === 'KeyR' && this.state === 'paused') {
      this.start();
    }
  }

  // --- Frame loop ---------------------------------------------------------------
  frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.input.update();
    switch (this.state) {
      case 'menu':
      case 'loading':
        this.attract.update(dt);
        break;
      case 'ready':
        this.world.update(this.session.frameState(), dt);
        break;
      case 'playing':
      case 'results': {
        const end = this.track.tEnd - 2;
        const t = Math.min(this.audio.time(dt), end);
        this.session.update(t, dt);
        this.world.update(this.session.frameState(), dt);
        if (this.state === 'playing') {
          const s = this.session.score;
          this.ui.updateHud(
            {
              t,
              duration: this.song.features.duration,
              score: s.score,
              multiplier: s.multiplier,
              combo: s.combo,
              charge: s.charge,
              overdrive: s.overdrive,
              overdriveMax: OVERDRIVE_DURATION,
              overdriveActive: s.overdriveActive,
            },
            dt,
          );
          if (this.session.finished) this.finish();
        }
        break;
      }
      case 'paused':
        break;
    }
    this.world.render(dt);
  }
}

window.app = new App();
