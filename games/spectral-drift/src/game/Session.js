// One play-through of a song: steering, collision against the chart, scoring,
// and routing feedback to the visuals, audio and HUD.
import { ONSET } from '../audio/analysis/onsets.js';
import { HOLD, KIND, LANE_WIDTH, LEAD_IN, MAX_X, STATE, laneX } from '../config.js';
import { HAZARD_RGB, POWER_RGB, TIER_RGB } from '../render/shaderLib.js';
import { clamp, damp } from '../util.js';
import { resetChart } from './Chart.js';
import { Score } from './Score.js';

const NOTE_RADIUS = LANE_WIDTH * 0.62;
const MAGNET_RADIUS = LANE_WIDTH * 1.65;
const HAZARD_RADIUS = LANE_WIDTH * 0.42;
const SMASH_RADIUS = LANE_WIDTH * 0.8;
const HOLD_RADIUS = LANE_WIDTH * 0.75;
const HOLD_GRACE = 0.12; // seconds out of a hold's lane before it is let go
const EARLY_GRACE = 0.035; // a note still counts if the ship left its lane this recently
const LATE_GRACE = 0.05; // ...or reaches it this soon after the beat
const GOLD = [1.0, 0.8, 0.3];
const WHITE = [1.0, 0.95, 0.9];

export class Session {
  constructor({ features, track, chart, world, audio, input, hud }) {
    Object.assign(this, { features, track, chart, world, audio, input, hud });
    this.score = new Score(chart);
    this.spectrum = new Uint8Array(features.specBands || 32);
    this.history = [];
    this.holds = [];
    this.beatAmp = beatAmplitudes(features);
    this.cues = musicCues(features);
    this.reset();
  }

  reset() {
    resetChart(this.chart);
    this.score.reset();
    this.cursor = 0;
    this.onsetCursor = 0;
    this.beatCursor = 0;
    this.cueCursor = 0;
    this.history.length = 0;
    this.holds.length = 0;
    this.x = 0;
    this.vx = 0;
    this.t = -LEAD_IN;
    this.invuln = 0;
    this.beat = 0;
    this.kick = 0;
    this.sparkTimer = 0;
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
    this.hud.toast('OVERDRIVE', 'gold', 2);
  }

  update(t, dt) {
    const prevT = this.t;
    this.t = t;
    if (t < prevT - 0.5) {
      this.cursor = this.onsetCursor = this.beatCursor = this.cueCursor = 0;
      this.history.length = 0;
      this.holds.length = 0;
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
    this.updateHolds(prevT, t, dt);
    this.updatePulse(t, dt);
    this.updateCues(t);
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
      this.hud.toast(`+${points}`, 'gold', 1);
    } else {
      this.audio.pickup(this.score.combo);
    }
    if (o.hold > 0) {
      o.holdState = HOLD.HOLDING;
      o.slip = 0;
      this.holds.push(o);
    }
    if (this.score.multiplier > before) this.hud.toast(`x${this.score.multiplier}`, 'mult');
    if (this.score.charge >= 1 && !od) this.hud.overdriveReady();
  }

  miss(o) {
    o.state = STATE.MISSED;
    if (o.hold > 0) o.holdState = HOLD.DROPPED;
    if (this.score.combo >= 10) this.hud.toast('COMBO LOST', 'miss');
    this.score.miss();
  }

  // Holds score for as long as the ship stays in their lane, with a moment's grace for
  // wobbles; leaving for longer lets go (which only stops the points).
  updateHolds(prevT, t, dt) {
    const radius = this.score.overdriveActive ? MAGNET_RADIUS : HOLD_RADIUS;
    this.sparkTimer -= dt;
    const spark = this.sparkTimer <= 0;
    if (spark) this.sparkTimer = 0.07;
    for (let i = this.holds.length - 1; i >= 0; i--) {
      const o = this.holds[i];
      const end = o.t + o.hold;
      const span = Math.max(0, Math.min(t, end) - Math.max(prevT, o.t));
      if (Math.abs(this.x - laneX(o.lane)) < radius) {
        o.slip = 0;
        o.held += span;
        this.score.hold(span);
        if (spark) this.world.burst(Math.min(t, end), this.x, o.kind === KIND.POWER ? POWER_RGB : TIER_RGB[o.tier], 3, 3, 0.22);
      } else if ((o.slip += span) > HOLD_GRACE) {
        o.holdState = HOLD.DROPPED;
        this.holds.splice(i, 1);
        continue;
      }
      if (t >= end) {
        o.holdState = HOLD.DONE;
        this.holds.splice(i, 1);
        const points = this.score.holdComplete(o);
        this.world.burst(end, this.x, TIER_RGB[o.tier], 22, 7, 0.34);
        this.world.ship.pulse(TIER_RGB[o.tier]);
        this.audio.holdDone();
        this.hud.toast(`HOLD +${points}`, 'mult');
      }
    }
  }

  // Beat pulse on the beat grid (downbeats strongest); the camera kick from the kick drum.
  updatePulse(t, dt) {
    const beats = this.features.beats;
    if (this.beatAmp) {
      while (this.beatCursor < beats.length && beats[this.beatCursor] <= t) {
        this.beat = Math.max(this.beat, this.beatAmp[this.beatCursor++]);
      }
    }
    const on = this.features.onsets;
    while (this.onsetCursor < on.length && on[this.onsetCursor].t <= t) {
      const o = on[this.onsetCursor++];
      if (o.b & ONSET.KICK) {
        if (!this.beatAmp) this.beat = Math.max(this.beat, Math.min(1, o.s));
        if (o.s > 0.6) this.kick = Math.max(this.kick, o.s);
      }
    }
    this.beat *= Math.exp(-dt * 7);
    this.kick *= Math.exp(-dt * 10);
  }

  // Drops hit hard (flash, shake, a punch of speed on screen); build-ups announce themselves.
  updateCues(t) {
    while (this.cueCursor < this.cues.length && this.cues[this.cueCursor].t <= t) {
      const cue = this.cues[this.cueCursor++];
      if (t - cue.t > 0.5) continue; // skipped over (seek or lag), don't fire late
      if (cue.type === 'drop') {
        this.world.drop();
        this.hud.toast('DROP', 'gold', 2);
      } else if (cue.type === 'build') {
        this.hud.toast('BUILD UP', 'mult', 1);
      }
    }
  }

  // How far into a build-up the song is (0..1), for rising tension in the visuals.
  tensionAt(t) {
    for (const b of this.features.builds ?? []) {
      if (t >= b.start && t < b.end) return (t - b.start) / (b.end - b.start);
    }
    return 0;
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
      tension: this.tensionAt(this.t),
      intensity: this.track.intensityAt(this.t),
      overdrive: od,
      invuln: this.invuln,
      magnet: this.score.overdriveActive ? MAGNET_RADIUS : 0,
      spectrum: this.spectrumAt(this.t),
    };
  }
}

// Pulse strength for every beat: downbeats strongest, scaled by how hard the music hits
// there, so a beat-less passage barely pulses. Null when the song has no beat grid.
function beatAmplitudes({ beats, downbeats, onsets }) {
  if (!beats || beats.length < 8) return null;
  const amp = new Float32Array(beats.length);
  let d = 0;
  let o = 0;
  for (let i = 0; i < beats.length; i++) {
    const t = beats[i];
    while (d < downbeats.length && downbeats[d] < t - 1e-3) d++;
    const down = d < downbeats.length && Math.abs(downbeats[d] - t) < 1e-3;
    while (o < onsets.length && onsets[o].t < t - 0.05) o++;
    let hit = 0;
    for (let k = o; k < onsets.length && onsets[k].t <= t + 0.05; k++) hit = Math.max(hit, onsets[k].s);
    amp[i] = (down ? 1 : 0.65) * clamp(0.3 + 0.7 * hit, 0, 1);
  }
  return amp;
}

function musicCues({ drops = [], builds = [] }) {
  const cues = [...drops.map((t) => ({ t, type: 'drop' })), ...builds.map((b) => ({ t: b.start, type: 'build' }))];
  return cues.sort((a, b) => a.t - b.t);
}
