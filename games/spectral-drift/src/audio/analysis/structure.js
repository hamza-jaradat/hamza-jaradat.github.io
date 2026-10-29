// Song structure from bars: sections come from where the music stops resembling what
// came before (a novelty curve over a bar self-similarity matrix, after Foote), plus
// sharp energy changes. Each section gets an energy level and a repeat label, and the
// boundaries are classified into drops, build-ups and breakdowns.
import { ONSET } from './onsets.js';
import { chromaBetween } from './pitch.js';

const KERNEL = 4; // bars either side when scoring a boundary
const MIN_BARS = 3;
const PERCUSSIVE = ONSET.KICK | ONSET.SNARE | ONSET.HAT;

export function analyzeStructure({ beatTimes, positions, duration, frameRate, intensity, low, events, pitch }) {
  const downbeats = [];
  for (let i = 0; i < beatTimes.length; i++) if (positions[i] === 0) downbeats.push(beatTimes[i]);
  const whole = { start: 0, end: duration, startBar: 0, endBar: 0, energy: mean(intensity, 0, intensity.length), kind: 'groove', label: 'A' };
  if (downbeats.length < 8) {
    whole.kind = kindOf(whole.energy, whole.energy);
    return { downbeats: Float32Array.from(downbeats), sections: [whole], drops: [], builds: [], breakdowns: [] };
  }

  const gaps = downbeats.slice(1).map((t, i) => t - downbeats[i]).sort((a, b) => a - b);
  const barLength = gaps[gaps.length >> 1];
  const bars = downbeats.map((start, k) => ({ start, end: k + 1 < downbeats.length ? downbeats[k + 1] : Math.min(duration, start + barLength) }));

  // Per-bar description.
  const frameRange = (bar) => [Math.max(0, Math.floor(bar.start * frameRate)), Math.min(intensity.length, Math.ceil(bar.end * frameRate))];
  let e = 0;
  for (const bar of bars) {
    const [f0, f1] = frameRange(bar);
    bar.energy = mean(intensity, f0, f1);
    bar.low = mean(low, f0, f1);
    let drums = 0;
    let tones = 0;
    while (e < events.length && events[e].t < bar.start) e++;
    for (let j = e; j < events.length && events[j].t < bar.end; j++) {
      if (events[j].b & PERCUSSIVE) drums++;
      if (events[j].b & ONSET.TONE) tones++;
    }
    bar.drums = drums / 16;
    bar.tones = tones / 8;
    bar.chroma = chromaBetween(pitch, bar.start, bar.end);
  }
  const vectors = describe(bars);
  const n = bars.length;
  const sim = (i, j) => cosine(vectors[i], vectors[j]);

  // Novelty: a checkerboard kernel slid along the diagonal of the similarity matrix.
  const novelty = new Float32Array(n);
  const sigma = KERNEL / 2;
  for (let i = 1; i < n; i++) {
    let s = 0;
    let wsum = 0;
    for (let a = -KERNEL; a < KERNEL; a++) {
      for (let b = -KERNEL; b < KERNEL; b++) {
        const p = i + a;
        const q = i + b;
        if (p < 0 || q < 0 || p >= n || q >= n) continue;
        const w = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * sigma * sigma));
        s += (a < 0) === (b < 0) ? w * sim(p, q) : -w * sim(p, q);
        wsum += w;
      }
    }
    novelty[i] = wsum ? s / wsum : 0;
  }
  // Boundaries are novelty peaks well above the typical level: the median plus a robust
  // spread (so one huge change, like the music stopping, doesn't hide the others), and
  // never below a floor, so a song that never changes isn't chopped up by noise.
  const sorted = Array.from(novelty.subarray(1)).sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const spread = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b)[sorted.length >> 1];
  const threshold = Math.max(0.05, median + spread);
  const cuts = new Set();
  for (let i = 2; i < n - 1; i++) {
    let isPeak = true;
    for (let k = -2; k <= 2; k++) if (k && novelty[i + k] > novelty[i]) isPeak = false;
    if (isPeak && novelty[i] > threshold) cuts.add(i);
  }
  // Sudden energy changes are boundaries too, even when harmony carries on.
  const window = (i, len) => mean(bars.map((b) => b.energy), Math.max(0, i), Math.min(n, i + len));
  for (let i = 2; i < n - 1; i++) {
    const jump = window(i, 2) - window(i - 2, 2);
    const next = window(i + 1, 2) - window(i - 1, 2);
    const prev = window(i - 1, 2) - window(i - 3, 2);
    if (Math.abs(jump) >= 0.2 && Math.abs(jump) >= Math.abs(next) && Math.abs(jump) >= Math.abs(prev)) cuts.add(i);
  }

  // Sections between cuts, merging any too short to matter into their closer neighbour.
  let edges = [0, ...[...cuts].sort((a, b) => a - b), n];
  let merged = true;
  while (merged && edges.length > 2) {
    merged = false;
    for (let s = 0; s < edges.length - 1; s++) {
      if (edges[s + 1] - edges[s] >= MIN_BARS) continue;
      const here = window(edges[s], edges[s + 1] - edges[s]);
      const left = s > 0 ? Math.abs(window(edges[s - 1], edges[s] - edges[s - 1]) - here) : Infinity;
      const right = s + 2 < edges.length ? Math.abs(window(edges[s + 1], edges[s + 2] - edges[s + 1]) - here) : Infinity;
      edges.splice(left <= right ? s : s + 1, 1);
      merged = true;
      break;
    }
  }

  const barMean = (key, b0, b1) => mean(bars.map((b) => b[key]), Math.max(0, b0), Math.min(n, b1));
  const classify = () => {
    const top = Math.max(...edges.slice(0, -1).map((b0, s) => window(b0, edges[s + 1] - b0)));
    return edges.slice(0, -1).map((b0, s) => {
      const energy = window(b0, edges[s + 1] - b0);
      return { startBar: b0, endBar: edges[s + 1], energy, kind: kindOf(energy, top) };
    });
  };

  // A drop is a jump into the song's top energy, where the bass and kick come back in
  // full. Energy alone often fires early, in the loud last bars of a build-up, so each
  // drop slides to the nearby bar line where the low end jumps the most.
  const dropBars = [];
  let current = classify();
  for (let s = 1; s < current.length; s++) {
    const a = current[s - 1];
    const b = current[s];
    const lowRise = barMean('low', b.startBar, b.startBar + 2) - barMean('low', b.startBar - 2, b.startBar);
    if (b.kind !== 'peak' || a.kind === 'peak' || (b.energy - a.energy < 0.12 && lowRise < 0.15)) continue;
    let best = b.startBar;
    let bestJump = -Infinity;
    for (let k = Math.max(a.startBar + 1, b.startBar - 6); k <= Math.min(b.endBar - 2, b.startBar + 6); k++) {
      const jump = barMean('low', k, k + 2) - barMean('low', k - 2, k) + 0.5 * (barMean('energy', k, k + 2) - barMean('energy', k - 2, k));
      if (jump > bestJump) {
        bestJump = jump;
        best = k;
      }
    }
    // It has to be sudden and land on a real beat that lasts (about 3+ hits a bar for 4+
    // bars): not a slow swell, and not the soft attack of an ambient pad.
    const sudden = barMean('energy', best, best + 2) - barMean('energy', best - 2, best);
    const lowJump = barMean('low', best, best + 2) - barMean('low', best - 2, best);
    if (barMean('drums', best, best + 4) < 0.2 || b.endBar - best < 4) continue;
    if (sudden < 0.15 && lowJump < 0.2) continue;
    edges[s] = best;
    dropBars.push(best);
  }
  // The last (up to 8) bars before each drop are its build-up, a section of their own.
  const buildBars = [];
  for (const d of dropBars) {
    const s = edges.indexOf(d);
    const start = Math.max(edges[s - 1], d - 8);
    if (start - edges[s - 1] >= 3) edges.splice(s, 0, start);
    buildBars.push([start, d]);
  }
  edges = [...new Set(edges)].sort((a, b) => a - b);
  current = classify();

  const sections = current.map((sec, s) => ({
    ...sec,
    start: s === 0 ? 0 : bars[sec.startBar].start,
    end: s === current.length - 1 ? duration : bars[sec.endBar].start,
    drop: dropBars.includes(sec.startBar),
    build: buildBars.some(([b0]) => b0 === sec.startBar),
  }));
  labelRepeats(sections, vectors);

  const drops = dropBars.map((d) => bars[d].start);
  const builds = buildBars.map(([b0, b1]) => ({ start: bars[b0].start, end: bars[b1].start }));
  const breakdowns = [];
  for (let s = 1; s < sections.length; s++) {
    const a = sections[s - 1];
    const b = sections[s];
    if (a.kind === 'peak' && b.kind !== 'peak' && b.energy - a.energy <= -0.2) {
      b.breakdown = true;
      breakdowns.push(b.start);
    }
  }

  return { downbeats: Float32Array.from(downbeats), sections, drops, builds, breakdowns };
}

function kindOf(energy, top) {
  if (energy >= Math.max(0.6, top - 0.12)) return 'peak';
  if (energy <= 0.35) return 'calm';
  return 'groove';
}

// Sections that sound alike share a letter (A, B, C...), like verse and chorus repeats.
function labelRepeats(sections, vectors) {
  const avg = sections.map((s) => {
    const v = new Float32Array(vectors[0].length);
    for (let b = s.startBar; b < s.endBar; b++) for (let k = 0; k < v.length; k++) v[k] += vectors[b][k];
    return v;
  });
  const labels = [];
  sections.forEach((s, i) => {
    let match = -1;
    for (let j = 0; j < i; j++) {
      if (sections[j].kind === s.kind && cosine(avg[i], avg[j]) > 0.9) {
        match = j;
        break;
      }
    }
    s.label = match >= 0 ? sections[match].label : String.fromCharCode(65 + labels.length);
    if (match < 0) labels.push(s.label);
  });
}

// Bar feature vectors: standardised energy, bass, drums and melody activity, plus chroma.
function describe(bars) {
  const keys = ['energy', 'low', 'drums', 'tones'];
  const weights = { energy: 1.2, low: 0.9, drums: 0.9, tones: 0.5 };
  const stats = {};
  for (const k of keys) {
    const m = mean(bars.map((b) => b[k]), 0, bars.length);
    const sd = Math.sqrt(mean(bars.map((b) => (b[k] - m) ** 2), 0, bars.length)) || 1;
    stats[k] = { m, sd };
  }
  return bars.map((b) => {
    const v = new Float32Array(keys.length + 12);
    keys.forEach((k, i) => (v[i] = ((b[k] - stats[k].m) / stats[k].sd) * weights[k]));
    for (let p = 0; p < 12; p++) v[keys.length + p] = b.chroma[p] * 1.5;
    return v;
  });
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na * nb) || 1);
}

function mean(arr, from, to) {
  let s = 0;
  let c = 0;
  for (let i = from; i < to; i++) {
    s += arr[i];
    c++;
  }
  return c ? s / c : 0;
}
