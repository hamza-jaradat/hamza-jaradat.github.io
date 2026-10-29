// Offline music analysis: spectral-flux onsets per band, an intensity curve,
// a tempo estimate and a compact spectrogram that drives the visuals.
import { FFT } from './fft.js';
import { clamp, movingAverage, percentile } from '../util.js';

const FFT_SIZE = 1024;
const HOP = 256;
const SPEC_BANDS = 32;
const BAND_WEIGHTS = [1.0, 0.85, 0.7]; // low, mid, high

self.onmessage = (e) => {
  const { samples, sampleRate } = e.data;
  try {
    const result = analyze(samples, sampleRate, (p) => self.postMessage({ type: 'progress', p }));
    const transfer = ['intensity', 'low', 'mid', 'high', 'spectrum', 'onsets'].map((k) => result[k].buffer);
    self.postMessage({ type: 'done', result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};

function analyze(x, sr, progress) {
  const N = FFT_SIZE;
  const bins = N / 2;
  const nFrames = Math.max(8, Math.floor((x.length - N) / HOP) + 1);
  const frameRate = sr / HOP;
  const binHz = sr / N;
  const fft = new FFT(N);
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const frame = new Float32Array(N);
  const mag = new Float32Array(bins);
  let prev = new Float32Array(bins);
  let cur = new Float32Array(bins);
  const magNorm = 4 / N; // a full-scale sine lands near 1.0

  const binRange = (lo, hi) => [
    clamp(Math.round(lo / binHz), 1, bins - 1),
    clamp(Math.round(hi / binHz), 1, bins - 1),
  ];
  const bands = [binRange(30, 160), binRange(160, 2200), binRange(2200, Math.min(11000, sr * 0.48))];

  const power = new Float32Array(nFrames);
  const flux = bands.map(() => new Float32Array(nFrames));
  const energy = bands.map(() => new Float32Array(nFrames));

  const specLo = 40;
  const specHi = Math.min(14000, sr * 0.48);
  const specEdges = new Int32Array(SPEC_BANDS + 1);
  for (let b = 0; b <= SPEC_BANDS; b++) {
    const f = specLo * Math.pow(specHi / specLo, b / SPEC_BANDS);
    specEdges[b] = clamp(Math.round(f / binHz), 1, bins - 1);
    if (b > 0 && specEdges[b] <= specEdges[b - 1]) specEdges[b] = Math.min(bins - 1, specEdges[b - 1] + 1);
  }
  const spec = new Float32Array(nFrames * SPEC_BANDS);

  const progressEvery = Math.max(1, Math.floor(nFrames / 60));
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const v = off + i < x.length ? x[off + i] : 0;
      sumSq += v * v;
      frame[i] = v * win[i];
    }
    power[f] = sumSq / N;
    fft.magnitudes(frame, mag);
    for (let k = 0; k < bins; k++) cur[k] = Math.log1p(100 * mag[k] * magNorm);

    for (let b = 0; b < bands.length; b++) {
      const [k0, k1] = bands[b];
      let fl = 0;
      let en = 0;
      for (let k = k0; k <= k1; k++) {
        const d = cur[k] - prev[k];
        if (d > 0) fl += d;
        en += cur[k];
      }
      const count = k1 - k0 + 1;
      flux[b][f] = f === 0 ? 0 : fl / count;
      energy[b][f] = en / count;
    }
    for (let b = 0; b < SPEC_BANDS; b++) {
      const k0 = specEdges[b];
      const k1 = Math.max(k0, specEdges[b + 1] - 1);
      let s = 0;
      for (let k = k0; k <= k1; k++) s += cur[k];
      spec[f * SPEC_BANDS + b] = s / (k1 - k0 + 1);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    if (f % progressEvery === 0) progress((0.85 * f) / nFrames);
  }

  // --- Onsets -------------------------------------------------------------
  const centerOffset = N / 2 / sr;
  const timeOf = (f) => (f * HOP) / sr + centerOffset;
  const raw = [];
  const fluxNorms = [];
  for (let b = 0; b < bands.length; b++) {
    const odf = smooth3(flux[b]);
    const norm = Math.max(percentile(odf, 0.995), 0.01);
    fluxNorms.push(norm);
    for (let i = 0; i < odf.length; i++) odf[i] = Math.min(1.5, odf[i] / norm);
    for (const f of pickPeaks(odf, frameRate, 0.07)) {
      raw.push({ t: timeOf(f), s: odf[f] * BAND_WEIGHTS[b], b: 1 << b });
    }
  }
  raw.sort((a, b) => a.t - b.t);
  const merged = [];
  let anchor = -Infinity;
  for (const o of raw) {
    const last = merged[merged.length - 1];
    if (last && o.t - anchor < 0.035) {
      last.b |= o.b;
      if (o.s > last.s) {
        last.s = o.s;
        last.t = o.t;
      }
    } else {
      merged.push({ ...o });
      anchor = o.t;
    }
  }
  progress(0.9);

  // --- Intensity ----------------------------------------------------------
  const smoothPower = movingAverage(power, Math.round(0.75 * frameRate));
  const loudDb = smoothPower.map((v) => 10 * Math.log10(v + 1e-10));
  const fluxSum = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    fluxSum[i] = flux[0][i] / fluxNorms[0] + flux[1][i] / fluxNorms[1] + 0.7 * (flux[2][i] / fluxNorms[2]);
  }
  const busy = movingAverage(fluxSum, Math.round(1.0 * frameRate));
  const loudN = normalizeRobust(loudDb, 0.08, 0.98);
  const busyN = normalizeRobust(busy, 0.08, 0.98);
  const mix = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) mix[i] = 0.62 * loudN[i] + 0.38 * busyN[i];
  const level = normalizeRobust(movingAverage(mix, Math.round(0.6 * frameRate)), 0.02, 0.995);
  // Blend in a rank-equalized copy so even a uniformly loud master spans calm..intense.
  const ranked = equalize(level);
  const blended = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) blended[i] = 0.5 * level[i] + 0.5 * ranked[i];
  const intensity = movingAverage(blended, Math.round(0.25 * frameRate));

  // Band envelopes for visual pulses.
  const [low, mid, high] = energy.map((e) => normalizeRobust(movingAverage(e, 1), 0.05, 0.995));

  // Spectrogram normalised per band so every bar uses its full range.
  const spectrum = new Uint8Array(nFrames * SPEC_BANDS);
  const column = new Float32Array(nFrames);
  for (let b = 0; b < SPEC_BANDS; b++) {
    for (let f = 0; f < nFrames; f++) column[f] = spec[f * SPEC_BANDS + b];
    const lo = percentile(column, 0.15);
    const hi = Math.max(percentile(column, 0.995), lo + 1e-3);
    for (let f = 0; f < nFrames; f++) {
      const v = clamp((column[f] - lo) / (hi - lo), 0, 1);
      spectrum[f * SPEC_BANDS + b] = Math.round(Math.pow(v, 1.4) * 255);
    }
  }
  progress(0.96);

  const tempoOdf = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    tempoOdf[i] = (1.2 * flux[0][i]) / fluxNorms[0] + flux[1][i] / fluxNorms[1] + (0.5 * flux[2][i]) / fluxNorms[2];
  }
  const tempo = estimateTempo(tempoOdf, frameRate);

  const onsets = new Float32Array(merged.length * 3);
  merged.forEach((o, i) => {
    onsets[i * 3] = o.t;
    onsets[i * 3 + 1] = o.s;
    onsets[i * 3 + 2] = o.b;
  });
  progress(1);

  return {
    frameRate,
    intensity,
    low,
    mid,
    high,
    spectrum,
    specBands: SPEC_BANDS,
    onsets,
    bpm: tempo.bpm,
    beatOffset: tempo.offset + centerOffset,
  };
}

function smooth3(a) {
  const n = a.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = a[Math.max(0, i - 1)];
    const r = a[Math.min(n - 1, i + 1)];
    out[i] = 0.25 * l + 0.5 * a[i] + 0.25 * r;
  }
  return out;
}

function normalizeRobust(arr, pLo, pHi) {
  const lo = percentile(arr, pLo);
  const hi = percentile(arr, pHi);
  const out = new Float32Array(arr.length);
  if (hi - lo < 1e-6) {
    out.fill(0.4);
    return out;
  }
  for (let i = 0; i < arr.length; i++) out[i] = clamp((arr[i] - lo) / (hi - lo), 0, 1);
  return out;
}

// Maps each value to its percentile rank (histogram equalization).
function equalize(arr) {
  const n = arr.length;
  const sorted = Float32Array.from(arr).sort();
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < arr[i]) lo = mid + 1;
      else hi = mid;
    }
    out[i] = n > 1 ? lo / (n - 1) : 0.5;
  }
  return out;
}

// Peak picking in the style of librosa: local max, above a local mean plus delta.
function pickPeaks(odf, fr, delta) {
  const n = odf.length;
  const preMax = Math.max(1, Math.round(0.03 * fr));
  const postMax = Math.max(1, Math.round(0.03 * fr));
  const preAvg = Math.round(0.1 * fr);
  const postAvg = Math.round(0.07 * fr);
  const wait = Math.round(0.05 * fr);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + odf[i];
  const peaks = [];
  let last = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    const v = odf[i];
    if (v < delta) continue;
    let isMax = true;
    for (let j = Math.max(0, i - preMax); j <= Math.min(n - 1, i + postMax); j++) {
      if (odf[j] > v) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    const lo = Math.max(0, i - preAvg);
    const hi = Math.min(n - 1, i + postAvg);
    const mean = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
    if (v < mean + delta || i - last <= wait) continue;
    peaks.push(i);
    last = i;
  }
  return peaks;
}

// Autocorrelation tempo estimate with a log-normal prior around 120 BPM.
function estimateTempo(odf, fr) {
  const n = odf.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += odf[i];
  mean /= n;
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = Math.max(0, odf[i] - mean);

  const minLag = Math.max(2, Math.floor((fr * 60) / 200));
  const maxLag = Math.min(n - 2, Math.ceil((fr * 60) / 60));
  if (maxLag <= minLag + 2) return { bpm: 120, offset: 0 };

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
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const score = ac[lag] * prior;
    if (score > best) {
      best = score;
      bestLag = lag;
    }
  }
  const a = ac[bestLag - 1];
  const b = ac[bestLag];
  const c = ac[bestLag + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? clamp((0.5 * (a - c)) / denom, -0.5, 0.5) : 0;
  const lag = bestLag + shift;

  let bestPhase = 0;
  let bestSum = -1;
  for (let p = 0; p < Math.ceil(lag); p++) {
    let s = 0;
    for (let k = p; Math.round(k) < n; k += lag) s += o[Math.round(k)];
    if (s > bestSum) {
      bestSum = s;
      bestPhase = p;
    }
  }
  return { bpm: (60 * fr) / lag, offset: bestPhase / fr };
}
