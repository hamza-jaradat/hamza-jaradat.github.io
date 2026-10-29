// Harmonic/percussive separation by median filtering (Fitzgerald 2010): sustained
// tones are smooth across time, drum hits are smooth across frequency. Soft masks split
// every band of the spectrogram into a harmonic part and a percussive part.

const TIME_WINDOW = 31; // frames (~0.36 s): even short bass notes count as tones, not hits
const FREQ_WINDOW = 9; // bands (~14 semitones)

export function hpss(bands, nFrames, nb) {
  const harmonic = new Float32Array(bands.length);
  const percussive = new Float32Array(bands.length);
  for (let b = 0; b < nb; b++) slidingMedian(bands, harmonic, b, nb, nFrames, TIME_WINDOW);
  for (let f = 0; f < nFrames; f++) slidingMedian(bands, percussive, f * nb, 1, nb, FREQ_WINDOW);
  for (let i = 0; i < bands.length; i++) {
    const h = harmonic[i] * harmonic[i];
    const p = percussive[i] * percussive[i];
    const total = h + p + 1e-12;
    harmonic[i] = (bands[i] * h) / total;
    percussive[i] = (bands[i] * p) / total;
  }
  return { harmonic, percussive };
}

// Median over a window that slides along a strided sequence, kept sorted incrementally.
function slidingMedian(src, out, start, stride, count, win) {
  const half = win >> 1;
  const at = (i) => src[start + Math.min(count - 1, Math.max(0, i)) * stride];
  const sorted = new Float64Array(win);
  for (let j = -half; j <= half; j++) sorted[j + half] = at(j);
  sorted.sort();
  for (let i = 0; i < count; i++) {
    out[start + i * stride] = sorted[half];
    replaceSorted(sorted, at(i - half), at(i + half + 1));
  }
}

function replaceSorted(a, oldValue, newValue) {
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid] < oldValue) lo = mid + 1;
    else hi = mid;
  }
  let i = lo;
  if (newValue > oldValue) {
    while (i < a.length - 1 && a[i + 1] < newValue) {
      a[i] = a[i + 1];
      i++;
    }
  } else {
    while (i > 0 && a[i - 1] > newValue) {
      a[i] = a[i - 1];
      i--;
    }
  }
  a[i] = newValue;
}
