// A small software synth that composes the built-in demo track sample by sample.
import { mulberry32 } from '../util.js';

export const SR = 44100;
const BPM = 124;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const S16 = BEAT / 4;
const START = 0.1;
const TWO_PI = Math.PI * 2;

const SECTIONS = [
  ['intro', 8],
  ['buildA', 8],
  ['drop1', 16],
  ['breakdown', 8],
  ['buildB', 8],
  ['drop2', 16],
  ['outro', 8],
];

// A minor: Am - F - C - G
const PROG = [
  { root: 45, chord: [57, 60, 64] },
  { root: 41, chord: [57, 60, 65] },
  { root: 48, chord: [55, 60, 64] },
  { root: 43, chord: [55, 59, 62] },
];
const ARP = [0, 1, 2, 3, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 4, 3];

const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const panGains = (p) => [Math.cos(((p + 1) * Math.PI) / 4), Math.sin(((p + 1) * Math.PI) / 4)];

// PolyBLEP correction for a naive sawtooth.
function blep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

// Topology-preserving state variable filter (Simper).
class SVF {
  constructor(fc = 1000, q = 0.707) {
    this.ic1 = 0;
    this.ic2 = 0;
    this.low = 0;
    this.band = 0;
    this.high = 0;
    this.set(fc, q);
  }
  set(fc, q) {
    const g = Math.tan((Math.PI * Math.min(fc, SR * 0.45)) / SR);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  tick(v0) {
    const v3 = v0 - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = v1;
    this.high = v0 - this.k * v1 - v2;
  }
}

class Comb {
  constructor(n) {
    this.buf = new Float32Array(n);
    this.i = 0;
    this.store = 0;
  }
  process(x, fb, damp) {
    const y = this.buf[this.i];
    this.store = y * (1 - damp) + this.store * damp;
    this.buf[this.i] = x + this.store * fb;
    if (++this.i >= this.buf.length) this.i = 0;
    return y;
  }
}

class Allpass {
  constructor(n) {
    this.buf = new Float32Array(n);
    this.i = 0;
  }
  process(x) {
    const b = this.buf[this.i];
    this.buf[this.i] = x + b * 0.5;
    if (++this.i >= this.buf.length) this.i = 0;
    return b - x;
  }
}

// The arrangement, so tools can tell where the demo's beats, bars and drops are.
export const DEMO_LAYOUT = { bpm: BPM, start: START, sections: SECTIONS };

export function compose() {
  const totalBars = SECTIONS.reduce((n, s) => n + s[1], 0);
  const length = Math.ceil((START + totalBars * BAR + 4) * SR);
  const rng = mulberry32(0x5eed1e55);
  const noise = () => rng() * 2 - 1;
  const bus = () => ({ L: new Float32Array(length), R: new Float32Array(length) });
  const drums = bus();
  const pumped = bus(); // ducked by the kick
  const revSend = bus();
  const dlySend = bus();
  const duck = new Float32Array(length).fill(1);
  const span = (t, dur) => {
    const s0 = Math.max(0, Math.round(t * SR));
    return [s0, Math.max(0, Math.min(Math.round(dur * SR), length - s0))];
  };
  // Every pitched note played, for the benchmark's note scores: { t, dur, midi, part }.
  const notes = [];

  // --- Instruments --------------------------------------------------------
  function kick(t, vel = 1, sidechain = true) {
    const [s0, len] = span(t, 0.42);
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const tt = i / SR;
      ph += (44 + 120 * Math.exp(-tt * 30)) / SR;
      const v = Math.sin(TWO_PI * ph) * Math.exp(-tt * 7) * Math.min(1, i / 40) * vel * 0.95;
      drums.L[s0 + i] += v;
      drums.R[s0 + i] += v;
    }
    if (!sidechain) return;
    const [, dl] = span(t, 0.32);
    for (let i = 0; i < dl; i++) {
      const tt = i / SR;
      const g = 1 - 0.68 * Math.exp(-tt * 13) * Math.min(1, tt / 0.004);
      if (g < duck[s0 + i]) duck[s0 + i] = g;
    }
  }

  function snare(t, vel = 1) {
    const [s0, len] = span(t, 0.24);
    const bp = new SVF(1900, 0.9);
    const hp = new SVF(5000, 0.7);
    let ph = 0;
    for (let i = 0; i < len; i++) {
      const tt = i / SR;
      const n = noise();
      bp.tick(n);
      hp.tick(n);
      ph += 190 / SR;
      const tone = (Math.abs((ph % 1) * 4 - 2) - 1) * Math.exp(-tt * 38);
      const v = ((bp.band * 1.3 + hp.high * 0.35) * Math.exp(-tt * 20) + tone * 0.45) * vel * 0.55 * Math.min(1, i / 20);
      drums.L[s0 + i] += v;
      drums.R[s0 + i] += v;
      revSend.L[s0 + i] += v * 0.25;
      revSend.R[s0 + i] += v * 0.25;
    }
  }

  function hat(t, vel = 1, open = false, pan = 0.25) {
    const [s0, len] = span(t, open ? 0.32 : 0.07);
    const hp = new SVF(8000, 0.8);
    const [gl, gr] = panGains(pan);
    const rate = open ? 11 : 65;
    for (let i = 0; i < len; i++) {
      hp.tick(noise());
      const v = hp.high * Math.exp(-(i / SR) * rate) * vel * 0.22;
      drums.L[s0 + i] += v * gl;
      drums.R[s0 + i] += v * gr;
    }
  }

  function bass(t, midi, dur, vel = 1, bright = 0.5) {
    notes.push({ t, dur, midi, part: 'bass' });
    const f = hz(midi);
    const dt = f / SR;
    const [s0, len] = span(t, dur + 0.03);
    const lp = new SVF();
    const base = 140 + 320 * bright;
    const peak = 450 + 2600 * bright;
    let ph = 0;
    let sub = 0;
    for (let i = 0; i < len; i++) {
      const tt = i / SR;
      if ((i & 15) === 0) lp.set(base + (peak - base) * Math.exp(-tt * 16), 2.4);
      ph += dt;
      if (ph >= 1) ph -= 1;
      sub += dt * 0.5;
      if (sub >= 1) sub -= 1;
      lp.tick((2 * ph - 1 - blep(ph, dt)) * 0.7 + Math.sin(TWO_PI * sub) * 0.6);
      const amp = Math.min(1, i / (0.004 * SR)) * (tt > dur ? Math.max(0, 1 - (tt - dur) / 0.03) : 1);
      const v = lp.low * amp * vel * 0.34;
      pumped.L[s0 + i] += v;
      pumped.R[s0 + i] += v;
    }
  }

  function pluck(t, midi, dur, vel = 1, cutoff = 2000, pan = 0) {
    notes.push({ t, dur, midi, part: 'lead' });
    const f = hz(midi);
    const d1 = (f * Math.pow(2, -8 / 1200)) / SR;
    const d2 = (f * Math.pow(2, 8 / 1200)) / SR;
    const [s0, len] = span(t, dur + 0.3);
    const lp = new SVF();
    const [gl, gr] = panGains(pan);
    let p1 = rng();
    let p2 = rng();
    for (let i = 0; i < len; i++) {
      const tt = i / SR;
      if ((i & 15) === 0) lp.set(cutoff * (0.35 + 2.4 * Math.exp(-tt * 16)), 1.3);
      p1 += d1;
      if (p1 >= 1) p1 -= 1;
      p2 += d2;
      if (p2 >= 1) p2 -= 1;
      lp.tick(2 * p1 - 1 - blep(p1, d1) + (2 * p2 - 1 - blep(p2, d2)));
      const amp = Math.min(1, i / (0.003 * SR)) * Math.exp(-tt * 7) * (tt > dur ? Math.exp(-(tt - dur) * 18) : 1);
      const v = lp.low * amp * vel * 0.085;
      const l = v * gl;
      const r = v * gr;
      pumped.L[s0 + i] += l;
      pumped.R[s0 + i] += r;
      dlySend.L[s0 + i] += l * 0.6;
      dlySend.R[s0 + i] += r * 0.6;
      revSend.L[s0 + i] += v * 0.3;
      revSend.R[s0 + i] += v * 0.3;
    }
  }

  function pad(t, chord, dur, vel = 1, cutoff = 1500) {
    for (const midi of chord) notes.push({ t, dur, midi, part: 'pad' });
    const [s0, len] = span(t, dur + 0.6);
    const lpL = new SVF(cutoff, 0.8);
    const lpR = new SVF(cutoff, 0.8);
    const voices = [chord[0] - 12, ...chord].map((m) => ({
      dL: (hz(m) * Math.pow(2, -10 / 1200)) / SR,
      dR: (hz(m) * Math.pow(2, 10 / 1200)) / SR,
      pL: rng(),
      pR: rng(),
    }));
    for (let i = 0; i < len; i++) {
      let sl = 0;
      let sr = 0;
      for (const v of voices) {
        v.pL += v.dL;
        if (v.pL >= 1) v.pL -= 1;
        v.pR += v.dR;
        if (v.pR >= 1) v.pR -= 1;
        sl += 2 * v.pL - 1 - blep(v.pL, v.dL);
        sr += 2 * v.pR - 1 - blep(v.pR, v.dR);
      }
      lpL.tick(sl);
      lpR.tick(sr);
      const tt = i / SR;
      const g = Math.min(1, tt / 0.35) * (tt > dur ? Math.max(0, 1 - (tt - dur) / 0.6) : 1) * vel * 0.04;
      pumped.L[s0 + i] += lpL.low * g;
      pumped.R[s0 + i] += lpR.low * g;
      revSend.L[s0 + i] += lpL.low * g * 0.6;
      revSend.R[s0 + i] += lpR.low * g * 0.6;
    }
  }

  function riser(t, dur, vel = 1) {
    const [s0, len] = span(t, dur);
    const bp = new SVF();
    for (let i = 0; i < len; i++) {
      const x = i / SR / dur;
      if ((i & 15) === 0) bp.set(350 * Math.pow(20, x), 2.5);
      bp.tick(noise());
      const v = bp.band * x * x * vel * 0.35;
      drums.L[s0 + i] += v;
      drums.R[s0 + i] += v;
      revSend.L[s0 + i] += v * 0.4;
      revSend.R[s0 + i] += v * 0.4;
    }
  }

  function crash(t, vel = 1) {
    const [s0, len] = span(t, 2.4);
    const hpL = new SVF(4500, 0.7);
    const hpR = new SVF(4500, 0.7);
    for (let i = 0; i < len; i++) {
      hpL.tick(noise());
      hpR.tick(noise());
      const env = Math.exp(-(i / SR) * 2) * Math.min(1, i / 50) * vel * 0.16;
      drums.L[s0 + i] += hpL.high * env;
      drums.R[s0 + i] += hpR.high * env;
      revSend.L[s0 + i] += hpL.high * env * 0.3;
      revSend.R[s0 + i] += hpR.high * env * 0.3;
    }
  }

  // --- Patterns -----------------------------------------------------------
  const kicks = (t0, beats, vel = 1) => beats.forEach((b) => kick(t0 + b * BEAT, vel));
  const hats8 = (t0, vel, offbeatOnly = false) => {
    for (let s = 0; s < 8; s++) {
      if (offbeatOnly && s % 2 === 0) continue;
      hat(t0 + (s * BEAT) / 2, vel * (s % 2 ? 1 : 0.6));
    }
  };
  const hats16 = (t0, vel) => {
    for (let s = 0; s < 16; s++) hat(t0 + s * S16, vel * (s % 4 === 2 ? 1 : s % 2 ? 0.45 : 0.7), false, s % 2 ? 0.35 : 0.15);
  };
  const openHats = (t0, vel) => {
    for (let b = 0; b < 4; b++) hat(t0 + (b + 0.5) * BEAT, vel, true, -0.2);
  };
  const backbeat = (t0, vel) => {
    snare(t0 + BEAT, vel);
    snare(t0 + 3 * BEAT, vel);
  };
  const roll = (t0, div, v0, v1) => {
    const n = 4 * div;
    for (let k = 0; k < n; k++) snare(t0 + (k * BEAT) / div, v0 + ((v1 - v0) * k) / n);
  };
  const rollingBass = (t0, root, bright) => {
    for (let s = 0; s < 16; s++) {
      if (s % 4 === 0) continue;
      bass(t0 + s * S16, root + (s % 4 === 2 ? 12 : 0), S16 * 0.85, s % 4 === 2 ? 1 : 0.8, bright);
    }
  };
  const offBass = (t0, root, bright) => {
    for (let b = 0; b < 4; b++) bass(t0 + (b + 0.5) * BEAT, root, BEAT * 0.42, 1, bright);
  };
  const arp = (t0, chord, vel, cutoff, octave = 12, steps = 16) => {
    const tones = [chord[0], chord[1], chord[2], chord[0] + 12, chord[1] + 12, chord[2] + 12];
    const step = BAR / steps;
    for (let s = 0; s < steps; s++) {
      const note = tones[ARP[((s * 16) / steps) % 16 | 0]] + octave;
      pluck(t0 + s * step, note, step * 0.9, vel * (s % 4 === 0 ? 1 : 0.78), cutoff, s % 2 ? 0.3 : -0.3);
    }
  };

  // --- Arrangement --------------------------------------------------------
  let bar = 0;
  for (const [name, bars] of SECTIONS) {
    for (let i = 0; i < bars; i++, bar++) {
      const t0 = START + bar * BAR;
      const { root, chord } = PROG[bar % 4];
      const p = i / bars;
      switch (name) {
        case 'intro':
          pad(t0, chord, BAR, 0.8, 500 + 900 * p);
          if (i >= 4) {
            hats8(t0, 0.35, true);
            arp(t0, chord, 0.4, 700 + 700 * p, 12, 8);
          }
          if (i === 6) riser(t0, 2 * BAR, 0.5);
          break;
        case 'buildA':
          pad(t0, chord, BAR, 0.75, 1200 + 1000 * p);
          kicks(t0, i < 7 ? [0, 1, 2, 3] : [0, 1], 0.9);
          if (i < 7) offBass(t0, root, 0.2 + 0.4 * p);
          hats8(t0, 0.5);
          arp(t0, chord, 0.5, 1200 + 1800 * p);
          if (i === 4 || i === 5) backbeat(t0, 0.6);
          if (i === 6) {
            roll(t0, 2, 0.35, 0.7);
            riser(t0, 2 * BAR, 0.9);
          }
          if (i === 7) roll(t0, 4, 0.45, 1.0);
          break;
        case 'drop1':
        case 'drop2': {
          const second = name === 'drop2';
          if (i === 0 || i === 8) crash(t0, i === 0 ? 1 : 0.7);
          kicks(t0, [0, 1, 2, 3], 1);
          backbeat(t0, 0.85);
          hats16(t0, 0.5);
          openHats(t0, 0.32);
          rollingBass(t0, root, second ? 0.85 : 0.7);
          arp(t0, chord, 0.8, second ? 3800 : 3000);
          if (second) arp(t0, chord, 0.45, 5000, 24, 8);
          pad(t0, chord, BAR, 0.55, 2600);
          if (i % 4 === 3) for (let k = 0; k < 4; k++) snare(t0 + 3 * BEAT + k * S16, 0.45 + 0.15 * k);
          break;
        }
        case 'breakdown': {
          pad(t0, chord, BAR, 0.95, 900 + 500 * p);
          const melody = [chord[2], chord[1], chord[0], chord[1]];
          for (let b = 0; b < 4; b++) pluck(t0 + b * BEAT, melody[b] + 12, BEAT * 0.9, 0.75, 1600, b % 2 ? 0.25 : -0.25);
          bass(t0, root, BAR * 0.95, 0.55, 0.05);
          if (i >= 4) hats8(t0, 0.3, true);
          break;
        }
        case 'buildB':
          pad(t0, chord, BAR, 0.8, 900 + 2400 * p);
          if (i < 7) {
            kicks(t0, i < 4 ? [0, 2] : [0, 1, 2, 3], 0.95);
            offBass(t0, root, 0.3 + 0.5 * p);
          }
          arp(t0, chord, 0.55 + 0.3 * p, 1000 + 3000 * p);
          if (i >= 4) hats16(t0, 0.45);
          else hats8(t0, 0.45);
          if (i === 2 || i === 3) backbeat(t0, 0.6);
          if (i === 4 || i === 5) roll(t0, 2, 0.4 + 0.1 * (i - 4), 0.6 + 0.1 * (i - 4));
          if (i === 6) roll(t0, 4, 0.55, 0.85);
          if (i === 7) roll(t0, 8, 0.6, 1.0);
          if (i === 4) riser(t0, 4 * BAR, 1);
          break;
        case 'outro':
          pad(t0, chord, i === bars - 1 ? BAR * 1.8 : BAR, 0.8 * (1 - 0.6 * p), 2000 - 1300 * p);
          if (i < 4) {
            kicks(t0, [0, 1, 2, 3], 0.85);
            hats8(t0, 0.4);
            offBass(t0, root, 0.3);
            arp(t0, chord, 0.5, 1500, 12, 8);
          } else {
            arp(t0, chord, 0.4 * (1 - p), 900, 12, 4);
          }
          break;
      }
    }
  }

  // --- Effects & mixdown ----------------------------------------------------
  const fx = bus();

  // Ping-pong delay (dotted eighth) with damped feedback.
  {
    const d = Math.round(BEAT * 0.75 * SR);
    const bufL = new Float32Array(d);
    const bufR = new Float32Array(d);
    let idx = 0;
    let lpL = 0;
    let lpR = 0;
    for (let i = 0; i < length; i++) {
      const yl = bufL[idx];
      const yr = bufR[idx];
      lpL += (yr - lpL) * 0.35;
      lpR += (yl - lpR) * 0.35;
      bufL[idx] = (dlySend.L[i] + dlySend.R[i]) * 0.5 + lpL * 0.4;
      bufR[idx] = lpR * 0.4;
      fx.L[i] += yl * 0.55;
      fx.R[i] += yr * 0.55;
      if (++idx >= d) idx = 0;
    }
  }

  // Freeverb-style reverb.
  {
    const combL = [1116, 1188, 1277, 1356].map((n) => new Comb(n));
    const combR = [1139, 1211, 1300, 1379].map((n) => new Comb(n));
    const apL = [556, 441, 341].map((n) => new Allpass(n));
    const apR = [579, 464, 364].map((n) => new Allpass(n));
    for (let i = 0; i < length; i++) {
      const x = (revSend.L[i] + revSend.R[i]) * 0.03;
      let l = 0;
      let r = 0;
      for (let c = 0; c < 4; c++) {
        l += combL[c].process(x, 0.84, 0.25);
        r += combR[c].process(x, 0.84, 0.25);
      }
      for (let a = 0; a < 3; a++) {
        l = apL[a].process(l);
        r = apR[a].process(r);
      }
      fx.L[i] += l * 0.9;
      fx.R[i] += r * 0.9;
    }
  }

  const left = new Float32Array(length);
  const right = new Float32Array(length);
  let peak = 1e-6;
  for (let i = 0; i < length; i++) {
    const d = duck[i];
    const l = drums.L[i] + pumped.L[i] * d + fx.L[i] * (0.6 + 0.4 * d);
    const r = drums.R[i] + pumped.R[i] * d + fx.R[i] * (0.6 + 0.4 * d);
    left[i] = l;
    right[i] = r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
  }
  // Gentle saturation, then land the peaks around -1 dBFS.
  const drive = 1.3 / peak;
  const norm = 0.89 / Math.tanh(1.3);
  for (let i = 0; i < length; i++) {
    left[i] = Math.tanh(left[i] * drive) * norm;
    right[i] = Math.tanh(right[i] * drive) * norm;
  }
  return { left, right, notes };
}
