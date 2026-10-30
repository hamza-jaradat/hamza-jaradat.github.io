// Scores an analysis against reference labels, in the conventions of music-research
// benchmarks (MIREX, mir_eval): an estimated event counts when it lands within a window
// of a reference event, and each reference event is matched at most once.

export const WINDOWS = { beat: 0.07, boundary: 3, boundaryTight: 0.5, drop: 0.5 };

// How much each score counts towards a song's overall score.
export const WEIGHTS = { beatF: 3, downbeatF: 2, boundaryF3: 1.5, dropF: 2, highlightR: 1 };

export const METRICS = [
  { key: 'beatF', label: 'Beats', hint: `F-measure, ±${WINDOWS.beat * 1000} ms` },
  { key: 'beatAnyF', label: 'Beats (any)', hint: 'best of: as found, off-beat, double or half tempo' },
  { key: 'downbeatF', label: 'Bars', hint: `downbeat F-measure, ±${WINDOWS.beat * 1000} ms` },
  { key: 'boundaryF3', label: 'Sections', hint: `boundary F-measure, ±${WINDOWS.boundary} s` },
  { key: 'boundaryF05', label: 'Sections (tight)', hint: `boundary F-measure, ±${WINDOWS.boundaryTight} s` },
  { key: 'dropF', label: 'Drops', hint: `F-measure, ±${WINDOWS.drop} s` },
  { key: 'highlightR', label: 'Highlights', hint: `starts of the song's high points (osu! kiai) found as a section boundary or drop (recall, ±${WINDOWS.boundary} s)` },
];

// Precision, recall and F-measure of estimated event times against reference times, and
// how far off each match was (estimate minus reference, in seconds).
export function fMeasure(ref, est, window) {
  if (!ref.length && !est.length) return { f: 1, p: 1, r: 1, diffs: [] };
  if (!ref.length || !est.length) return { f: 0, p: est.length ? 0 : 1, r: ref.length ? 0 : 1, diffs: [] };
  const a = [...ref].sort((x, y) => x - y);
  const b = [...est].sort((x, y) => x - y);
  let hits = 0;
  const diffs = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    const d = b[j] - a[i];
    if (Math.abs(d) <= window) {
      hits++;
      diffs.push(d);
      i++;
      j++;
    } else if (d < 0) j++;
    else i++;
  }
  const p = hits / b.length;
  const r = hits / a.length;
  return { f: hits ? (2 * p * r) / (p + r) : 0, p, r, diffs };
}

// The beat F-measure if the estimate were on the off-beat, or at double or half tempo:
// separates a tempo or phase mistake from a beat tracker that is simply lost.
export function beatVariants(ref, est) {
  const mid = (i) => (est[i] + est[i + 1]) / 2;
  const variants = {
    'as found': est,
    'off-beat': est.slice(0, -1).map((_, i) => mid(i)),
    'double tempo': est.flatMap((t, i) => (i < est.length - 1 ? [t, mid(i)] : [t])),
    'half tempo': est.filter((_, i) => i % 2 === 0),
    'half tempo, other phase': est.filter((_, i) => i % 2 === 1),
  };
  let best = { name: 'as found', f: -1 };
  for (const [name, times] of Object.entries(variants)) {
    const { f } = fMeasure(ref, times, WINDOWS.beat);
    if (f > best.f + 1e-9) best = { name, f };
  }
  return best;
}

export function tempo(beats) {
  const gaps = beats.slice(1).map((t, i) => t - beats[i]).sort((a, b) => a - b);
  return gaps.length ? 60 / gaps[gaps.length >> 1] : NaN;
}

// Section boundaries, leaving out the start of the song (which every analysis gets right).
const boundaries = (sections) => sections.map((s) => s.start).filter((t) => t > 1);

// Every score the labels allow: a song labeled with beats only gets beat scores, and so on.
// Beats and bars are judged only inside the labels' span, or else between the first and
// last labeled beat (a song labeled in part isn't penalized for the rest). `beatShift` is
// how late the found beats sit against the labels, typically (ms, median).
export function scoreSong(labels, est) {
  const s = {};
  const beatRange = labels.beats?.length ? [labels.beats[0], labels.beats[labels.beats.length - 1]] : [-Infinity, Infinity];
  const [from, to] = labels.span ?? beatRange;
  const inSpan = (list) => Array.from(list ?? []).filter((t) => t >= from - WINDOWS.beat && t <= to + WINDOWS.beat);
  const estBeats = inSpan(est.beats);
  if (labels.beats?.length) {
    const m = fMeasure(labels.beats, estBeats, WINDOWS.beat);
    s.beatF = m.f;
    if (m.diffs.length) s.beatShift = 1000 * [...m.diffs].sort((a, b) => a - b)[m.diffs.length >> 1];
    const v = beatVariants(labels.beats, estBeats);
    s.beatAnyF = v.f;
    s.beatMode = v.name;
    s.tempoRatio = tempo(estBeats) / tempo(labels.beats);
  }
  if (labels.downbeats?.length) s.downbeatF = fMeasure(labels.downbeats, inSpan(est.downbeats), WINDOWS.beat).f;
  const refBounds = labels.sections ? boundaries(labels.sections) : [];
  if (refBounds.length) {
    const estBounds = boundaries(est.sections ?? []);
    s.boundaryF3 = fMeasure(refBounds, estBounds, WINDOWS.boundary).f;
    s.boundaryF05 = fMeasure(refBounds, estBounds, WINDOWS.boundaryTight).f;
  }
  if (Array.isArray(labels.drops)) s.dropF = fMeasure(labels.drops, Array.from(est.drops ?? []), WINDOWS.drop).f;
  const highs = (labels.highlights ?? []).map((h) => h.start).filter((t) => t > 1);
  if (highs.length) s.highlightR = fMeasure(highs, [...boundaries(est.sections ?? []), ...Array.from(est.drops ?? [])], WINDOWS.boundary).r;
  return s;
}

// One number per song: the weighted mean of the scores it has.
export function overall(score) {
  let sum = 0;
  let weight = 0;
  for (const [key, w] of Object.entries(WEIGHTS)) {
    if (score[key] === undefined) continue;
    sum += w * score[key];
    weight += w;
  }
  return weight ? sum / weight : NaN;
}

// Mean of every score over the songs that have it, plus the mean overall score.
export function summarize(scores) {
  const out = {};
  for (const { key } of METRICS) {
    const vals = scores.map((s) => s[key]).filter((v) => v !== undefined);
    if (vals.length) out[key] = vals.reduce((a, b) => a + b, 0) / vals.length;
  }
  const totals = scores.map(overall).filter((v) => !Number.isNaN(v));
  out.overall = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : NaN;
  return out;
}
