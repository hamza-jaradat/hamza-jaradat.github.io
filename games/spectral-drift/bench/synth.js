// A tiny synth for the benchmark's built-in test tracks: kick, snare, hats, pad chords and
// lead notes, mixed into one mono buffer whose beats and bars are known exactly.
import { mulberry32 } from '../src/util.js';

const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function track(seconds, sr = 22050, seed = 1) {
  const x = new Float32Array(Math.ceil(seconds * sr));
  const rng = mulberry32(seed);
  const noise = () => rng() * 2 - 1;
  // Mixes `seconds` of voice(i, s) in from time t (i: sample index, s: seconds since t).
  const add = (t, seconds, voice) => {
    const s0 = Math.max(0, Math.round(t * sr));
    const n = Math.min(Math.round(seconds * sr), x.length - s0);
    for (let i = 0; i < n; i++) x[s0 + i] += voice(i, i / sr);
  };
  const decay = (gain, s, over) => gain * Math.pow(0.001 / gain, Math.min(1, s / over));

  return {
    x,
    sr,
    kick(t, gain = 0.9) {
      let ph = 0;
      add(t, 0.4, (i, s) => {
        ph += (2 * Math.PI * (s < 0.12 ? 150 * Math.pow(45 / 150, s / 0.12) : 45)) / sr;
        return Math.sin(ph) * decay(gain, s, 0.35);
      });
    },
    snare(t, gain = 0.5) {
      const f = biquad('bandpass', 2000, 1, sr);
      add(t, 0.2, (i, s) => f(noise()) * decay(gain, s, 0.18));
    },
    hat(t, gain = 0.15) {
      const f = biquad('highpass', 8000, 0.7, sr);
      add(t, 0.06, (i, s) => f(noise()) * decay(gain, s, 0.05));
    },
    // Sawtooth pad: slow attack, held, short release.
    chord(t, seconds, notes, vol = 0.05) {
      for (const m of notes) voice(t, seconds, hz(m), 1200, (s) => vol * Math.min(1, s / 0.3, (seconds - s) / 0.1));
    },
    // Sawtooth lead: quick attack, held, short release.
    note(t, seconds, midi, vol = 0.25, attack = 0.01) {
      const release = seconds - 0.05;
      voice(t, seconds, hz(midi), 2500, (s) => (s < attack ? vol * (s / attack) : s < release ? vol : 0.8 * vol * ((seconds - s) / 0.05)));
    },
  };

  function voice(t, seconds, freq, cutoff, env) {
    const f = biquad('lowpass', cutoff, 0.7, sr);
    let ph = 0;
    add(t, seconds, (i, s) => {
      ph = (ph + freq / sr) % 1;
      return f(2 * ph - 1) * Math.max(0, env(s));
    });
  }
}

// RBJ cookbook biquad, one sample at a time.
function biquad(type, f0, q, sr) {
  const w = (2 * Math.PI * f0) / sr;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const [b0, b1, b2] =
    type === 'lowpass' ? [(1 - cos) / 2, 1 - cos, (1 - cos) / 2] : type === 'highpass' ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2] : [alpha, 0, -alpha];
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x0) => {
    const y = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y;
    return y;
  };
}
