// Places collectibles and hazards on the song's onsets, so each pickup lands
// exactly on a hit in the music.
import { KIND, LANES, STATE } from '../config.js';
import { clamp, mulberry32, sampleArray } from '../util.js';

const TIER_POINTS = [10, 15, 25, 40];
const POWER_POINTS = 100;
const NEIGHBORHOOD = 1.5; // seconds either side used to judge an onset's relative strength

export function buildChart(features, diff, seed) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const { onsets, duration, frameRate, intensity } = features;
  const intensityAt = (t) => sampleArray(intensity, t * frameRate);
  const cands = onsets.filter((o) => o.t > 0.4 && o.t < duration - 0.3);

  // Strength relative to the strongest onset nearby, so quiet passages still get notes.
  const rel = new Float32Array(cands.length);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < cands.length; i++) {
    while (cands[lo].t < cands[i].t - NEIGHBORHOOD) lo++;
    if (hi < i) hi = i;
    while (hi < cands.length - 1 && cands[hi + 1].t <= cands[i].t + NEIGHBORHOOD) hi++;
    let m = 0;
    for (let j = lo; j <= hi; j++) m = Math.max(m, cands[j].s);
    rel[i] = m > 0 ? cands[i].s / m : 0;
  }

  const kept = [];
  for (let i = 0; i < cands.length; i++) {
    const o = cands[i];
    const I = intensityAt(o.t);
    const threshold = clamp(0.62 - 0.42 * diff.density - 0.18 * I, 0.05, 0.9);
    if (rel[i] < threshold) continue;
    const ev = { t: o.t, rel: rel[i], b: o.b, I };
    const last = kept[kept.length - 1];
    if (!last || ev.t - last.t >= diff.minGap) kept.push(ev);
    else if (ev.rel > last.rel) kept[kept.length - 1] = ev;
  }

  const objects = [];
  const hazard = (t, lane) => objects.push({ t, lane, kind: KIND.HAZARD, tier: 0, value: 0, state: STATE.PENDING });
  let lane = Math.floor(LANES / 2);
  let dir = rng() < 0.5 ? -1 : 1;
  let prevT = -10;
  let lastPower = -10;
  let lastHazard = -10;

  for (let k = 0; k < kept.length; k++) {
    const ev = kept[k];
    const gap = ev.t - prevT;
    // How many lanes a player can reasonably cross before this note.
    const maxStep = gap < 0.15 ? 0 : Math.min(LANES - 1, Math.floor((gap - 0.03) / 0.12));
    const r = rng();
    let step;
    if (ev.b === 1) step = r < 0.5 ? 0 : 1; // kick-only hits tend to hold the lane
    else if (ev.rel > 0.9 && ev.I > 0.5) step = r < 0.5 ? 2 : 3; // accents jump
    else step = r < 0.2 ? 0 : r < 0.85 ? 1 : 2;
    step = Math.min(step, maxStep);
    if (rng() < 0.2) dir = -dir;
    let next = lane + dir * step;
    if (next < 0 || next >= LANES) {
      dir = -dir;
      next = lane + dir * step;
    }
    next = clamp(next, 0, LANES - 1);

    const isPower = ev.rel > 0.92 && ev.I > 0.62 && ev.t - lastPower > 5 && rng() < 0.6;
    const tier = ev.I < 0.3 ? 0 : ev.I < 0.55 ? 1 : ev.I < 0.78 ? 2 : 3;
    objects.push({
      t: ev.t,
      lane: next,
      kind: isPower ? KIND.POWER : KIND.NOTE,
      tier,
      value: isPower ? POWER_POINTS : TIER_POINTS[tier],
      state: STATE.PENDING,
    });
    if (isPower) lastPower = ev.t;

    // Hazard gate: blocks beside the note, never on the lanes the player crosses to reach it.
    if (gap >= 0.22 && ev.t - lastHazard > 0.5 && rng() < diff.hazard * (0.4 + 1.3 * ev.I)) {
      const pathLo = Math.min(lane, next);
      const pathHi = Math.max(lane, next);
      const options = [];
      for (let l = 0; l < LANES; l++) if (l < pathLo || l > pathHi) options.push(l);
      options.sort((a, b) => Math.abs(a - next) - Math.abs(b - next));
      const count = Math.min(options.length, rng() < 0.45 ? 2 : 1);
      for (let h = 0; h < count; h++) hazard(ev.t, options[h]);
      if (count) lastHazard = ev.t;
    }

    // Blocker in the current lane during a long gap forces a dodge and return.
    const nextEv = kept[k + 1];
    if (
      nextEv &&
      nextEv.t - ev.t >= 0.6 &&
      ev.t - lastHazard > 0.5 &&
      rng() < diff.hazard * 1.6 * (0.5 + ev.I)
    ) {
      const th = ev.t + (nextEv.t - ev.t) * 0.5;
      hazard(th, next);
      lastHazard = th;
    }

    lane = next;
    prevT = ev.t;
  }

  objects.sort((a, b) => a.t - b.t);
  return {
    objects,
    notesTotal: objects.filter((o) => o.kind !== KIND.HAZARD).length,
    hazardsTotal: objects.filter((o) => o.kind === KIND.HAZARD).length,
  };
}

export function resetChart(chart) {
  for (const o of chart.objects) o.state = STATE.PENDING;
}
