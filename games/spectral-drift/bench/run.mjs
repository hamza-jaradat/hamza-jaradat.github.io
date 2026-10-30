// Scores the music analysis against labeled songs, and tunes its params.
//
//   npm run bench -w games/spectral-drift                 built-in songs + bench/songs/
//   npm run bench -w games/spectral-drift -- --tune 300   search for better params
//
// Options:
//   --songs <dir>     folder of songs with labels (default bench/songs, or $SONGS_DIR)
//   --only <names>    only songs whose names contain one of these (comma-separated)
//   --no-builtin      leave out the built-in songs
//   --params <file>   run with these params (JSON) over the defaults
//   --tune <n>        try n variations of the params; the best go to bench/tuned-params.json
//   --no-notes        leave out the Basic Pitch model (the game's fallback: pitch tracking)
//   --json            print the results as JSON
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { interpret, prepare } from '../src/audio/analysis/analyze.js';
import { DEFAULT_PARAMS } from '../src/audio/analysis/params.js';
import { GENRES } from '../src/game/genres.js';
import { hashString, mulberry32 } from '../src/util.js';
import { METRICS, overall, scoreSong, summarize } from './metrics.js';
import { decode, listSongs, readLabels, songsDir } from './songs.js';
import { BUILT_IN } from './suite.js';
import { keysFor, soundFor } from './transcribe.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// Ranges the tuner may move each param within ([min, max], whole numbers if 'int').
const SPACE = {
  onsetShare: [0.1, 0.6],
  floorKick: [0.1, 0.8],
  floorSnare: [0.05, 0.4],
  floorHat: [0.01, 0.2],
  floorTone: [0.01, 0.12],
  sharpKick: [1, 3],
  sharpSnare: [1, 3],
  sharpHat: [1, 3],
  sharpTone: [1, 2.5],
  envSnare: [0, 1.5],
  envHat: [0, 1],
  envTone: [0, 1.5],
  tempoCenter: [90, 150],
  tempoWidth: [0.4, 1.5],
  tightness: [50, 800],
  gridTolerance: [0.02, 0.12],
  gridAgreement: [0.5, 0.9],
  barChord: [0, 4],
  barKick: [0, 1.5],
  barSnare: [0, 2],
  barResync: [1, 12],
  noveltyFloor: [0, 0.2],
  energyJump: [0.1, 0.4],
  minBars: [2, 6, 'int'],
  dropRise: [0.05, 0.3],
  dropLowRise: [0.05, 0.4],
  dropDrums: [0.05, 0.5],
  dropDrumsJump: [0.1, 0.6],
  dropLowJump: [0.05, 0.4],
  noteOnset: [0.25, 0.75],
  noteFrame: [0.15, 0.5],
  noteMinLen: [0.03, 0.15],
  leadMin: [36, 64, 'int'],
  leadShare: [0.3, 0.9],
  noteMatch: [0.02, 0.08],
};

const args = parseArgs(process.argv.slice(2));
const log = (...a) => args.json || console.log(...a);

const songs = await loadSongs();
if (!songs.length) {
  console.error('No songs to score. Add labeled songs to the songs folder, or drop --no-builtin / --only.');
  process.exit(1);
}
let params = { ...DEFAULT_PARAMS };
if (args.params) params = { ...params, ...JSON.parse(readFileSync(args.params, 'utf8')) };

if (args.tune) {
  tune(songs, Number(args.tune) || 200, params);
} else {
  const results = songs.map((s) => ({ name: s.name, genre: s.labels.genre, ...scoreSong(s.labels, interpret(s.prep, asGenre(s, params))) }));
  if (args.json) console.log(JSON.stringify({ songs: results, summary: summarize(results) }, null, 1));
  else printTable(results);
}

async function loadSongs() {
  const only = args.only ? String(args.only).toLowerCase().split(',') : null;
  const wanted = (name) => !only || only.some((o) => name.toLowerCase().includes(o));
  const out = [];
  const add = async (name, x, sr, labels) => {
    const t0 = performance.now();
    const prep = prepare(x, sr);
    const t1 = performance.now();
    if (!args['no-notes']) prep.keys = await keysFor(x, sr);
    if (labels.genre) prep.sound = await soundFor(x, sr); // to check the genre heard
    const t2 = performance.now();
    const notes = t2 - t1 > 50 ? `, models in ${((t2 - t1) / 1000).toFixed(1)} s` : '';
    log(`  ${name}  (${(x.length / sr).toFixed(0)} s, analyzed in ${((t1 - t0) / 1000).toFixed(1)} s${notes})`);
    out.push({ name, labels, prep });
  };
  log('Preparing songs…');
  if (!args['no-builtin']) {
    for (const [name, song] of Object.entries(BUILT_IN)) {
      if (!wanted(name)) continue;
      const { x, sr, labels } = song.make();
      await add(name, x, sr, labels);
    }
  }
  const dir = songsDir(args.songs);
  for (const { file, labeled } of listSongs(dir)) {
    if (!labeled || !wanted(file)) continue;
    try {
      const { samples, sampleRate } = await decode(join(dir, file));
      await add(file, samples, sampleRate, readLabels(dir, file));
    } catch (err) {
      console.error(`  ${file}: ${err.message}`);
    }
  }
  return out;
}

// A song labeled with a genre is analyzed as the game would analyze that genre.
function asGenre(song, p) {
  return { ...p, ...GENRES[song.labels.genre]?.params };
}

function evaluate(set, p) {
  const totals = set.map((s) => overall(scoreSong(s.labels, interpret(s.prep, asGenre(s, p))))).filter((v) => !Number.isNaN(v));
  return totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : NaN;
}

// Hill climbing: nudge one to three params at a time and keep any change that scores
// better on the tuning songs. A held-out third of the songs shows whether the gain is
// real or just fits those songs.
function tune(all, trials, start) {
  const shuffled = [...all].sort((a, b) => hashString(a.name) - hashString(b.name));
  const held = all.length >= 4 ? shuffled.filter((_, i) => i % 3 === 2) : [];
  const set = all.filter((s) => !held.includes(s));
  const rng = mulberry32(Date.now() >>> 0);
  const gauss = () => Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());
  const keys = Object.keys(SPACE);
  const base = { params: start, score: evaluate(set, start) };
  let best = base;
  log(`\nTuning on ${set.length} songs${held.length ? `, checking on ${held.length} held out` : ''}. Starting score ${fmt(base.score)}.`);
  for (let i = 1; i <= trials; i++) {
    const cand = { ...best.params };
    const n = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const key = keys[Math.floor(rng() * keys.length)];
      const [lo, hi, kind] = SPACE[key];
      let v = rng() < 0.1 ? lo + rng() * (hi - lo) : cand[key] + gauss() * 0.15 * (hi - lo);
      v = Math.min(hi, Math.max(lo, v));
      cand[key] = kind === 'int' ? Math.round(v) : +v.toPrecision(3);
    }
    const score = evaluate(set, cand);
    if (score > best.score + 1e-6) {
      best = { params: cand, score };
      log(`  trial ${i}: ${fmt(score)}`);
    }
  }
  const changed = Object.fromEntries(keys.filter((k) => best.params[k] !== start[k]).map((k) => [k, best.params[k]]));
  log(`\nTuning songs: ${fmt(base.score)} → ${fmt(best.score)}`);
  if (held.length) log(`Held-out songs: ${fmt(evaluate(held, start))} → ${fmt(evaluate(held, best.params))}`);
  if (!Object.keys(changed).length) {
    log('No change scored better.');
    return;
  }
  log('\nChanged params:');
  for (const [k, v] of Object.entries(changed)) log(`  ${k.padEnd(14)} ${String(start[k]).padStart(6)} → ${v}`);
  const file = join(HERE, 'tuned-params.json');
  writeFileSync(file, JSON.stringify(changed, null, 1) + '\n');
  log(`\nSaved to ${file}. Check them with --params, then copy the ones you trust into src/audio/analysis/params.js.`);
}

function printTable(results) {
  const cols = METRICS.map((m) => ({ ...m, width: Math.max(8, m.label.length + 2) }));
  const short = (name) => (name.length > 40 ? name.slice(0, 39) + '…' : name);
  const nameWidth = Math.max(12, ...results.map((r) => short(r.name).length + 2));
  const cell = (v, w) => (v === undefined ? '–' : v.toFixed(3)).padStart(w);
  console.log('\n' + 'Song'.padEnd(nameWidth) + cols.map((c) => c.label.padStart(c.width)).join('') + 'Overall'.padStart(9));
  for (const r of results) {
    const notes = [];
    if (r.beatAnyF > r.beatF + 0.1) notes.push(`beats score ${r.beatAnyF.toFixed(2)} at ${r.beatMode}`);
    // A steady offset usually means the labels (or the decoder) are shifted, not the analysis.
    if (Math.abs(r.beatShift) >= 15) notes.push(`beats sit ${Math.round(r.beatShift)} ms ${r.beatShift > 0 ? 'late' : 'early'}`);
    console.log(short(r.name).padEnd(nameWidth) + cols.map((c) => cell(r[c.key], c.width)).join('') + cell(overall(r), 9) + (notes.length ? `  ${notes.join('; ')}` : ''));
  }
  const sum = summarize(results);
  console.log('Mean'.padEnd(nameWidth) + cols.map((c) => cell(sum[c.key], c.width)).join('') + cell(sum.overall, 9));
  // With songs of several genres, a mean per genre shows where the analysis falls short.
  const genres = [...new Set(results.map((r) => r.genre ?? 'any'))];
  if (genres.length > 1) {
    for (const g of genres) {
      const own = summarize(results.filter((r) => (r.genre ?? 'any') === g));
      console.log(`  ${GENRES[g]?.label ?? g}`.padEnd(nameWidth) + cols.map((c) => cell(own[c.key], c.width)).join('') + cell(own.overall, 9));
    }
  }
  console.log('\n' + cols.map((c) => `${c.label}: ${c.hint}`).join('\n'));
}

function fmt(v) {
  return Number.isNaN(v) ? '–' : v.toFixed(4);
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const key = list[i].replace(/^--/, '');
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) out[key] = list[++i];
    else out[key] = true;
  }
  return out;
}
