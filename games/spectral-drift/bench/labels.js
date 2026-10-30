// Reference labels for a song: what a careful listener says its beats, bars, sections and
// drops are. Stored next to the audio as `<song file>.labels.json`:
//
//   {
//     "beats": [0.51, 0.99, ...],           every beat, in seconds
//     "downbeats": [0.51, 2.45, ...],       the first beat of every bar
//     "sections": [{ "start": 0, "label": "intro" }, { "start": 15.6, "label": "build" }],
//     "drops": [31.07]                      [] means "this song has no drop"
//   }
//
// Any of the four may be left out; that score is then skipped for the song. Optional:
//   "span": [12.3, 201.7]       the stretch the beats and bars cover (the rest isn't judged)
//   "highlights": [{ "start": 64.2, "end": 95.1 }]   the song's high points (osu! kiai)
//   "source": "..."             where the labels came from
// Harmonix Set annotations (`<song>.beats.txt`, `<song>.segments.txt`) are read too.

export const LABELS_SUFFIX = '.labels.json';

const times = (list) =>
  Array.isArray(list)
    ? list
        .map(Number)
        .filter(Number.isFinite)
        .sort((a, b) => a - b)
    : undefined;

// Labels in a known shape, whatever the file held.
export function normalizeLabels(raw = {}) {
  const out = {};
  const beats = times(raw.beats);
  if (beats?.length) out.beats = beats;
  const downbeats = times(raw.downbeats);
  if (downbeats?.length) out.downbeats = downbeats;
  if (Array.isArray(raw.sections)) {
    out.sections = raw.sections
      .map((s) => ({ start: Number(s.start), label: String(s.label ?? '') }))
      .filter((s) => Number.isFinite(s.start))
      .sort((a, b) => a.start - b.start);
  }
  if (Array.isArray(raw.drops)) out.drops = times(raw.drops);
  const span = times(raw.span);
  if (span?.length === 2 && span[0] < span[1]) out.span = span;
  if (Array.isArray(raw.highlights)) {
    out.highlights = raw.highlights
      .map((h) => ({ start: Number(h.start), end: Number(h.end) }))
      .filter((h) => Number.isFinite(h.start) && h.end > h.start)
      .sort((a, b) => a.start - b.start);
  }
  if (typeof raw.source === 'string' && raw.source) out.source = raw.source;
  return out;
}

// Harmonix Set: beats as "time  beat-in-bar  bar" lines (beat 1 is a downbeat), segments
// as "time  label" lines ending with an "end" marker.
export function harmonixLabels(beatsText, segmentsText) {
  const rows = (text) =>
    (text ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((cols) => cols.length >= 2 && Number.isFinite(Number(cols[0])));
  const out = {};
  if (beatsText) {
    const beats = rows(beatsText);
    out.beats = beats.map((c) => Number(c[0]));
    out.downbeats = beats.filter((c) => Number(c[1]) === 1).map((c) => Number(c[0]));
  }
  if (segmentsText) {
    out.sections = rows(segmentsText)
      .filter((c) => c[1].toLowerCase() !== 'end')
      .map((c) => ({ start: Number(c[0]), label: c.slice(1).join(' ') }));
  }
  return normalizeLabels(out);
}
