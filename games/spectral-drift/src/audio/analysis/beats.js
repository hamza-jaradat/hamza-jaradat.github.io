// Tempo, beats and bars. Beats come from Ellis' dynamic-programming tracker (as in
// librosa), which follows the onset envelope while keeping spacing near the tempo; bar
// starts are the beat phase where kicks land and chords change.
import { clamp } from '../../util.js';
import { chromaBetween } from './pitch.js';

export function estimateTempo(env, fr, p) {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = Math.max(0, env[i] - mean);

  const minLag = Math.max(2, Math.floor((fr * 60) / 200));
  const maxLag = Math.min(n - 2, Math.ceil((fr * 60) / 60));
  if (maxLag <= minLag + 2) return 120;
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += o[i] * o[i + lag];
    ac[lag] = s / (n - lag);
  }
  let best = -1;
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fr) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / p.tempoCenter) / p.tempoWidth, 2));
    if (ac[lag] * prior > best) {
      best = ac[lag] * prior;
      bestLag = lag;
    }
  }
  const a = ac[bestLag - 1];
  const b = ac[bestLag];
  const c = ac[bestLag + 1];
  const den = a - 2 * b + c;
  const shift = den !== 0 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0;
  return (60 * fr) / (bestLag + shift);
}

// Beat frames. Returns an empty array if the song has no usable pulse.
export function trackBeats(env, fr, bpm, p) {
  const n = env.length;
  const period = (60 * fr) / bpm;

  // Normalise by standard deviation, then smear each onset slightly (local score).
  let m = 0;
  let m2 = 0;
  for (let i = 0; i < n; i++) {
    m += env[i];
    m2 += env[i] * env[i];
  }
  m /= n;
  const sd = Math.sqrt(Math.max(1e-12, m2 / n - m * m));
  const half = Math.round(period);
  const kernel = new Float32Array(2 * half + 1);
  for (let k = -half; k <= half; k++) kernel[k + half] = Math.exp(-0.5 * Math.pow((k * 32) / period, 2));
  const local = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += (env[j] / sd) * kernel[k + half];
    }
    local[i] = s;
  }

  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.round(2 * period);
  const tightness = p.tightness; // librosa uses 100; stiffer keeps sparse passages on the beat
  const weight = new Float32Array(hi + 1);
  for (let d = lo; d <= hi; d++) weight[d] = -tightness * Math.pow(Math.log(d / period), 2);
  const cum = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, local[i]);
  let first = true;
  for (let i = 0; i < n; i++) {
    let best = -Infinity;
    let arg = -1;
    for (let d = lo; d <= hi; d++) {
      const p = i - d;
      const v = weight[d] + (p >= 0 ? cum[p] : 0);
      if (v > best) {
        best = v;
        arg = p;
      }
    }
    cum[i] = local[i] + best;
    if (first && local[i] < 0.01 * peak) {
      back[i] = -1;
    } else {
      back[i] = arg;
      first = false;
    }
  }

  // The last beat: the latest local maximum of the cumulative score above half the median.
  const maxima = [];
  for (let i = 1; i < n - 1; i++) if (cum[i] >= cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(cum[i]);
  if (!maxima.length) return new Int32Array(0);
  maxima.sort((a, b) => a - b);
  const median = maxima[maxima.length >> 1];
  let last = -1;
  for (let i = n - 2; i > 0; i--) {
    if (cum[i] >= cum[i - 1] && cum[i] >= cum[i + 1] && 2 * cum[i] > median) {
      last = i;
      break;
    }
  }
  if (last < 0) return new Int32Array(0);
  const beats = [];
  for (let b = last; b >= 0; b = back[b]) beats.push(b);
  beats.reverse();

  // Trim weak beats at the ends (silence before and after the music).
  const at = beats.map((b) => local[b]);
  const smooth = at.map((_, i) => {
    let s = 0;
    let w = 0;
    for (let k = -2; k <= 2; k++) {
      const v = at[i + k];
      if (v !== undefined) {
        const h = 0.5 - 0.5 * Math.cos((2 * Math.PI * (k + 3)) / 6);
        s += v * h;
        w += h;
      }
    }
    return s / w;
  });
  const threshold = 0.5 * Math.sqrt(smooth.reduce((a, v) => a + v * v, 0) / smooth.length);
  let start = 0;
  let end = beats.length - 1;
  while (start < end && smooth[start] <= threshold) start++;
  while (end > start && smooth[end] <= threshold) end--;
  return Int32Array.from(beats.slice(start, end + 1));
}

// Most produced music sits on a perfectly steady pulse. If enough of the tracked beats
// agree on one (p.gridAgreement of them, within p.gridTolerance seconds), return that
// pulse as an exact grid spanning the music (from `first` to `last`), which also repairs
// stretches where the tracker slipped. Returns null for music whose tempo really moves.
export function steadyGrid(beats, first, last, p) {
  const n = beats.length;
  if (n < 16) return null;
  // Beat times are quantised to analysis frames, so individual gaps are coarse; the
  // average over the whole run is a much better first guess at the period.
  const average = (beats[n - 1] - beats[0]) / (n - 1);
  const TOL = p.gridTolerance;
  const fit = (period) => {
    // Circular mean of the beat phases, refined once using only the beats that agree.
    let offset = circularOffset(beats, period, () => true);
    offset = circularOffset(beats, period, (t) => phaseError(t, period, offset) < TOL);
    let count = 0;
    for (const t of beats) if (phaseError(t, period, offset) < TOL) count++;
    return { period, offset, count };
  };
  let best = null;
  for (let step = -30; step <= 30; step++) {
    const candidate = fit(average * (1 + step * 0.0005));
    if (!best || candidate.count > best.count) best = candidate;
  }
  if (best.count < p.gridAgreement * n) return null;

  // Least-squares line through the agreeing beats (beat number -> time).
  let sk = 0;
  let st = 0;
  let skk = 0;
  let skt = 0;
  let m = 0;
  for (const t of beats) {
    if (phaseError(t, best.period, best.offset) >= TOL) continue;
    const k = Math.round((t - best.offset) / best.period);
    sk += k;
    st += t;
    skk += k * k;
    skt += k * t;
    m++;
  }
  const period = (m * skt - sk * st) / (m * skk - sk * sk);
  const origin = (st - period * sk) / m;
  const grid = [];
  for (let k = Math.ceil((first - origin) / period - 0.5); origin + k * period <= last + period * 0.5; k++) {
    const t = origin + k * period;
    if (t > 0) grid.push(t);
  }
  return Float32Array.from(grid);
}

function phaseError(t, period, offset) {
  const r = (((t - offset) % period) + period) % period;
  return Math.min(r, period - r);
}

function circularOffset(beats, period, use) {
  let sx = 0;
  let sy = 0;
  for (const t of beats) {
    if (!use(t)) continue;
    const a = (t / period) * 2 * Math.PI;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  const phase = Math.atan2(sy, sx) / (2 * Math.PI);
  return (((phase * period) % period) + period) % period;
}

// Extends the beat grid at the steady tempo over quiet intros and outros, as long as
// there is music there (from `first` to `last`).
export function extendBeats(beats, first, last) {
  const out = [...beats];
  if (out.length < 8) return Float32Array.from(out);
  const spacing = (list) => {
    const gaps = list.slice(1).map((t, i) => t - list[i]).sort((a, b) => a - b);
    return gaps[gaps.length >> 1];
  };
  const head = spacing(out.slice(0, 9));
  const tail = spacing(out.slice(-9));
  while (out[0] - head > first - head * 0.5 && out[0] - head > 0) out.unshift(out[0] - head);
  while (out[out.length - 1] + tail < last + tail * 0.5) out.push(out[out.length - 1] + tail);
  return Float32Array.from(out);
}

// Position of every beat within its bar (0 = downbeat), assuming four beats to a bar.
// A Viterbi pass over the beats: chord changes, kicks and a missing backbeat snare argue
// for a downbeat; the bar position normally advances by one per beat, and only re-syncs
// (at a cost) when the evidence keeps disagreeing, e.g. after a beat slip.
export function barPositions(beatTimes, cueAt, pitch, p) {
  const n = beatTimes.length;
  const positions = new Uint8Array(n);
  if (n < 8) return positions;
  const emit = new Float32Array(n);
  const before = new Float32Array(12);
  const after = new Float32Array(12);
  for (let i = 0; i < n; i++) {
    // Harmony over the two beats either side: one beat is too short once pad attacks,
    // arpeggios and echoes smear a chord change across the bar line.
    const prev = beatTimes[Math.max(0, i - 2)];
    const next = beatTimes[Math.min(n - 1, i + 2)];
    chromaBetween(pitch, prev, beatTimes[i], before);
    chromaBetween(pitch, beatTimes[i], next, after);
    let dot = 0;
    for (let p = 0; p < 12; p++) dot += before[p] * after[p];
    const cue = cueAt(beatTimes[i]);
    emit[i] = p.barChord * (1 - dot) + p.barKick * cue.kick - p.barSnare * cue.snare;
  }
  let m = 0;
  for (const v of emit) m += v;
  m /= n;
  let sd = 0;
  for (const v of emit) sd += (v - m) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  for (let i = 0; i < n; i++) emit[i] = (emit[i] - m) / sd;

  const RESYNC = p.barResync;
  const score = new Float32Array(n * 4);
  const from = new Int8Array(n * 4);
  for (let s = 0; s < 4; s++) score[s] = s === 0 ? emit[0] : 0;
  for (let i = 1; i < n; i++) {
    let bestPrev = 0;
    for (let s = 1; s < 4; s++) if (score[(i - 1) * 4 + s] > score[(i - 1) * 4 + bestPrev]) bestPrev = s;
    for (let s = 0; s < 4; s++) {
      const steady = (s + 3) % 4;
      let v = score[(i - 1) * 4 + steady];
      let arg = steady;
      const jump = score[(i - 1) * 4 + bestPrev] - RESYNC;
      if (jump > v) {
        v = jump;
        arg = bestPrev;
      }
      score[i * 4 + s] = v + (s === 0 ? emit[i] : 0);
      from[i * 4 + s] = arg;
    }
  }
  let s = 0;
  for (let k = 1; k < 4; k++) if (score[(n - 1) * 4 + k] > score[(n - 1) * 4 + s]) s = k;
  for (let i = n - 1; i >= 0; i--) {
    positions[i] = s;
    s = from[i * 4 + s];
  }
  return positions;
}
