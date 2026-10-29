// Playback, the song clock, and small synthesized sound effects.

const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.source = null;
    this.startAt = 0;
    this.offset = 0; // user calibration in seconds; positive delays the visuals
    this.clock = 0;
    this.clockValid = false;
    this.paused = false;
    this.musicVolume = 0.85;
    this.sfxVolume = 0.5;
  }

  ensure() {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.music = ctx.createGain();
      this.music.gain.value = this.musicVolume;
      this.music.connect(this.master);
      this.sfx = ctx.createGain();
      this.sfx.gain.value = this.sfxVolume;
      this.sfx.connect(this.master);
      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended' && !this.paused) this.ctx.resume();
    return this.ctx;
  }

  decode(arrayBuffer) {
    return this.ensure().decodeAudioData(arrayBuffer);
  }

  play(buffer, leadIn) {
    this.stop();
    const ctx = this.ensure();
    this.paused = false;
    if (ctx.state === 'suspended') ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.music);
    this.startAt = ctx.currentTime + leadIn + 0.05;
    src.start(this.startAt);
    this.source = src;
    this.clockValid = false;
  }

  stop() {
    if (!this.source) return;
    try {
      this.source.stop();
    } catch {
      // already stopped
    }
    this.source.disconnect();
    this.source = null;
  }

  pause() {
    this.paused = true;
    if (this.ctx && this.ctx.state === 'running') return this.ctx.suspend();
    return Promise.resolve();
  }

  resume() {
    this.paused = false;
    this.clockValid = false;
    return this.ctx ? this.ctx.resume() : Promise.resolve();
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  latency() {
    const c = this.ctx;
    return (c.outputLatency || 0) + (c.baseLatency || 0);
  }

  rawTime() {
    return this.ctx.currentTime - this.startAt - this.latency() - this.offset;
  }

  // Song time that advances smoothly with the frame clock and is nudged toward
  // the audio hardware clock, which only updates once per audio callback.
  time(dt) {
    const raw = this.rawTime();
    if (!this.clockValid) {
      this.clock = raw;
      this.clockValid = true;
      return raw;
    }
    if (this.ctx.state !== 'running') return this.clock;
    this.clock += dt;
    const err = raw - this.clock;
    if (Math.abs(err) > 0.06) this.clock = raw;
    else this.clock += err * 0.1;
    return this.clock;
  }

  setMusicVolume(v) {
    this.musicVolume = v;
    if (this.music) this.music.gain.value = v;
  }

  setSfxVolume(v) {
    this.sfxVolume = v;
    if (this.sfx) this.sfx.gain.value = v;
  }

  // --- Sound effects ------------------------------------------------------
  _tone(type, f0, f1, dur, peak, delay = 0) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfx);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  _noise(filterType, freq, q, dur, peak) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, t);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfx);
    src.start(t, Math.random() * 0.5, dur + 0.05);
    return f;
  }

  get sfxOn() {
    return !!this.ctx && this.sfxVolume > 0.001 && this.ctx.state === 'running';
  }

  pickup(combo) {
    if (!this.sfxOn) return;
    const f = 1046.5 * Math.pow(2, PENTATONIC[combo % PENTATONIC.length] / 12);
    this._tone('sine', f, f * 1.02, 0.09, 0.09);
    this._tone('triangle', f * 2, f * 2, 0.04, 0.03);
  }

  power() {
    if (!this.sfxOn) return;
    this._tone('sine', 880, 1760, 0.32, 0.12);
    this._tone('triangle', 1318.5, 2637, 0.4, 0.07, 0.04);
  }

  hit() {
    if (!this.sfxOn) return;
    this._tone('sawtooth', 140, 38, 0.35, 0.22);
    const f = this._noise('lowpass', 1800, 1.5, 0.3, 0.35);
    f.frequency.exponentialRampToValueAtTime(200, this.ctx.currentTime + 0.3);
  }

  smash() {
    if (!this.sfxOn) return;
    this._noise('highpass', 2500, 0.8, 0.14, 0.18);
    this._tone('square', 420, 90, 0.12, 0.05);
  }

  overdrive() {
    if (!this.sfxOn) return;
    this._tone('sawtooth', 160, 1400, 0.6, 0.08);
    this._tone('sine', 523.25, 2093, 0.7, 0.1, 0.05);
    const f = this._noise('bandpass', 600, 3, 0.7, 0.2);
    f.frequency.exponentialRampToValueAtTime(8000, this.ctx.currentTime + 0.7);
  }

  ui() {
    if (!this.sfxOn) return;
    this._tone('sine', 1400, 1800, 0.05, 0.05);
  }
}
