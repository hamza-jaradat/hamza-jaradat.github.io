// Charts a song the way a rhythm-game author would. Every note sits on a musical event,
// snapped to the beat grid; easier difficulties keep the strongest notes on the
// strongest beats; lanes follow the melody's contour, or sway between kick and snare;
// a repeated bar repeats its pattern; long tones become holds; drops land on power
// notes; hazards keep to the beat.
import { ONSET } from '../audio/analysis/onsets.js';
import { HOLD, KIND, LANES, STATE } from '../config.js';
import { clamp, mulberry32, sampleArray } from '../util.js';

const TIER_POINTS = [10, 15, 25, 40];
const POWER_POINTS = 100;
const NEIGHBORHOOD = 1.5; // seconds either side used to judge an onset's relative strength
const SNAP = 0.03; // the furthest a note moves onto the grid (s)
const MIN_IMPORTANCE = 0.12;
// How much a note matters by where it falls: downbeat, beat, 8th, 16th or triplet, off-grid.
const LEVEL_WEIGHT = [1, 0.9, 0.72, 0.55, 0.42];
const FLAT_WEIGHT = [0.8, 0.8, 0.8, 0.8, 0.8];
const STRAIGHT = [0, 0.25, 0.5, 0.75, 1];
const TRIPLET = [0, 1 / 3, 2 / 3, 1];
// Lane pairs that rhythmic bars sway between (odd beats on the first, even on the second):
// every pair 1, 2 or 3 lanes apart; the more intense the bar, the wider the sway.
const ANCHORS = [];
for (let a = 0; a < LANES; a++) for (let b = 0; b < LANES; b++) if (a !== b && Math.abs(a - b) <= 3) ANCHORS.push([a, b]);
const DRUMS = ONSET.KICK | ONSET.SNARE;

export function buildChart(features, diff, seed) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const grid = makeGrid(features);
  const bars = makeBars(features, grid);
  candidates(features, grid, bars);
  const notes = select(bars, diff);
  makeHolds(notes, grid, diff);
  for (const bar of bars) bar.notes = bar.notes.filter((n) => !n.dropped);
  assignLanes(bars, rng);
  powerNotes(notes, bars, features);

  const intensityAt = (t) => sampleArray(features.intensity, t * features.frameRate);
  const objects = notes.map((n) => {
    const I = intensityAt(n.t);
    const tier = I < 0.3 ? 0 : I < 0.55 ? 1 : I < 0.78 ? 2 : 3;
    return {
      t: n.t,
      lane: n.lane,
      kind: n.power ? KIND.POWER : KIND.NOTE,
      tier,
      value: n.power ? POWER_POINTS : TIER_POINTS[tier],
      hold: n.hold || 0,
      state: STATE.PENDING,
    };
  });
  hazards(objects, notes, grid, features, diff, rng);
  objects.sort((a, b) => a.t - b.t);
  const chart = {
    objects,
    notesTotal: notes.length,
    holdsTotal: notes.filter((n) => n.hold > 0).length,
    powersTotal: notes.filter((n) => n.power).length,
    hazardsTotal: objects.length - notes.length,
    onGrid: grid?.trusted ?? false,
  };
  resetChart(chart);
  return chart;
}

export function resetChart(chart) {
  for (const o of chart.objects) {
    o.state = STATE.PENDING;
    if (o.hold > 0) {
      o.holdState = HOLD.WAITING;
      o.held = 0;
    }
  }
}

// --- Beat grid ---------------------------------------------------------------------

// Which bar every beat belongs to and where in it, plus helpers to place times on the grid.
function makeGrid({ beats, downbeats }) {
  const n = beats?.length ?? 0;
  if (n < 8 || !downbeats || downbeats.length < 2) return null;
  const isDown = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++) {
    while (d < downbeats.length && downbeats[d] < beats[i] - 1e-3) d++;
    if (d < downbeats.length && Math.abs(downbeats[d] - beats[i]) < 1e-3) isDown[i] = 1;
  }
  const firstDown = isDown.indexOf(1);
  if (firstDown < 0) return null;
  const pos = new Int16Array(n);
  for (let i = 0; i < n; i++) pos[i] = i < firstDown ? i - firstDown + 4 * Math.ceil(firstDown / 4) : isDown[i] ? 0 : pos[i - 1] + 1;
  const period = (i) => (i < n - 1 ? beats[i + 1] - beats[i] : beats[n - 1] - beats[n - 2]);

  // Beat interval holding t, and how far through it t falls (null outside the grid).
  const locate = (t) => {
    if (t < beats[0] || t >= beats[n - 1] + period(n - 1)) return null;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (beats[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    const p = period(lo);
    return { i: lo, frac: (t - beats[lo]) / p, period: p };
  };

  // Nearest grid slot: its time, level (0 downbeat .. 3 sixteenth/triplet, 4 off-grid),
  // beat index and position within the beat (twelfths).
  const snap = (t, triplet) => {
    const loc = locate(t);
    if (!loc) return { at: t, level: 4, beat: -1, sub: 0 };
    const { i, frac, period: p } = loc;
    let best = 0;
    for (const f of triplet ? TRIPLET : STRAIGHT) if (Math.abs(frac - f) < Math.abs(frac - best)) best = f;
    if (Math.abs(frac - best) * p > Math.max(0.025, 0.075 * p)) return { at: t, level: 4, beat: -1, sub: 0 };
    const beat = best === 1 ? i + 1 : i;
    const f = best === 1 ? 0 : best;
    const level = f === 0 ? (beat < n && isDown[beat] ? 0 : 1) : f === 0.5 ? 2 : 3;
    return { at: beats[i] + best * p, level, beat, sub: Math.round(f * 12) };
  };

  // Closest eighth-note time (for the ends of holds and the timing of hazards).
  const eighth = (t) => {
    const loc = locate(t);
    if (!loc) return t;
    return beats[loc.i] + (Math.round(loc.frac * 2) / 2) * loc.period;
  };

  return { beats, n, isDown, pos, period, locate, snap, eighth, trusted: false };
}

// Bars from downbeat to downbeat (or two-second stretches when there is no grid),
// with the energy and song section of each.
function makeBars(features, grid) {
  const { duration, frameRate, intensity, sections = [] } = features;
  const spans = [];
  if (grid) {
    const { beats, n, isDown, period } = grid;
    const first = isDown.indexOf(1);
    if (beats[0] > 0.5) spans.push({ t0: 0, t1: beats[0], beats: 0 });
    if (first > 0) spans.push({ t0: beats[0], t1: beats[first], beats: first, b0: 0 });
    for (let i = first; i < n; ) {
      let j = i + 1;
      while (j < n && !isDown[j]) j++;
      spans.push({ t0: beats[i], t1: j < n ? beats[j] : beats[n - 1] + period(n - 1), beats: j - i, b0: i });
      i = j;
    }
    const end = spans[spans.length - 1].t1;
    if (end < duration) spans.push({ t0: end, t1: duration + 1, beats: 0 });
  } else {
    for (let t = 0; t < duration; t += 2) spans.push({ t0: t, t1: Math.min(duration + 1, t + 2), beats: 0 });
  }

  let s = 0;
  return spans.map((bar, index) => {
    const f0 = Math.max(0, Math.floor(bar.t0 * frameRate));
    const f1 = Math.min(intensity.length, Math.max(f0 + 1, Math.ceil(bar.t1 * frameRate)));
    let e = 0;
    for (let f = f0; f < f1; f++) e += intensity[f];
    while (s < sections.length - 1 && sections[s + 1].start <= bar.t0 + 0.05) s++;
    const section = sections[s];
    return {
      ...bar,
      index,
      energy: f1 > f0 ? e / (f1 - f0) : 0,
      section,
      drop: !!section?.drop && bar.t0 - section.start < 2 * (bar.t1 - bar.t0) + 0.05,
      events: [],
      notes: [],
    };
  });
}

// --- Candidate notes ------------------------------------------------------------------

function candidates(features, grid, bars) {
  const { onsets, duration } = features;
  const list = onsets.filter((o) => o.t > 0.4 && o.t < duration - 0.3);
  if (!list.length) return;

  // Strength relative to the strongest onset nearby, so quiet passages still get notes.
  const rel = new Float32Array(list.length);
  for (let i = 0, lo = 0, hi = 0; i < list.length; i++) {
    while (list[lo].t < list[i].t - NEIGHBORHOOD) lo++;
    if (hi < i) hi = i;
    while (hi < list.length - 1 && list[hi + 1].t <= list[i].t + NEIGHBORHOOD) hi++;
    let m = 0;
    for (let j = lo; j <= hi; j++) m = Math.max(m, list[j].s);
    rel[i] = m > 0 ? list[i].s / m : 0;
  }

  const barAt = barFinder(bars);
  if (grid) {
    // Is the grid real? Most strong hits of rhythmic music sit on an eighth note.
    let strong = 0;
    let onEighth = 0;
    for (let i = 0; i < list.length; i++) {
      const loc = grid.locate(list[i].t);
      if (!loc || rel[i] < 0.5) continue;
      strong++;
      const f = loc.frac * 2;
      if (Math.abs(f - Math.round(f)) * loc.period * 0.5 < 0.03) onEighth++;
    }
    grid.trusted = strong >= 8 && onEighth >= 0.5 * strong;

    // Swing or straight, bar by bar: do the in-between hits fall on thirds or quarters of a beat?
    for (let i = 0; i < list.length; i++) {
      const loc = grid.locate(list[i].t);
      if (!loc) continue;
      const bar = barAt(list[i].t);
      const fr = loc.frac;
      if (Math.min(Math.abs(fr - 0.25), Math.abs(fr - 0.75)) < 0.05) bar.straight = (bar.straight ?? 0) + list[i].s;
      else if (Math.min(Math.abs(fr - 1 / 3), Math.abs(fr - 2 / 3)) < 0.05) bar.swung = (bar.swung ?? 0) + list[i].s;
    }
    for (const bar of bars) bar.triplet = (bar.swung ?? 0) > 0.5 && (bar.swung ?? 0) > 1.5 * (bar.straight ?? 0);
  }

  const weights = grid?.trusted ? LEVEL_WEIGHT : FLAT_WEIGHT;
  const events = [];
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    const g = grid ? grid.snap(o.t, barAt(o.t).triplet) : { at: o.t, level: 4, beat: -1, sub: 0 };
    const t = grid?.trusted && Math.abs(g.at - o.t) <= SNAP ? g.at : o.t;
    const layer = o.b & DRUMS ? 1 : o.b & ONSET.TONE ? 0.95 : 0.55;
    const ev = {
      t,
      rel: rel[i],
      b: o.b,
      pitch: o.pitch,
      sustain: o.sustain || 0,
      level: g.level,
      slot: g.beat >= 0 ? grid.pos[Math.min(g.beat, grid.n - 1)] * 12 + (g.beat >= grid.n ? 12 : 0) + g.sub : -1,
      importance: rel[i] * layer * weights[g.level],
    };
    // Hits that land on the same instant become one event.
    const last = events[events.length - 1];
    if (last && Math.abs(last.t - t) < 0.02) {
      last.b |= ev.b;
      if (ev.importance > last.importance) Object.assign(last, { ...ev, b: last.b });
      continue;
    }
    events.push(ev);
  }
  for (const ev of events) barAt(ev.t).events.push(ev);
}

function barFinder(bars) {
  return (t) => {
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].t0 <= t) lo = mid;
      else hi = mid - 1;
    }
    return bars[lo];
  };
}

// --- Choosing notes ----------------------------------------------------------------------

// Bar by bar, the most important events within the difficulty's budget. A bar that sounds
// like an earlier one (same rhythm, similar energy) reuses that bar's choice of hits.
function select(bars, diff) {
  let lastT = -10;
  const picked = [];
  for (const bar of bars) {
    const cs = bar.events;
    if (!cs.length) continue;
    const kind = bar.section?.kind;
    let budget = diff.perBar[0] + (diff.perBar[1] - diff.perBar[0]) * clamp(bar.energy, 0, 1);
    budget *= bar.beats ? bar.beats / 4 : (bar.t1 - bar.t0) / 2;
    if (bar.section?.build) budget *= 1.15;
    if (bar.drop) budget *= 1.2;
    if (kind === 'calm') budget *= 0.85;
    budget = Math.max(1, Math.round(budget));

    bar.profile = profile(cs);
    const source = bar.beats ? similarBar(bar, bars) : null;
    let chosen;
    if (source) {
      const bySlot = new Map(source.notes.filter((n) => n.slot >= 0).map((n) => [n.slot, n]));
      chosen = cs.filter((c) => bySlot.has(c.slot) && c.importance >= MIN_IMPORTANCE * 0.5);
      for (const c of chosen) c.source = bySlot.get(c.slot);
    } else {
      chosen = [];
      const order = [...cs].sort((a, b) => b.importance - a.importance);
      for (const c of order) {
        if (chosen.length >= budget || c.importance < MIN_IMPORTANCE) break;
        if (c.level > diff.maxLevel && !(c.level === diff.maxLevel + 1 && c.rel >= 0.9)) continue;
        if (c.t - lastT < diff.minGap) continue;
        if (chosen.some((x) => Math.abs(x.t - c.t) < diff.minGap)) continue;
        chosen.push(c);
      }
    }
    chosen.sort((a, b) => a.t - b.t);
    for (const c of chosen) {
      if (c.t - lastT < diff.minGap) continue;
      bar.notes.push(c);
      picked.push(c);
      lastT = c.t;
    }
    bar.melodic = source ? source.melodic : isMelodic(bar.notes);
  }
  return picked;
}

// A bar is melodic when its notes trace a line: most are pitched and move by steps or
// small leaps, rather than bouncing between a bass note and its octave or droning on one.
function isMelodic(notes) {
  const pitched = notes.filter((n) => !Number.isNaN(n.pitch));
  if (pitched.length < 2 || pitched.length < 0.5 * notes.length) return false;
  let smooth = 0;
  let moving = 0;
  for (let i = 1; i < pitched.length; i++) {
    const d = Math.abs(pitched[i].pitch - pitched[i - 1].pitch);
    if (d <= 7.5) smooth++;
    if (d >= 0.6) moving++;
  }
  return smooth >= 0.75 * (pitched.length - 1) && moving >= 0.3 * (pitched.length - 1);
}

// Which grid slots of a bar have hits, how strong (drums and tones kept apart), and the
// pitch heard at each.
function profile(events) {
  const hits = new Map();
  const pitch = new Map();
  for (const e of events) {
    if (e.slot < 0 || e.rel < 0.25) continue;
    const key = e.slot * 2 + (e.b & DRUMS ? 0 : 1);
    hits.set(key, Math.max(hits.get(key) ?? 0, e.rel));
    if (!Number.isNaN(e.pitch)) pitch.set(e.slot, e.pitch);
  }
  return { hits, pitch };
}

// The earlier bar this one repeats: the same rhythm, the same notes, a similar energy.
function similarBar(bar, bars) {
  let best = null;
  let bestSim = 0.9;
  for (let k = 0; k < bar.index; k++) {
    const other = bars[k];
    if (other.beats !== bar.beats || !other.notes.length || other.source) continue;
    if (Math.abs(other.energy - bar.energy) > 0.15) continue;
    let common = 0;
    let same = 0;
    for (const [slot, p] of bar.profile.pitch) {
      const q = other.profile.pitch.get(slot);
      if (q === undefined) continue;
      common++;
      if (Math.abs(p - q) <= 1) same++;
    }
    if (common >= 2 && same < 0.75 * common) continue;
    const sim = cosine(bar.profile.hits, other.profile.hits);
    if (sim > bestSim) {
      bestSim = sim;
      best = other;
    }
  }
  if (best) bar.source = best;
  return best;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Long tones become holds, ending on an eighth note and clear of the next note. Drum hits
// under a held note (where that note is still what you hear) fold into the hold.
function makeHolds(notes, grid, diff) {
  for (let k = 0; k < notes.length; k++) {
    const n = notes[k];
    if (n.dropped || !(n.b & ONSET.TONE) || n.sustain < diff.holdMin) continue;
    const beat = grid ? grid.period(grid.locate(n.t)?.i ?? 0) : 0.5;
    if (n.sustain < 0.75 * beat) continue;
    let end = n.t + n.sustain;
    if (grid?.trusted) end = grid.eighth(end);
    end = Math.min(end, n.t + 8 * beat);
    const under = [];
    let next = notes[k + 1 + under.length];
    while (next && next.t < end - 0.1 && !(next.b & ONSET.TONE) && Math.abs(next.pitch - n.pitch) < 0.6 && next.importance <= n.importance) {
      under.push(next);
      next = notes[k + 1 + under.length];
    }
    if (next) end = Math.min(end, next.t - Math.max(0.15, 0.25 * beat));
    if (end - n.t < Math.max(0.8 * diff.holdMin, 0.5 * beat)) continue;
    n.hold = end - n.t;
    for (const m of under) m.dropped = true;
  }
  removeDropped(notes);
}

function removeDropped(notes) {
  let w = 0;
  for (const n of notes) if (!n.dropped) notes[w++] = n;
  notes.length = w;
}

// --- Lanes ---------------------------------------------------------------------------------

// Melodic bars follow the pitch: same note, same lane; up the scale, to the right; a leap,
// a bigger step. Rhythmic bars sway on the beat between two lanes that shift every couple
// of bars, with off-beat notes passing between them. A repeated bar replays its pattern,
// mirrored every other 4-bar phrase. Every move stays within what the player can reach in
// the time since the previous note.
function assignLanes(bars, rng) {
  let lane = Math.floor(LANES / 2);
  let end = -10;
  let moved = -10;
  let dir = rng() < 0.5 ? -1 : 1;
  let prevPitch = NaN;
  let anchors = ANCHORS[0];
  let anchorBar = -Infinity;
  let section;
  for (const bar of bars) {
    const notes = bar.notes;
    if (!notes.length) continue;
    if (bar.section !== section || bar.index - anchorBar >= 2) {
      section = bar.section;
      anchorBar = bar.index;
      const width = bar.energy > 0.75 ? 3 : bar.energy > 0.45 ? 2 : 1;
      const near = ANCHORS.filter((a) => Math.abs(a[0] - lane) <= 1 && Math.abs(a[1] - a[0]) === width);
      anchors = near[Math.floor(rng() * near.length)];
    }
    const melodic = bar.melodic;
    const mirror = !melodic && bar.source && Math.floor((bar.index - bar.source.index) / 4) % 2 === 1;
    const sway = (n) => anchors[n.slot >= 0 ? Math.floor(n.slot / 12) % 2 : 0];
    for (let k = 0; k < notes.length; k++) {
      const n = notes[k];
      const gap = n.t - end;
      const reach = maxMove(gap, n.t - moved);
      const pitched = !Number.isNaN(n.pitch);
      const step = pitched && !Number.isNaN(prevPitch) && gap < 2 ? contour(n.pitch - prevPitch) : null;
      let want;
      if (n.source?.lane !== undefined) want = mirror ? LANES - 1 - n.source.lane : n.source.lane;
      else if (melodic && k === 0) want = planStart(notes, step === null ? lane : lane + step);
      else if (melodic) want = lane + (step ?? 0);
      else if (n.level <= 1) want = sway(n);
      else {
        // Off the beat: a step towards the next beat's lane, or a drift.
        const accent = notes.slice(k + 1).find((m) => m.level <= 1);
        const target = accent ? sway(accent) : anchors[0];
        want = target !== lane ? lane + Math.sign(target - lane) : lane + (rng() < 0.5 ? dir : 0);
      }
      if (want < 0 || want > LANES - 1) dir = -dir;
      n.lane = clamp(clamp(want, 0, LANES - 1), lane - reach, lane + reach);
      if (rng() < 0.12) dir = -dir;
      if (pitched) prevPitch = n.pitch;
      if (n.lane !== lane) moved = n.t;
      lane = n.lane;
      end = n.t + (n.hold || 0);
    }
  }
}

// How many lanes a player can shift between two notes `gap` seconds apart, having last
// changed lanes `sinceMove` seconds ago: a quick one-lane hop needs a moment's rest first.
export function maxMove(gap, sinceMove) {
  const steady = gap < 0.15 ? 0 : Math.min(LANES - 1, Math.floor((gap - 0.03) / 0.12));
  return Math.max(steady, gap >= 0.1 && sinceMove >= 0.22 ? 1 : 0);
}

function contour(semitones) {
  const a = Math.abs(semitones);
  return Math.sign(semitones) * (a < 0.6 ? 0 : a <= 2.5 ? 1 : a <= 7.5 ? 2 : 3);
}

// Starting lane for a melodic bar that keeps its whole contour on the road, as close as
// possible to where the melody wants to go.
function planStart(notes, preferred) {
  let cum = 0;
  let lo = 0;
  let hi = 0;
  let p = NaN;
  for (const n of notes) {
    if (Number.isNaN(n.pitch)) continue;
    if (!Number.isNaN(p)) {
      cum += contour(n.pitch - p);
      lo = Math.min(lo, cum);
      hi = Math.max(hi, cum);
    }
    p = n.pitch;
  }
  if (hi - lo > LANES - 1) return Math.round((LANES - 1 - lo - hi) / 2);
  return clamp(preferred, -lo, LANES - 1 - hi);
}

// --- Power notes and hazards ----------------------------------------------------------

// Every drop lands on a power note, and so does the first downbeat of each 8-bar phrase
// in the song's most intense sections.
function powerNotes(notes, bars, features) {
  const nearest = (t, tol) => {
    let best = null;
    for (const n of notes) if (Math.abs(n.t - t) <= tol && (!best || Math.abs(n.t - t) < Math.abs(best.t - t))) best = n;
    return best;
  };
  for (const td of features.drops ?? []) {
    const n = nearest(td, 0.12);
    if (n) n.power = true;
    else insertNote(notes, td);
  }
  let phraseStart = null;
  for (const bar of bars) {
    if (bar.section?.kind !== 'peak' || !bar.beats) continue;
    if (!phraseStart || bar.section !== phraseStart.section) phraseStart = bar;
    if ((bar.index - phraseStart.index) % 8 !== 0) continue;
    const n = bar.notes[0];
    if (!n || n.level !== 0 || notes.some((m) => m.power && Math.abs(m.t - n.t) < 6)) continue;
    n.power = true;
  }
}

// A note for a drop that has none, on a lane reachable from both neighbours.
function insertNote(notes, t) {
  let k = 0;
  while (k < notes.length && notes[k].t < t) k++;
  const prev = notes[k - 1];
  const next = notes[k];
  if (prev && prev.t + (prev.hold || 0) > t - 0.15) return;
  if (next && next.t - t < 0.15) return;
  const reach = (gap) => maxMove(gap, 0);
  const options = prev ? [prev.lane] : [Math.floor(LANES / 2)];
  if (next) options.push(next.lane);
  for (const lane of options) {
    if (prev && Math.abs(lane - prev.lane) > reach(t - prev.t - (prev.hold || 0))) continue;
    if (next && Math.abs(next.lane - lane) > reach(next.t - t)) continue;
    notes.splice(k, 0, { t, lane, b: ONSET.KICK, pitch: NaN, level: 0, power: true });
    return;
  }
}

// Hazards in the energetic parts of the song: beside a note (never on the lanes the player
// crosses to reach it), or on a beat in the middle of a long gap, in the lane the player is
// sitting in, so they have to dodge and come back. Drops get a wall on the outer lanes.
function hazards(objects, notes, grid, features, diff, rng) {
  const sections = features.sections ?? [];
  const kindAt = (t) => {
    let kind = 'groove';
    for (const s of sections) if (s.start <= t) kind = s.kind;
    return kind;
  };
  const drops = features.drops ?? [];
  const add = (t, lane) => objects.push({ t, lane, kind: KIND.HAZARD, tier: 0, value: 0, hold: 0, state: STATE.PENDING });
  let lastHazard = -10;
  for (let k = 0; k < notes.length; k++) {
    const n = notes[k];
    const prev = notes[k - 1];
    const prevEnd = prev ? prev.t + (prev.hold || 0) : -10;
    const gap = n.t - prevEnd;
    const kind = kindAt(n.t);
    const isDrop = drops.some((d) => Math.abs(d - n.t) < 0.12);
    const level = kind === 'peak' ? 1.4 : kind === 'groove' ? 0.8 : 0.25;
    const I = sampleArray(features.intensity, n.t * features.frameRate);
    const pathLo = Math.min(prev?.lane ?? n.lane, n.lane);
    const pathHi = Math.max(prev?.lane ?? n.lane, n.lane);

    if (isDrop) {
      for (const lane of [0, LANES - 1]) if (lane < pathLo || lane > pathHi) add(n.t, lane);
      lastHazard = n.t;
    } else if (gap >= 0.22 && n.t - lastHazard > 0.5 && rng() < diff.hazard * level * (0.4 + 1.3 * I)) {
      const options = [];
      for (let l = 0; l < LANES; l++) if (l < pathLo || l > pathHi) options.push(l);
      options.sort((a, b) => Math.abs(a - n.lane) - Math.abs(b - n.lane));
      const count = Math.min(options.length, rng() < 0.45 ? 2 : 1);
      for (let h = 0; h < count; h++) add(n.t, options[h]);
      if (count) lastHazard = n.t;
    }

    // Blocker on a beat between two notes far enough apart to dodge it.
    const next = notes[k + 1];
    const end = n.t + (n.hold || 0);
    if (!next || next.t - end < 0.6 || kind === 'calm') continue;
    if (end - lastHazard <= 0.5 || rng() >= diff.hazard * 1.6 * level * (0.5 + I)) continue;
    let th = end + (next.t - end) / 2;
    if (grid?.trusted) th = grid.eighth(th);
    if (th - end < 0.25 || next.t - th < 0.25) continue;
    add(th, n.lane);
    lastHazard = th;
  }
}
