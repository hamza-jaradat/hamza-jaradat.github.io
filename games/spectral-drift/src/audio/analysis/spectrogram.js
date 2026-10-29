// Short-time spectrum folded into log-spaced bands: the shared input for onset
// detection, harmonic/percussive separation, intensity and the visual spectrum.
import { clamp } from '../../util.js';
import { FFT } from '../fft.js';

export const FFT_SIZE = 1024;
export const HOP = 256;
export const BANDS = 64;
const BAND_LO = 30;

export function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

export function spectrogram(x, sr, progress) {
  const N = FFT_SIZE;
  const bins = N / 2;
  const nFrames = Math.max(8, Math.floor((x.length - N) / HOP) + 1);
  const binHz = sr / N;
  const top = Math.min(11000, sr * 0.48);

  // Log-spaced band edges (in bins), at least one bin per band.
  const edges = new Int32Array(BANDS + 1);
  for (let b = 0; b <= BANDS; b++) {
    edges[b] = clamp(Math.round((BAND_LO * Math.pow(top / BAND_LO, b / BANDS)) / binHz), 1, bins - 1);
    if (b > 0 && edges[b] <= edges[b - 1]) edges[b] = Math.min(bins - 1, edges[b - 1] + 1);
  }
  const centers = new Float32Array(BANDS);
  for (let b = 0; b < BANDS; b++) centers[b] = ((edges[b] + Math.max(edges[b], edges[b + 1] - 1)) / 2) * binHz;

  const fft = new FFT(N);
  const win = hann(N);
  const frame = new Float32Array(N);
  const mag = new Float32Array(bins);
  const power = new Float32Array(nFrames);
  const bands = new Float32Array(nFrames * BANDS);
  const magNorm = 4 / N; // a full-scale sine lands near 1.0
  const every = Math.max(1, Math.floor(nFrames / 40));

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
    const row = f * BANDS;
    for (let b = 0; b < BANDS; b++) {
      const k0 = edges[b];
      const k1 = Math.max(k0, edges[b + 1] - 1);
      let s = 0;
      for (let k = k0; k <= k1; k++) s += mag[k];
      bands[row + b] = (s / (k1 - k0 + 1)) * magNorm;
    }
    if (f % every === 0) progress(f / nFrames);
  }

  return { nFrames, frameRate: sr / HOP, centerOffset: N / 2 / sr, power, bands, centers };
}

// Indices of the bands whose centre frequency lies in [lo, hi).
export function bandRange(centers, lo, hi) {
  let b0 = 0;
  while (b0 < centers.length - 1 && centers[b0] < lo) b0++;
  let b1 = b0;
  while (b1 < centers.length && centers[b1] < hi) b1++;
  return [b0, Math.max(b0 + 1, b1)];
}
