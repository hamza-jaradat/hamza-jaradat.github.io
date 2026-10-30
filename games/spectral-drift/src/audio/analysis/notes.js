// Notes and melody from Spotify's Basic Pitch model (github.com/spotify/basic-pitch,
// Apache-2.0; the model files and their license are in ./basic-pitch). The model hears
// 2-second windows of 22.05 kHz audio and says, about 86 times a second and for each of the
// 88 piano keys, how likely a note is sounding there and how likely one starts. trackNotes()
// turns that into notes the way Basic Pitch does; leadLine() picks the melody out of them;
// joinMelody() hands it to the onsets.
//
// Running the model needs TensorFlow.js, which the caller sets up and passes in (a WebGL or
// WASM backend in the browser's analysis worker, WASM in the benchmark).
import { ONSET } from './onsets.js';

export const NOTE_SR = 22050;
const HOP = 256;
const WINDOW = 2 * NOTE_SR - HOP; // samples in; FRAMES frames out
const FRAMES = 172;
const TRIM = 15; // frames dropped at each end of a window, where it overlaps its neighbours
const KEEP = FRAMES - 2 * TRIM;
const STEP = WINDOW - 2 * TRIM * HOP;
const KEYS = 88;
const MIDI_A0 = 21;
export const KEY_RATE = NOTE_SR / HOP; // activation frames per second
const noop = () => {};

// When activation frame j sounds (s).
export const keyTime = (j) => (Math.floor(j / KEEP) * STEP + (j % KEEP) * HOP) / NOTE_SR;

// The activation frame sounding at time t.
function keyFrame(t) {
  const s = t * NOTE_SR;
  const w = Math.floor(s / STEP);
  return w * KEEP + Math.min(KEEP - 1, Math.max(0, Math.round((s - w * STEP) / HOP)));
}

// The model, from its graph (model.json) and weights; `loadGraphModel` is TensorFlow.js's.
export function loadModel(loadGraphModel, json, weights) {
  return loadGraphModel({
    load: async () => ({
      modelTopology: json.modelTopology,
      format: json.format,
      generatedBy: json.generatedBy,
      convertedBy: json.convertedBy,
      weightSpecs: json.weightsManifest.flatMap((group) => group.weights),
      weightData: weights,
      signature: json.signature,
    }),
  });
}

// Mono audio at NOTE_SR (linear interpolation: the model listens below 4 kHz).
export function resample(x, sr) {
  if (sr === NOTE_SR) return x;
  const n = Math.floor((x.length * NOTE_SR) / sr);
  const out = new Float32Array(n);
  const step = sr / NOTE_SR;
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const k = Math.floor(p);
    const a = p - k;
    out[i] = x[k] + ((k + 1 < x.length ? x[k + 1] : x[k]) - x[k]) * a;
  }
  return out;
}

// The model's note and onset activations over the whole song: `frames` and `onsets`, n rows
// of 88 keys (A0 up). `x` is mono audio at NOTE_SR; windows go through `batch` at a time.
export async function keyActivations(tf, model, x, progress = noop, batch = 4) {
  const windows = Math.ceil((TRIM * HOP + x.length) / STEP);
  const frames = new Float32Array(windows * KEEP * KEYS);
  const onsets = new Float32Array(windows * KEEP * KEYS);
  const input = new Float32Array(batch * WINDOW);
  for (let w0 = 0; w0 < windows; w0 += batch) {
    const m = Math.min(batch, windows - w0);
    input.fill(0);
    for (let k = 0; k < m; k++) {
      // Window w starts half an overlap before its kept frames, so the first sits at 0 s.
      const start = (w0 + k) * STEP - TRIM * HOP;
      const a = Math.max(0, start);
      const b = Math.min(x.length, start + WINDOW);
      if (b > a) input.set(x.subarray(a, b), k * WINDOW + a - start);
    }
    const out = tf.tidy(() => model.execute(tf.tensor3d(input.subarray(0, m * WINDOW), [m, WINDOW, 1]), ['Identity_1', 'Identity_2']));
    const [noteData, onsetData] = await Promise.all(out.map((t) => t.data()));
    for (const t of out) t.dispose();
    for (let k = 0; k < m; k++) {
      const from = (k * FRAMES + TRIM) * KEYS;
      frames.set(noteData.subarray(from, from + KEEP * KEYS), (w0 + k) * KEEP * KEYS);
      onsets.set(onsetData.subarray(from, from + KEEP * KEYS), (w0 + k) * KEEP * KEYS);
    }
    progress((w0 + m) / windows);
  }
  let n = windows * KEEP;
  while (n > 0 && keyTime(n - 1) >= x.length / NOTE_SR) n--;
  return { frames: frames.subarray(0, n * KEYS), onsets: onsets.subarray(0, n * KEYS), n };
}

// Notes from the activations, tracked as Basic Pitch does (adapted from outputToNotesPoly
// in basic-pitch-ts, Copyright 2022 Spotify AB, Apache-2.0; rewritten on flat arrays): a note
// starts at a peak of the onset activation (or a sudden rise of the note activation) above
// `onsetThresh`, and lasts while the note activation stays above `frameThresh`, allowing
// dips of up to `tolerance` frames. Then the strongest activation left unexplained grows
// into notes too. Notes shorter than `minFrames` are dropped. Returns { f0, f1, midi, amp,
// t, dur } in time order, f0..f1 in activation frames, amp their mean activation.
export function trackNotes({ frames, onsets, n }, { onsetThresh = 0.5, frameThresh = 0.3, minFrames = 11, tolerance = 11 } = {}) {
  // Onsets the model may have missed: where a key's activation jumps up, scaled to the
  // onset activation's range.
  const starts = new Float32Array(n * KEYS);
  let onsetMax = 0;
  let riseMax = 0;
  for (let i = 0; i < n * KEYS; i++) onsetMax = Math.max(onsetMax, onsets[i]);
  for (let f = 2; f < n; f++) {
    for (let k = 0; k < KEYS; k++) {
      const v = frames[f * KEYS + k];
      const rise = Math.max(0, Math.min(v - frames[(f - 1) * KEYS + k], v - frames[(f - 2) * KEYS + k]));
      starts[f * KEYS + k] = rise;
      riseMax = Math.max(riseMax, rise);
    }
  }
  const scale = riseMax > 0 ? onsetMax / riseMax : 0;
  for (let i = 0; i < n * KEYS; i++) starts[i] = Math.max(onsets[i], starts[i] * scale);

  const energy = Float32Array.from(frames);
  const take = (f, k) => {
    energy[f * KEYS + k] = 0;
    if (k > 0) energy[f * KEYS + k - 1] = 0;
    if (k < KEYS - 1) energy[f * KEYS + k + 1] = 0;
  };
  const notes = [];
  const add = (f0, f1, k) => {
    let sum = 0;
    for (let f = f0; f < f1; f++) sum += frames[f * KEYS + k];
    notes.push({ f0, f1, midi: k + MIDI_A0, amp: sum / (f1 - f0) });
  };

  // Peaks of the onset activation, latest first (as Basic Pitch takes them).
  const peaks = [];
  for (let f = 0; f < n - 1; f++) {
    for (let k = 0; k < KEYS; k++) {
      const v = starts[f * KEYS + k];
      if (v > onsetThresh && (f === 0 || v > starts[(f - 1) * KEYS + k]) && v > starts[(f + 1) * KEYS + k]) peaks.push(f * KEYS + k);
    }
  }
  for (let p = peaks.length - 1; p >= 0; p--) {
    const f0 = Math.floor(peaks[p] / KEYS);
    const k = peaks[p] % KEYS;
    let f = f0 + 1;
    let quiet = 0;
    while (f < n - 1 && quiet < tolerance) {
      quiet = energy[f * KEYS + k] < frameThresh ? quiet + 1 : 0;
      f++;
    }
    f -= quiet;
    if (f - f0 <= minFrames) continue;
    for (let g = f0; g < f; g++) take(g, k);
    add(f0, f, k);
  }

  // Activation no onset explains, strongest first, grown in both directions.
  const rest = [];
  for (let i = 0; i < n * KEYS; i++) if (energy[i] > frameThresh) rest.push(i);
  rest.sort((a, b) => energy[b] - energy[a]);
  for (const i of rest) {
    if (energy[i] <= frameThresh) continue;
    const mid = Math.floor(i / KEYS);
    const k = i % KEYS;
    energy[i] = 0;
    let f = mid + 1;
    let quiet = 0;
    while (f < n - 1 && quiet < tolerance) {
      quiet = energy[f * KEYS + k] < frameThresh ? quiet + 1 : 0;
      take(f, k);
      f++;
    }
    const f1 = f - 1 - quiet;
    f = mid - 1;
    quiet = 0;
    while (f > 0 && quiet < tolerance) {
      quiet = energy[f * KEYS + k] < frameThresh ? quiet + 1 : 0;
      take(f, k);
      f--;
    }
    const f0 = f + 1 + quiet;
    if (f1 - f0 > minFrames) add(f0, f1, k);
  }

  notes.sort((a, b) => a.f0 - b.f0 || b.midi - a.midi);
  for (const note of notes) {
    note.t = keyTime(note.f0);
    note.dur = keyTime(note.f1) - note.t;
  }
  return notes;
}

// The melody among the notes: at each moment, the highest note above the bass (`minMidi`)
// that is at least `share` as strong as the strongest one sounding. Returns `at(t)`, the
// melody's pitch at time t (NaN in its rests), and the notes that start as the melody, each
// lasting until the melody moves on ({ t, dur, midi, amp }).
export function leadLine(notes, n, { minMidi = 48, share = 0.6 } = {}) {
  const lead = new Int32Array(n).fill(-1);
  const sounding = [];
  let next = 0;
  for (let f = 0; f < n; f++) {
    while (next < notes.length && notes[next].f0 <= f) {
      if (notes[next].midi >= minMidi) sounding.push(next);
      next++;
    }
    let top = 0;
    let w = 0;
    for (const i of sounding) {
      if (notes[i].f1 <= f) continue;
      sounding[w++] = i;
      top = Math.max(top, notes[i].amp);
    }
    sounding.length = w;
    for (const i of sounding) if (notes[i].amp >= share * top && (lead[f] < 0 || notes[i].midi > notes[lead[f]].midi)) lead[f] = i;
  }

  const melody = [];
  notes.forEach((note, i) => {
    // A note joins the melody if it leads just after it starts, once the notes struck with
    // it (a kick's thud, the rest of a chord) have all begun.
    let f = Math.min(note.f0 + 2, note.f1 - 1);
    if (f >= n || lead[f] !== i) return;
    while (f < n && lead[f] === i) f++;
    melody.push({ t: note.t, dur: keyTime(f) - note.t, midi: note.midi, amp: note.amp });
  });
  const at = (t) => {
    const f = keyFrame(t);
    return f >= 0 && f < n && lead[f] >= 0 ? notes[lead[f]].midi : NaN;
  };
  return { at, melody };
}

// Hands the melody to the onsets: each melody note claims the nearest onset within
// `window` seconds (which becomes tonal, whatever else it is), or else becomes an onset of
// its own, as strong as the onsets that matched notes of its strength. Returns a new list
// of onsets in time order, each melody onset carrying its `note`.
export function joinMelody(events, melody, window) {
  const out = events.map((e) => ({ ...e }));
  const extra = [];
  let j = 0;
  for (const note of heldThrough(melody, events, window)) {
    while (j < out.length - 1 && out[j + 1].t <= note.t) j++;
    let best = null;
    for (const e of [out[j], out[j + 1]]) {
      if (!e || e.note || Math.abs(e.t - note.t) > window) continue;
      if (!best || Math.abs(e.t - note.t) < Math.abs(best.t - note.t)) best = e;
    }
    if (best) {
      best.note = note;
      best.b |= ONSET.TONE;
    } else extra.push({ t: note.t, b: ONSET.TONE, note });
  }
  const ratios = out.filter((e) => e.note && e.note.amp > 0).map((e) => e.s / e.note.amp);
  ratios.sort((a, b) => a - b);
  const scale = ratios.length ? ratios[ratios.length >> 1] : 1;
  for (const e of extra) e.s = e.note.amp * scale;
  return out.concat(extra).sort((a, b) => a.t - b.t);
}

// The model starts the same note again at a loud drum hit under it. A melody note that takes
// over right where the same pitch left off, with no tonal onset to say it was struck again,
// is the same note held on.
function heldThrough(melody, events, window) {
  const out = [];
  let j = 0;
  for (const note of melody) {
    const prev = out[out.length - 1];
    if (prev && prev.midi === note.midi && note.t - (prev.t + prev.dur) < 0.03) {
      while (j < events.length && events[j].t < note.t - window) j++;
      let struck = false;
      for (let k = j; k < events.length && events[k].t <= note.t + window; k++) if (events[k].b & ONSET.TONE) struck = true;
      if (!struck) {
        prev.dur = note.t + note.dur - prev.t;
        continue;
      }
    }
    out.push({ ...note });
  }
  return out;
}
