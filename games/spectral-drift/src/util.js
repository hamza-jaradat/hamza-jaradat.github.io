export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// Frame-rate independent exponential approach factor.
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Linear sample of an array at fractional index, clamped to its ends.
export function sampleArray(arr, f) {
  const n = arr.length;
  if (n === 0) return 0;
  if (f <= 0) return arr[0];
  if (f >= n - 1) return arr[n - 1];
  const i = Math.floor(f);
  const a = f - i;
  return arr[i] + (arr[i + 1] - arr[i]) * a;
}

// Centered moving average with the given radius (in samples), via prefix sums.
export function movingAverage(arr, radius) {
  const n = arr.length;
  const out = new Float32Array(n);
  if (radius < 1) {
    out.set(arr);
    return out;
  }
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + arr[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n - 1, i + radius);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

export function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = Float32Array.from(arr).sort();
  return sorted[clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1)];
}

export function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
