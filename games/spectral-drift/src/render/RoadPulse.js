// The road's reaction to the drums. Every kick thumps the road down under the ship and sends
// a ripple of light racing ahead; the backbeat (beats 2 and 4, where the snare plays in most
// songs) snaps the road into a quick twist and flashes its edges; every drop sends a
// shockwave down it. Only what is drawn moves: the road and everything on it rise and fall
// together, so lanes, timing and steering stay as they are.
//
// The motion is a height offset by distance along the road and position across it, worked
// out the same way here (for the ship, notes and camera, placed on the CPU) and in
// ROAD_PULSE_GLSL (for the road's own meshes). It is computed afresh from the song time each
// frame, so seeking and restarting need no bookkeeping.
import * as THREE from 'three';
import { ONSET } from '../audio/analysis/onsets.js';

export const RIPPLES = 8; // ripples on the road at once; the last slot is a drop's
const DIP_WIDTH = 14; // m of road either side of the ship a kick pushes down
const TWIST_WIDTH = 45; // m of road either side of the ship a backbeat twists
const KICK_DIP = 0.55; // m, for the hardest kicks
const KICK_LIFT = 0.2; // m: how high a kick's ripple lifts the road
const TWIST = 0.09; // rad, for the hardest backbeats
const DROP_DIP = 0.75; // m
const DROP_LIFT = 0.8; // m: how high a drop's shockwave lifts the road
const RIPPLE_SPEED = 45; // m/s a kick's ripple runs ahead of the ship
const RIPPLE_GAP = 0.3; // s between ripples at least, so they never flash more than ~3 times a second
const DROP_SPEED = 60; // m/s a drop's shockwave runs ahead
// Seconds each hit moves the road for.
const KICK_LIFE = 0.6;
const SNARE_LIFE = 0.4;
const RIPPLE_LIFE = 1.2;
const DROP_LIFE = 3;

export const ROAD_PULSE_GLSL = /* glsl */ `
uniform float uShipS;
uniform float uDip;
uniform float uTwist;
uniform vec4 uRipples[${RIPPLES}];
float roadBell(float d, float w) {
  float q = d / w;
  return exp(-q * q);
}
// How far the drums push the road up (m) at distance s along it and x across it.
float roadLift(float s, float x) {
  float d = s - uShipS;
  float h = x * uTwist * roadBell(d, ${TWIST_WIDTH.toFixed(1)}) - uDip * roadBell(d, ${DIP_WIDTH.toFixed(1)});
  for (int i = 0; i < ${RIPPLES}; i++) h += uRipples[i].y * roadBell(s - uRipples[i].x, uRipples[i].z);
  return h;
}
// How brightly the ripples light the road at s: a band across it at each crest.
float roadGlow(float s) {
  float g = 0.0;
  for (int i = 0; i < ${RIPPLES}; i++) g += uRipples[i].w * roadBell(s - uRipples[i].x, uRipples[i].z * 0.4);
  return g;
}
`;

const bell = (d, w) => Math.exp(-((d / w) ** 2));
const clamp01 = (v) => Math.min(1, Math.max(0, v));
// A struck drum skin: a sharp attack, then a quick decay with a little overshoot.
const struck = (tau, attack, decay, hz) => (1 - Math.exp(-tau / attack)) * Math.exp(-tau / decay) * Math.cos(2 * Math.PI * hz * tau);

export class RoadPulse {
  constructor() {
    this.uniforms = {
      uShipS: { value: 0 },
      uDip: { value: 0 },
      uTwist: { value: 0 },
      uBackbeat: { value: 0 },
      // Each ripple: where its crest is (m along the road), how high it lifts the road, its
      // width (m) and how brightly it glows.
      uRipples: { value: Array.from({ length: RIPPLES }, () => new THREE.Vector4(-1e6, 0, 1, 0)) },
    };
    this.motion = 1; // the player's setting: 0 keeps the road still (the lights still react)
    this.setSong(null, {}, 0);
  }

  // `react` is how hard the genre's road reacts (genres.js); 0 leaves it still.
  setSong(track, features, react = 0) {
    this.track = track;
    this.react = react;
    this.kicks = [];
    this.backbeats = [];
    this.drops = [];
    if (!track || react <= 0) return;
    const onsets = features.onsets ?? [];
    let lastRipple = -Infinity;
    for (const o of onsets) {
      // How hard the kick itself hit (older features only flag it: then the hit's strength).
      const kick = o.kick ?? (o.b & ONSET.KICK ? o.s : 0);
      const a = clamp01((kick - 0.5) / 0.5);
      if (a <= 0) continue;
      // Strong kicks send a ripple, at most one every RIPPLE_GAP s: a drum roll mustn't strobe.
      const ripple = a >= 0.3 && o.t - lastRipple >= RIPPLE_GAP;
      if (ripple) lastRipple = o.t;
      this.kicks.push({ t: o.t, a, s: track.distAt(o.t), v: track.speedAt(o.t), ripple });
    }
    this.backbeats = backbeats(features, onsets);
    this.drops = Array.from(features.drops ?? [], (t) => ({ t, s: track.distAt(t), v: track.speedAt(t) }));
  }

  get shipS() {
    return this.uniforms.uShipS.value;
  }

  update(t) {
    const U = this.uniforms;
    const ripples = U.uRipples.value;
    for (const r of ripples) r.set(-1e6, 0, 1, 0);
    U.uDip.value = U.uTwist.value = U.uBackbeat.value = 0;
    if (!this.track || this.react <= 0) return;
    U.uShipS.value = this.track.distAt(t);
    const move = this.react * this.motion;
    const glow = 0.4 + 0.6 * Math.min(1.5, this.react);

    // Kicks: the road dips under the ship, and a ripple runs ahead from each strong one.
    let dip = 0;
    let slot = 0;
    for (let j = lastAtOrBefore(this.kicks, t); j >= 0; j--) {
      const k = this.kicks[j];
      const tau = t - k.t;
      if (tau > RIPPLE_LIFE) break;
      if (tau < KICK_LIFE) dip += k.a * struck(tau, 0.012, 0.1, 2.2);
      if (k.ripple && slot < RIPPLES - 1) {
        // It swells as it leaves the ship (no hard flash under it), then fades as it runs ahead.
        const born = 1 - Math.exp(-tau / 0.05);
        const lift = KICK_LIFT * k.a * born * Math.exp(-tau / 0.5);
        const light = k.a * (0.35 + 0.65 * born) * Math.exp(-tau / 0.5) * glow;
        ripples[slot++].set(k.s + (k.v + RIPPLE_SPEED) * tau, lift * move, 3 + 8 * tau, light);
      }
    }
    dip = 1.5 * Math.tanh(dip / 1.5); // a drum roll rumbles rather than sinking the road

    // Drops: a deep dip and a shockwave.
    let dropDip = 0;
    for (const d of this.drops) {
      const tau = t - d.t;
      if (tau < 0 || tau > DROP_LIFE) continue;
      dropDip += struck(tau, 0.03, 0.3, 1.2);
      const lift = DROP_LIFT * (1 - Math.exp(-tau / 0.1)) * Math.exp(-tau / 0.9);
      ripples[RIPPLES - 1].set(d.s + (d.v + DROP_SPEED) * tau, lift * move, 6 + 16 * tau, 2.5 * Math.exp(-tau / 0.8) * glow);
    }
    U.uDip.value = (KICK_DIP * dip + DROP_DIP * dropDip) * move;

    // Backbeats: a twist one way or the other, and a flash along the edges.
    let twist = 0;
    let flash = 0;
    for (let j = lastAtOrBefore(this.backbeats, t); j >= 0; j--) {
      const bb = this.backbeats[j];
      const tau = t - bb.t;
      if (tau > SNARE_LIFE) break;
      twist += bb.side * bb.a * struck(tau, 0.008, 0.11, 2.2);
      flash += bb.a * Math.exp(-tau / 0.1);
    }
    U.uTwist.value = TWIST * Math.max(-1.5, Math.min(1.5, twist)) * move;
    U.uBackbeat.value = Math.min(1.5, flash) * glow;
  }

  // How far the road is pushed up (m) at distance s along it and x across it, as the shaders
  // move it: whatever sits on the road moves with it.
  lift(s, x) {
    const U = this.uniforms;
    const d = s - U.uShipS.value;
    let h = x * U.uTwist.value * bell(d, TWIST_WIDTH) - U.uDip.value * bell(d, DIP_WIDTH);
    for (const r of U.uRipples.value) if (r.y !== 0) h += r.y * bell(s - r.x, r.z);
    return h;
  }

  // How far the road is twisted (rad, right side up) at s.
  roll(s) {
    const U = this.uniforms;
    return U.uTwist.value * bell(s - U.uShipS.value, TWIST_WIDTH);
  }
}

// The backbeat: beats 2 and 4 of each bar (every other beat), each as hard as the music hits
// within 50 ms of it, twisting the road one way, then the other. The snare's own layer can't
// say it alone: in a dense mix, the kick's click and the hats spill into the snare's band.
function backbeats({ beats = [], downbeats = [] }, onsets) {
  const out = [];
  if (beats.length < 8) return out;
  let d = 0;
  let inBar = 0;
  let o = 0;
  for (const t of beats) {
    while (d < downbeats.length && downbeats[d] <= t + 1e-3) {
      d++;
      inBar = 0;
    }
    if (inBar++ % 2 === 0) continue;
    while (o < onsets.length && onsets[o].t < t - 0.05) o++;
    let hit = 0;
    for (let j = o; j < onsets.length && onsets[j].t <= t + 0.05; j++) hit = Math.max(hit, onsets[j].snare ?? onsets[j].s);
    const a = clamp01((hit - 0.3) / 0.6);
    if (a > 0) out.push({ t, a, side: out.length % 2 ? 1 : -1 });
  }
  return out;
}

// Index of the last event at or before t (events sorted by time), or -1.
function lastAtOrBefore(list, t) {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
