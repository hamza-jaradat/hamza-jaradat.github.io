// One play-through of a song: steering, collision against the chart, scoring,
// and routing feedback to the visuals, audio and HUD.
import { KIND, LANE_WIDTH, LEAD_IN, MAX_X, STATE, laneX } from '../config.js';
import { HAZARD_RGB, POWER_RGB, TIER_RGB } from '../render/shaderLib.js';
import { clamp, damp } from '../util.js';
import { resetChart } from './Chart.js';
import { Score } from './Score.js';

const NOTE_RADIUS = LANE_WIDTH * 0.62;
const MAGNET_RADIUS = LANE_WIDTH * 1.65;
const HAZARD_RADIUS = LANE_WIDTH * 0.42;
const SMASH_RADIUS = LANE_WIDTH * 0.8;
const EARLY_GRACE = 0.035; // a note still counts if the ship left its lane this recently
const LATE_GRACE = 0.05; // ...or reaches it this soon after the beat
const GOLD = [1.0, 0.8, 0.3];

export class Session {
  constructor({ features, track, chart, world, audio, input, hud }) {
    Object.assign(this, { features, track, chart, world, audio, input, hud });
    this.score = new Score(chart);
    this.spectrum = new Uint8Array(features.specBands || 32);
    this.history = [];
    this.reset();
  }

  reset() {
    resetChart(this.chart);
    this.score.reset();
    this.cursor = 0;
    this.onsetCursor = 0;
    this.history.length = 0;
    this.x = 0;
    this.vx = 0;
    this.t = -LEAD_IN;
    this.invuln = 0;
    this.beat = 0;
    this.kick = 0;
    this.input.reset();
    this.world.resetDynamics();
  }

  get finished() {
    return this.t > this.features.duration + 1.2;
  }

  activateOverdrive() {
    if (!this.score.activateOverdrive()) return;
    this.audio.overdrive();
    this.world.postfx.hit(GOLD, 0.7);
    this.world.rig.addShake(0.25);
    this.hud.toast('OVERDRIVE', 'gold');
  }

  update(t, dt) {
    const prevT = this.t;
    this.t = t;
    if (t < prevT - 0.5) {
      this.cursor = this.onsetCursor = 0;
      this.history.length = 0;
    }

    this.input.shipX = this.x;
    const target = clamp(this.input.targetX, -MAX_X, MAX_X);
    const prevX = this.x;
    this.x += (target - this.x) * damp(this.input.mode === 'keys' ? 20 : 26, dt);
    this.vx = dt > 0 ? (this.x - prevX) / dt : 0;
    this.invuln = Math.max(0, this.invuln - dt);
    this.score.update(dt);
    this.history.push({ t, x: this.x });
    while (this.history.length > 2 && this.history[0].t < t - 0.2) this.history.shift();

    this.resolve(prevT, t, prevX);
    this.updatePulse(t, dt);
  }

  // Closest the ship came to lateral position ox during [from, to]; `to` lies in this frame.
  closest(ox, from, to, prevT, prevX) {
    const span = this.t - prevT;
    const f = span > 1e-4 ? clamp((to - prevT) / span, 0, 1) : 1;
    let best = Math.abs(prevX + (this.x - prevX) * f - ox);
    for (const h of this.history) if (h.t >= from && h.t <= to) best = Math.min(best, Math.abs(h.x - ox));
    return best;
  }

  resolve(prevT, t, prevX) {
    const objs = this.chart.objects;
    const od = this.score.overdriveActive;
    const radius = od ? MAGNET_RADIUS : NOTE_RADIUS;
    for (let i = this.cursor; i < objs.length && objs[i].t <= t; i++) {
      const o = objs[i];
      if (o.state === STATE.PENDING) {
        const ox = laneX(o.lane);
        if (o.kind === KIND.HAZARD) {
          this.resolveHazard(o, ox, this.closest(ox, o.t, o.t, prevT, prevX), od);
        } else if (o.t > prevT) {
          // On the beat (or just left the lane): collect.
          if (this.closest(ox, o.t - EARLY_GRACE, o.t, prevT, prevX) < radius) this.collect(o, od);
        } else if (Math.abs(this.x - ox) < radius) {
          this.collect(o, od); // arrived a touch late
        }
        if (o.state === STATE.PENDING && t >= o.t + LATE_GRACE) this.miss(o);
      }
      if (i === this.cursor && o.state !== STATE.PENDING) this.cursor++;
    }
  }

  resolveHazard(o, ox, dx, od) {
    if (od && dx < SMASH_RADIUS) {
      o.state = STATE.SMASHED;
      this.score.smash();
      this.world.burst(o.t, ox, GOLD, 26, 9, 0.4);
      this.world.rig.addShake(0.2);
      this.audio.smash();
    } else if (dx < HAZARD_RADIUS && this.invuln <= 0) {
      o.state = STATE.HIT;
      this.score.hit();
      this.invuln = 0.6;
      this.world.burst(o.t, ox, HAZARD_RGB, 34, 10, 0.45);
      this.world.rig.addShake(0.8);
      this.world.postfx.hit(HAZARD_RGB, 1);
      this.audio.hit();
      this.hud.hit();
    } else {
      o.state = STATE.PASSED;
    }
  }

  collect(o, od) {
    o.state = STATE.COLLECTED;
    const before = this.score.multiplier;
    const points = this.score.collect(o);
    const power = o.kind === KIND.POWER;
    const rgb = power ? POWER_RGB : TIER_RGB[o.tier];
    this.world.burst(o.t, this.x, rgb, power ? 40 : 16, power ? 11 : 6, power ? 0.5 : 0.32);
    this.world.ship.pulse(rgb);
    if (power) {
      this.audio.power();
      this.world.rig.addShake(0.15);
      this.hud.toast(`+${points}`, 'gold');
    } else {
      this.audio.pickup(this.score.combo);
    }
    if (this.score.multiplier > before) this.hud.toast(`x${this.score.multiplier}`, 'mult');
    if (this.score.charge >= 1 && !od) this.hud.overdriveReady();
  }

  miss(o) {
    o.state = STATE.MISSED;
    if (this.score.combo >= 10) this.hud.toast('COMBO LOST', 'miss');
    this.score.miss();
  }

  // Beat pulse and kick shake straight from the analysed onsets, so they stay in sync.
  updatePulse(t, dt) {
    const on = this.features.onsets;
    while (this.onsetCursor < on.length && on[this.onsetCursor].t <= t) {
      const o = on[this.onsetCursor++];
      if (o.b & 1) {
        this.beat = Math.max(this.beat, Math.min(1, o.s));
        if (o.s > 0.6) this.kick = Math.max(this.kick, o.s);
      }
    }
    this.beat *= Math.exp(-dt * 7);
    this.kick *= Math.exp(-dt * 10);
  }

  spectrumAt(t) {
    const f = this.features;
    const bands = this.spectrum.length;
    const frames = f.spectrum.length / bands;
    const i = Math.round(t * f.frameRate);
    if (t < 0 || i >= frames) {
      for (let b = 0; b < bands; b++) this.spectrum[b] *= 0.9;
    } else {
      this.spectrum.set(f.spectrum.subarray(i * bands, i * bands + bands));
    }
    return this.spectrum;
  }

  frameState() {
    const od = this.score.overdriveActive ? Math.min(1, this.score.overdrive / 0.5) : 0;
    return {
      t: this.t,
      shipX: this.x,
      shipVX: this.vx,
      beat: this.beat,
      kick: this.kick,
      intensity: this.track.intensityAt(this.t),
      overdrive: od,
      invuln: this.invuln,
      magnet: this.score.overdriveActive ? MAGNET_RADIUS : 0,
      spectrum: this.spectrumAt(this.t),
    };
  }
}
