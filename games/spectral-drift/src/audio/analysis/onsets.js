// Onset strength (half-wave rectified log-spectral flux) per instrument layer, and
// peak picking into note events.
import { percentile } from '../../util.js';

export const ONSET = { KICK: 1, SNARE: 2, HAT: 4, TONE: 8 };
export const ONSET_FIELDS = 5; // packed per onset: t, strength, layer flags, pitch (MIDI or NaN), sustain (s)
const MERGE_WINDOW = 0.035;

export function logSpec(spec, gain = 100) {
  const out = new Float32Array(spec.length);
  for (let i = 0; i < spec.length; i++) out[i] = Math.log1p(gain * spec[i]);
  return out;
}

// Mean positive change across bands [b0, b1) from frame to frame.
export function flux(logS, nFrames, nb, [b0, b1]) {
  const out = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f++) {
    let s = 0;
    for (let b = b0; b < b1; b++) {
      const d = logS[f * nb + b] - logS[(f - 1) * nb + b];
      if (d > 0) s += d;
    }
    out[f] = s / (b1 - b0);
  }
  return out;
}

// Smoothed onset strength per layer, normalised so 1.0 ~ that layer's strongest hits.
// A layer is never scaled up past `share` of the strongest layer's scale, nor past its
// own absolute floor (`floors`, in flux units), so a song with no drums doesn't turn
// faint noise in the drum layers into a beat.
export function strengths(fluxCurves, share = 0.35, floors = []) {
  const smoothed = fluxCurves.map((curve) => {
    const n = curve.length;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.25 * curve[Math.max(0, i - 1)] + 0.5 * curve[i] + 0.25 * curve[Math.min(n - 1, i + 1)];
    return out;
  });
  const scales = smoothed.map((s) => percentile(s, 0.995));
  const floor = Math.max(0.01, share * Math.max(...scales));
  return smoothed.map((s, k) => {
    const norm = Math.max(scales[k], floor, floors[k] ?? 0);
    for (let i = 0; i < s.length; i++) s[i] = Math.min(1.5, s[i] / norm);
    return s;
  });
}

// Picks onsets in each layer and merges hits that coincide into single events.
export function detectOnsets(layers, frameRate, timeOf) {
  const raw = [];
  for (const { curve, type, weight, delta, sharp } of layers) {
    for (const f of pickPeaks(curve, frameRate, delta, sharp)) raw.push({ f, t: timeOf(f), s: curve[f] * weight, b: type });
  }
  raw.sort((a, b) => a.t - b.t);
  const events = [];
  let anchor = -Infinity;
  for (const o of raw) {
    const last = events[events.length - 1];
    if (last && o.t - anchor < MERGE_WINDOW) {
      last.b |= o.b;
      if (o.s > last.s) {
        last.s = o.s;
        last.t = o.t;
        last.f = o.f;
      }
    } else {
      events.push({ ...o });
      anchor = o.t;
    }
  }
  return events;
}

// Peak picking in the style of librosa: local max, above a local mean plus delta. A peak
// must also stand `sharp` times above that mean: real attacks are impulsive, while the slow
// swells and beating of sustained sounds rise and fall smoothly.
export function pickPeaks(odf, fr, delta, sharp = 0) {
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
    if (v < mean + delta || v < sharp * mean || i - last <= wait) continue;
    peaks.push(i);
    last = i;
  }
  return peaks;
}
