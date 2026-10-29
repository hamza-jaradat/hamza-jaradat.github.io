// Pitch content from a longer FFT: a 12-bin chroma per frame (harmony, for finding bars
// and sections) and the most salient pitch (to follow the melody).
import { FFT } from '../fft.js';
import { hann } from './spectrogram.js';

const N = 4096;
const HOP = 1024;
const MIDI_LO = 48; // C3
const MIDI_HI = 88; // E6
const HARMONICS = 6;

export function pitchTrack(x, sr, progress) {
  const bins = N / 2;
  const binHz = sr / N;
  const n = Math.max(1, Math.floor((x.length - N) / HOP) + 1);
  const chroma = new Float32Array(n * 12);
  const pitch = new Float32Array(n).fill(NaN);
  const salience = new Float32Array(n);
  const energy = new Float32Array(n);

  const pitchClass = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = k * binHz;
    if (f >= 65 && f <= 2100) pitchClass[k] = (((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12);
  }
  const candidates = [];
  for (let m = MIDI_LO; m <= MIDI_HI; m++) candidates.push(440 * Math.pow(2, (m - 69) / 12));

  const fft = new FFT(N);
  const win = hann(N);
  const frame = new Float32Array(N);
  const mag = new Float32Array(bins);
  const white = new Float32Array(bins);
  const prefix = new Float64Array(bins + 1);
  const scores = new Float32Array(candidates.length);
  const every = Math.max(1, Math.floor(n / 20));

  for (let i = 0; i < n; i++) {
    const off = i * HOP;
    for (let j = 0; j < N; j++) frame[j] = (off + j < x.length ? x[off + j] : 0) * win[j];
    fft.magnitudes(frame, mag);

    const c = chroma.subarray(i * 12, i * 12 + 12);
    let total = 0;
    for (let k = 1; k < bins; k++) {
      const e = mag[k] * mag[k];
      total += e;
      if (pitchClass[k] >= 0) c[pitchClass[k]] += e;
    }
    energy[i] = total;
    let cmax = 0;
    for (let p = 0; p < 12; p++) {
      c[p] = Math.log1p(c[p] * 1e-3);
      cmax = Math.max(cmax, c[p]);
    }
    if (cmax > 0) for (let p = 0; p < 12; p++) c[p] /= cmax;

    // Whiten (divide by the local spectral average) so timbre doesn't decide the pitch.
    for (let k = 0; k < bins; k++) prefix[k + 1] = prefix[k] + mag[k];
    for (let k = 0; k < bins; k++) {
      const lo = Math.max(0, k - 24);
      const hi = Math.min(bins, k + 25);
      white[k] = mag[k] / ((prefix[hi] - prefix[lo]) / (hi - lo) + 1e-9);
    }
    let best = 0;
    let bestIdx = -1;
    let sum = 0;
    // Harmonic sum, minus what sits halfway between the harmonics: energy there means the
    // real fundamental is an octave lower (the classic octave error of harmonic summation).
    const at = (kf) => {
      const k0 = Math.floor(kf);
      return white[k0] + (white[k0 + 1] - white[k0]) * (kf - k0);
    };
    for (let ci = 0; ci < candidates.length; ci++) {
      let s = 0;
      let w = 1;
      for (let h = 1; h <= HARMONICS; h++) {
        const kf = (candidates[ci] * h) / binHz;
        if (kf >= bins - 1) break;
        s += w * (at(kf) - 0.5 * at((candidates[ci] * (h - 0.5)) / binHz));
        w *= 0.82;
      }
      scores[ci] = s;
      sum += Math.max(0, s);
      if (s > best) {
        best = s;
        bestIdx = ci;
      }
    }
    const sal = best / (sum / candidates.length + 1e-9);
    salience[i] = sal;
    if (bestIdx >= 0 && sal > 1.6) {
      const a = scores[Math.max(0, bestIdx - 1)];
      const b = scores[bestIdx];
      const d = scores[Math.min(candidates.length - 1, bestIdx + 1)];
      const den = a - 2 * b + d;
      pitch[i] = MIDI_LO + bestIdx + (den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - d)) / den)) : 0);
    }
    if (i % every === 0) progress(i / n);
  }

  // Quiet frames carry no melody.
  const loud = [...energy].sort((a, b) => a - b)[Math.floor(n * 0.6)] * 0.02;
  for (let i = 0; i < n; i++) if (energy[i] < loud) pitch[i] = NaN;

  return { rate: sr / HOP, offset: N / 2 / sr, chroma, pitch, salience };
}

// Median pitch (MIDI) over [t0, t1], ignoring unpitched frames; NaN if mostly unpitched.
export function pitchAt(track, t0, t1) {
  const i0 = Math.max(0, Math.floor((t0 - track.offset) * track.rate));
  const i1 = Math.min(track.pitch.length - 1, Math.ceil((t1 - track.offset) * track.rate));
  const found = [];
  for (let i = i0; i <= i1; i++) if (!Number.isNaN(track.pitch[i])) found.push(track.pitch[i]);
  if (found.length === 0 || found.length < (i1 - i0 + 1) / 2) return NaN;
  found.sort((a, b) => a - b);
  return found[found.length >> 1];
}

// Mean chroma vector over [t0, t1) (unit length).
export function chromaBetween(track, t0, t1, out = new Float32Array(12)) {
  out.fill(0);
  const i0 = Math.max(0, Math.floor((t0 - track.offset) * track.rate));
  const i1 = Math.min(track.pitch.length, Math.max(i0 + 1, Math.ceil((t1 - track.offset) * track.rate)));
  for (let i = i0; i < i1; i++) for (let p = 0; p < 12; p++) out[p] += track.chroma[i * 12 + p];
  let len = 0;
  for (let p = 0; p < 12; p++) len += out[p] * out[p];
  len = Math.sqrt(len) || 1;
  for (let p = 0; p < 12; p++) out[p] /= len;
  return out;
}
