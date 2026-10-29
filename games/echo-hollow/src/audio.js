// Synthesized sound, all routed through a damped feedback delay that plays the cave's echo.
import { clamp } from './util.js';

const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  // Call from a user gesture (browsers only start audio after one).
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    const ctx = (this.ctx = new AudioContext());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ctx.destination);

    this.echo = ctx.createDelay(1);
    this.echo.delayTime.value = 0.23;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.42;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 1800;
    this.echo.connect(tone).connect(feedback).connect(this.echo);
    const wet = ctx.createGain();
    wet.gain.value = 0.5;
    tone.connect(wet).connect(this.master);

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.drone();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.8, this.ctx.currentTime, 0.05);
    return this.muted;
  }

  suspend(paused) {
    if (!this.ctx) return;
    if (paused) this.ctx.suspend();
    else this.ctx.resume();
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  // A voice: gain -> panner -> master, with some sent to the echo.
  out(pan = 0, send = 0.5) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    g.connect(p).connect(this.master);
    if (send > 0) {
      const s = ctx.createGain();
      s.gain.value = send;
      p.connect(s).connect(this.echo);
    }
    return g;
  }

  tone(type, f0, f1, at, dur, peak, dest) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, at);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(dest);
    o.start(at);
    o.stop(at + dur + 0.05);
  }

  noiseBurst(filter, freq, at, dur, peak, dest) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(f).connect(g).connect(dest);
    src.start(at, Math.random() * 0.5, dur + 0.05);
  }

  ping() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this.out(0, 0.9);
    this.tone('sine', 2100, 760, t, 0.32, 0.3, out);
    this.tone('triangle', 4200, 1500, t, 0.08, 0.05, out);
  }

  tinkle(pan, loudness) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const note = 1567.98 * Math.pow(2, PENTATONIC[Math.floor(Math.random() * 5)] / 12);
    this.tone('sine', note, note, t, 0.5, 0.05 * loudness, this.out(pan, 0.8));
  }

  chime(count) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const note = 783.99 * Math.pow(2, PENTATONIC[(count - 1) % PENTATONIC.length] / 12);
    const out = this.out(0, 0.7);
    this.tone('sine', note, note, t, 0.7, 0.22, out);
    this.tone('triangle', note * 2, note * 2, t + 0.04, 0.4, 0.06, out);
  }

  growl(pan, loudness) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.out(pan, 0.3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(260, t);
    lp.frequency.linearRampToValueAtTime(520, t + 0.25);
    lp.frequency.linearRampToValueAtTime(200, t + 0.8);
    lp.connect(out);
    for (const f of [58, 61.5]) this.tone('sawtooth', f, f * 0.8, t, 0.85, 0.22 * loudness, lp);
  }

  heartbeat(strength) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this.out(0, 0);
    const peak = 0.18 + 0.35 * strength;
    this.tone('sine', 62, 38, t, 0.16, peak, out);
    this.tone('sine', 58, 36, t + 0.17, 0.14, peak * 0.6, out);
  }

  hurt() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this.out(0, 0.4);
    this.noiseBurst('lowpass', 900, t, 0.35, 0.45, out);
    this.tone('sine', 150, 45, t, 0.45, 0.4, out);
  }

  gateOpen() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this.out(0, 0.8);
    [0, 4, 7, 12, 16].forEach((st, k) => {
      const f = 392 * Math.pow(2, st / 12);
      this.tone('sine', f, f, t + k * 0.09, 0.9, 0.12, out);
    });
  }

  cleared() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this.out(0, 0.8);
    [0, 7, 12, 16, 19, 24].forEach((st, k) => {
      const f = 523.25 * Math.pow(2, st / 12);
      this.tone('triangle', f, f, t + k * 0.07, 1.1, 0.09, out);
    });
  }

  lost() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const out = this.out(0, 0.8);
    [12, 7, 3, 0].forEach((st, k) => {
      const f = 196 * Math.pow(2, st / 12);
      this.tone('sine', f, f * 0.98, t + k * 0.22, 0.9, 0.14, out);
    });
  }

  // Low, slowly breathing cave ambience.
  drone() {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0.05;
    out.connect(this.master);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const depth = ctx.createGain();
    depth.gain.value = 0.025;
    lfo.connect(depth).connect(out.gain);
    lfo.start();
    for (const f of [41.2, 61.7]) {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.connect(out);
      o.start();
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.value = 0.35;
    src.connect(lp).connect(g).connect(out);
    src.start();
  }
}
