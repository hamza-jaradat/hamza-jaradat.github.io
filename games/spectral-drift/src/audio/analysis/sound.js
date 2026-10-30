// What the music sounds like, from Google's YAMNet sound classifier (Apache-2.0; the model,
// with its larger layers stored in 8 bits, is in ./yamnet). Every 0.48 s it scores how
// likely each of AudioSet's 521 kinds of sound is in the last 0.96 s, music genres among
// them. soundScores() runs it over the song; genreOf() turns the scores into a genre by a
// vote of the song's moments, so a song that is mostly rapped is hip-hop even if one part
// is metal.
//
// Running the model needs TensorFlow.js, which the caller sets up and passes in, as for
// the notes (notes.js).

export const SOUND_SR = 16000;
const HOP = 0.48; // seconds between scores
const CHUNK_FRAMES = 60; // scores per run of the model (29 s), so memory stays small
const MAX_CHUNKS = 4; // a longer song is heard in this many stretches, spread through it
const WINDOW = 0.975; // seconds of audio behind the first score

// The AudioSet classes (YAMNet's indices) that say a genre, under the keys of
// game/genres.js.
const GENRE_CLASSES = {
  hiphop: { 212: 'hip hop music', 31: 'rapping', 213: 'beatboxing' },
  rock: { 214: 'rock music', 215: 'heavy metal', 216: 'punk rock', 217: 'grunge', 218: 'progressive rock', 219: 'rock and roll', 220: 'psychedelic rock' },
  electronic: { 234: 'electronic music', 235: 'house music', 236: 'techno', 237: 'dubstep', 238: 'drum and bass', 239: 'electronica', 240: 'electronic dance music', 242: 'trance music', 269: 'dance music' },
  pop: { 211: 'pop music', 221: 'rhythm and blues', 222: 'soul music', 227: 'funk', 231: 'disco' },
  ambient: { 241: 'ambient music', 248: 'new-age music', 232: 'classical music', 233: 'opera', 230: 'jazz', 265: 'soundtrack music' },
};
const CLASSES = Object.values(GENRE_CLASSES).flatMap((names) => Object.keys(names).map(Number));
// Each genre's columns among CLASSES: [genre, first, end, class names].
const SPANS = [];
for (const [genre, names] of Object.entries(GENRE_CLASSES)) {
  const first = SPANS.length ? SPANS[SPANS.length - 1][2] : 0;
  SPANS.push([genre, first, first + Object.keys(names).length, Object.values(names)]);
}
const noop = () => {};

// Mono audio at SOUND_SR: low-passed below the new Nyquist (a 63-tap windowed sinc), then
// linearly interpolated.
export function toSoundRate(x, sr) {
  const fc = (0.45 * SOUND_SR) / sr;
  const half = 31;
  const h = new Float32Array(2 * half + 1);
  let sum = 0;
  for (let k = -half; k <= half; k++) {
    const a = (Math.PI * k) / (half + 1);
    h[k + half] = (k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k)) * (0.42 + 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a));
    sum += h[k + half];
  }
  const filtered = (i) => {
    let s = 0;
    for (let k = Math.max(-half, -i); k <= half && i + k < x.length; k++) s += x[i + k] * h[k + half];
    return s / sum;
  };
  const ratio = sr / SOUND_SR;
  const out = new Float32Array(Math.floor(x.length / ratio));
  let k1 = -1;
  let v1 = 0;
  for (let i = 0; i < out.length; i++) {
    const p = i * ratio;
    const k = Math.floor(p);
    const a = k === k1 ? v1 : filtered(k);
    k1 = k + 1;
    v1 = filtered(k1);
    out[i] = a + (v1 - a) * (p - k);
  }
  return out;
}

// The genre classes' scores over the song: `scores` holds n rows of CLASSES.length values,
// one row per 0.48 s heard, starting at `times` (s). A song longer than MAX_CHUNKS runs of
// the model is heard in that many stretches, centered in equal parts of it.
export async function soundScores(tf, model, x, sr, progress = noop) {
  const ratio = sr / SOUND_SR;
  const size = Math.floor(x.length / ratio); // the song's length at SOUND_SR
  const step = Math.round(CHUNK_FRAMES * HOP * SOUND_SR);
  const length = Math.round(((CHUNK_FRAMES - 1) * HOP + WINDOW) * SOUND_SR);
  const total = Math.ceil(size / step);
  const starts =
    total <= MAX_CHUNKS
      ? Array.from({ length: total }, (_, i) => i * step)
      : Array.from({ length: MAX_CHUNKS }, (_, i) => Math.max(0, Math.round(((i + 0.5) / MAX_CHUNKS) * size - length / 2)));
  const rows = [];
  const times = [];
  for (const [i, a] of starts.entries()) {
    // Only the stretch heard is resampled.
    const from = Math.floor(a * ratio);
    const chunk = toSoundRate(x.subarray(from, Math.min(x.length, Math.ceil((a + length) * ratio) + 2)), sr).subarray(0, length);
    if (chunk.length < WINDOW * SOUND_SR) break;
    const out = model.execute(tf.tensor1d(chunk), ['Identity']);
    const all = await out.data();
    out.dispose();
    const n = Math.min(CHUNK_FRAMES, all.length / 521);
    for (let r = 0; r < n; r++) {
      rows.push(CLASSES.map((c) => all[r * 521 + c]));
      times.push(a / SOUND_SR + r * HOP);
    }
    progress((i + 1) / starts.length);
  }
  return { scores: Float32Array.from(rows.flat()), times: Float32Array.from(times), n: rows.length };
}

// The genre most of the song's moments vote for: each moment goes to the genre whose
// classes score highest, if that score reaches `floor`. The winner needs `minShare` of the
// moments and `margin` times the runner-up's votes, else the sound doesn't say (null); a
// song that mixes two genres goes to the one it has more of. `evidence` names the winner's
// two strongest classes.
export function genreOf({ scores, n }, { floor = 0.02, minShare = 0.15, margin = 1.15 } = {}) {
  const votes = Object.fromEntries(SPANS.map(([genre]) => [genre, 0]));
  const totals = new Float32Array(CLASSES.length);
  for (let r = 0; r < n; r++) {
    const row = scores.subarray(r * CLASSES.length, (r + 1) * CLASSES.length);
    let best = null;
    let top = floor;
    for (const [genre, first, end] of SPANS) {
      for (let c = first; c < end; c++) {
        totals[c] += row[c];
        if (row[c] >= top) {
          top = row[c];
          best = genre;
        }
      }
    }
    if (best) votes[best]++;
  }
  const shares = Object.fromEntries(SPANS.map(([genre]) => [genre, n ? votes[genre] / n : 0]));
  const [first, second] = Object.keys(shares).sort((a, b) => shares[b] - shares[a]);
  const genre = shares[first] >= minShare && shares[first] >= margin * shares[second] ? first : null;
  const span = SPANS.find(([g]) => g === genre);
  const evidence = span
    ? span[3]
        .map((name, i) => [name, totals[span[1] + i]])
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([name]) => name)
    : [];
  return { genre, shares, evidence };
}
