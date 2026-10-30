// Offline music analysis, in stages:
//   spectrogram -> harmonic/percussive split -> onsets per layer (kick, snare, hats, tones)
//   -> pitch and chroma -> tempo, beats and bars -> sections, drops and build-ups
// plus the intensity curve and the compact spectrogram that drive the visuals.
//
// It runs in two halves. prepare() does the heavy signal processing that has no tunable
// params; interpret() turns its output into notes, beats, bars and structure under a set
// of params. In between, the caller adds the Basic Pitch model's activations (notes.js) to
// prepare()'s output as `keys`, if it can run the model: they give the melody's notes. The
// game runs all of it with the defaults (analysis.worker.js); the benchmark caches the
// first two per song and re-runs interpret() while tuning.
import { clamp, movingAverage, percentile } from '../../util.js';
import { barPositions, estimateTempo, extendBeats, steadyGrid, trackBeats } from './beats.js';
import { hpss } from './hpss.js';
import { KEY_RATE, joinMelody, leadLine, trackNotes } from './notes.js';
import { ONSET, ONSET_FIELDS, detectOnsets, flux, logSpec, strengths } from './onsets.js';
import { DEFAULT_PARAMS } from './params.js';
import { pitchAt, pitchTrack } from './pitch.js';
import { BANDS, bandRange, spectrogram } from './spectrogram.js';
import { analyzeStructure } from './structure.js';

const SPEC_BANDS = 32;
const noop = () => {};

export function prepare(x, sr, progress = noop) {
  const spec = spectrogram(x, sr, (p) => progress(0.4 * p));
  const { nFrames, frameRate, centerOffset, power, centers } = spec;
  const timeOf = (f) => f / frameRate + centerOffset;

  // --- Layers -------------------------------------------------------------
  const { harmonic, percussive } = hpss(spec.bands, nFrames, BANDS);
  progress(0.5);
  const logAll = logSpec(spec.bands);
  const logPerc = logSpec(percussive);
  const logTone = logSpec(harmonic);
  const lowBands = bandRange(centers, 0, 160);
  const midBands = bandRange(centers, 160, 2200);
  const highBands = bandRange(centers, 2200, 20000);
  const toneBands = bandRange(centers, 150, 4000);
  const fluxes = [
    flux(logPerc, nFrames, BANDS, lowBands),
    flux(logPerc, nFrames, BANDS, midBands),
    flux(logPerc, nFrames, BANDS, highBands),
    flux(logTone, nFrames, BANDS, toneBands),
  ];
  const [busy] = strengths([flux(logAll, nFrames, BANDS, [0, BANDS])]);
  progress(0.55);

  // --- Pitch ----------------------------------------------------------------
  const pitch = pitchTrack(x, sr, (p) => progress(0.55 + 0.3 * p));

  // --- Intensity --------------------------------------------------------------
  const smoothPower = movingAverage(power, Math.round(0.75 * frameRate));
  const loudDb = smoothPower.map((v) => 10 * Math.log10(v + 1e-10));
  const activity = movingAverage(busy, Math.round(1.0 * frameRate));
  const loudN = normalizeRobust(loudDb, 0.08, 0.98);
  const busyN = normalizeRobust(activity, 0.08, 0.98);
  const mix = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) mix[i] = 0.62 * loudN[i] + 0.38 * busyN[i];
  const level = normalizeRobust(movingAverage(mix, Math.round(0.6 * frameRate)), 0.02, 0.995);
  // Blend in a rank-equalized copy so even a uniformly loud master spans calm..intense.
  const ranked = equalize(level);
  const blended = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) blended[i] = 0.5 * level[i] + 0.5 * ranked[i];
  const intensity = movingAverage(blended, Math.round(0.25 * frameRate));

  // Where the music is audible: within 30 dB of its loudest part (pad intros and fades
  // count, silence and reverb tails don't).
  let loudest = 0;
  for (let i = 0; i < nFrames; i++) loudest = Math.max(loudest, smoothPower[i]);
  let firstFrame = 0;
  while (firstFrame < nFrames - 1 && smoothPower[firstFrame] < loudest * 1e-3) firstFrame++;
  let lastFrame = nFrames - 1;
  while (lastFrame > firstFrame && smoothPower[lastFrame] < loudest * 1e-3) lastFrame--;

  // Band envelopes (pulses), percussive bass (drop detection) and tone energy (sustain).
  const groupMean = (logS, [b0, b1]) => {
    const out = new Float32Array(nFrames);
    for (let f = 0; f < nFrames; f++) {
      let s = 0;
      for (let b = b0; b < b1; b++) s += logS[f * BANDS + b];
      out[f] = s / (b1 - b0);
    }
    return out;
  };
  const low = normalizeRobust(movingAverage(groupMean(logAll, lowBands), 1), 0.05, 0.995);
  const mid = normalizeRobust(movingAverage(groupMean(logAll, midBands), 1), 0.05, 0.995);
  const high = normalizeRobust(movingAverage(groupMean(logAll, highBands), 1), 0.05, 0.995);
  const bass = normalizeRobust(movingAverage(groupMean(logPerc, lowBands), Math.round(0.1 * frameRate)), 0.05, 0.98);
  const toneEnergy = groupMean(harmonic, toneBands);

  // --- Visual spectrum, normalised per band so every bar uses its full range ------
  const spectrum = new Uint8Array(nFrames * SPEC_BANDS);
  const column = new Float32Array(nFrames);
  for (let b = 0; b < SPEC_BANDS; b++) {
    for (let f = 0; f < nFrames; f++) column[f] = (logAll[f * BANDS + 2 * b] + logAll[f * BANDS + 2 * b + 1]) / 2;
    const lo = percentile(column, 0.15);
    const hi = Math.max(percentile(column, 0.995), lo + 1e-3);
    for (let f = 0; f < nFrames; f++) spectrum[f * SPEC_BANDS + b] = Math.round(Math.pow(clamp((column[f] - lo) / (hi - lo), 0, 1), 1.4) * 255);
  }
  progress(1);

  return {
    duration: x.length / sr,
    nFrames,
    frameRate,
    centerOffset,
    fluxes,
    pitch,
    intensity,
    audible: [timeOf(firstFrame), timeOf(lastFrame)],
    low,
    mid,
    high,
    bass,
    toneEnergy,
    spectrum,
  };
}

export function interpret(prep, params = DEFAULT_PARAMS, progress = noop) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const { duration, nFrames, frameRate, centerOffset, pitch, intensity, toneEnergy } = prep;
  const timeOf = (f) => f / frameRate + centerOffset;

  // --- Onsets -------------------------------------------------------------------
  const [kick, snare, hat, tone] = strengths(prep.fluxes, p.onsetShare, [p.floorKick, p.floorSnare, p.floorHat, p.floorTone]);
  const events = detectOnsets(
    [
      { curve: kick, type: ONSET.KICK, weight: 1.0, delta: 0.08, sharp: p.sharpKick },
      { curve: snare, type: ONSET.SNARE, weight: 0.9, delta: 0.08, sharp: p.sharpSnare },
      { curve: hat, type: ONSET.HAT, weight: 0.6, delta: 0.1, sharp: p.sharpHat },
      { curve: tone, type: ONSET.TONE, weight: 0.85, delta: 0.1, sharp: p.sharpTone },
    ],
    frameRate,
    timeOf,
  );
  progress(0.2);

  // --- Beats, bars and structure ------------------------------------------------
  const env = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) env[i] = kick[i] + p.envSnare * snare[i] + p.envHat * hat[i] + p.envTone * tone[i];
  const bpm = estimateTempo(env, frameRate, p);
  const tracked = Float32Array.from(trackBeats(env, frameRate, bpm, p), (f) => timeOf(f));
  // The grid spans the music: where it is audible, and every onset.
  const first = Math.min(prep.audible[0], events.length ? events[0].t : Infinity);
  const last = Math.max(prep.audible[1], events.length ? events[events.length - 1].t : 0);
  const steady = steadyGrid(tracked, first, last, p);
  const beats = steady ?? extendBeats(tracked, first, last);
  const peakNear = (curve, t) => {
    const f = Math.round((t - centerOffset) * frameRate);
    let m = 0;
    for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < nFrames) m = Math.max(m, curve[k]);
    return m;
  };
  const positions = barPositions(beats, (t) => ({ kick: peakNear(kick, t), snare: peakNear(snare, t) }), pitch, p);
  const structure = analyzeStructure({ beatTimes: beats, positions, duration, frameRate, intensity, low: prep.bass, events, pitch, params: p });
  progress(0.6);

  // --- Notes: pitch and sustain for each onset ------------------------------------
  let onsets;
  if (prep.keys) {
    // The melody gives every onset its pitch and every melody note its length; a melody note
    // no onset caught (a pitch change without a new attack, say) becomes an onset of its own.
    const notes = trackNotes(prep.keys, { onsetThresh: p.noteOnset, frameThresh: p.noteFrame, minFrames: Math.round(p.noteMinLen * KEY_RATE) });
    const lead = leadLine(notes, prep.keys.n, { minMidi: p.leadMin, share: p.leadShare });
    const list = joinMelody(events, lead.melody, p.noteMatch);
    onsets = new Float32Array(list.length * ONSET_FIELDS);
    list.forEach((o, i) => onsets.set([o.t, o.s, o.b, o.note ? o.note.midi : lead.at(o.t + 0.04), o.note ? o.note.dur : 0], i * ONSET_FIELDS));
  } else {
    onsets = new Float32Array(events.length * ONSET_FIELDS);
    const pitches = events.map((o) => pitchAt(pitch, o.t + 0.03, o.t + 0.13));
    events.forEach((o, i) => {
      const pc = pitches[i];
      let sustain = 0;
      if (o.b & ONSET.TONE) {
        // A note ends where it is struck again (any tone, if its pitch is unknown).
        let stop = Math.min(nFrames, o.f + Math.round(3 * frameRate));
        for (let j = i + 1; j < events.length && events[j].f < stop; j++) {
          if (events[j].b & ONSET.TONE && (Number.isNaN(pc) || Math.abs(pitches[j] - pc) < 0.6)) stop = events[j].f;
        }
        sustain = sustainLength(toneEnergy, o.f, stop, frameRate, pitch, pc, timeOf);
      }
      onsets.set([o.t, o.s, o.b, pc, sustain], i * ONSET_FIELDS);
    });
  }
  progress(1);

  return {
    frameRate,
    intensity,
    low: prep.low,
    mid: prep.mid,
    high: prep.high,
    spectrum: prep.spectrum,
    specBands: SPEC_BANDS,
    onsets,
    bpm: steady && beats.length > 1 ? 60 / ((beats[beats.length - 1] - beats[0]) / (beats.length - 1)) : bpm,
    steadyTempo: !!steady,
    beats,
    beatOffset: beats.length ? beats[0] : 0,
    downbeats: structure.downbeats,
    sections: structure.sections,
    drops: structure.drops,
    builds: structure.builds,
    breakdowns: structure.breakdowns,
  };
}

// How long a tone rings: while the harmonic energy holds up and the note's pitch class stays
// prominent in the harmony, whatever other instruments come and go meanwhile.
function sustainLength(energy, f0, stop, fr, pitch, p0, timeOf) {
  let peak = 0;
  for (let f = f0; f < Math.min(stop, f0 + 5); f++) peak = Math.max(peak, energy[f]);
  const pc = Number.isNaN(p0) ? -1 : ((Math.round(p0) % 12) + 12) % 12;
  const chromaAt = (t) => pitch.chroma[clamp(Math.round((t - pitch.offset) * pitch.rate), 0, pitch.pitch.length - 1) * 12 + pc];
  // Only a tone that starts here can ring on: a hit over a chord that is already sounding
  // has no sustain of its own. A new tone gets louder, or brings in its pitch.
  let before = 0;
  for (let f = Math.max(0, f0 - 4); f < f0; f++) before += energy[f] / 4;
  const louder = peak >= 1.25 * before;
  const newPitch = pc >= 0 && chromaAt(timeOf(f0) + 0.06) - chromaAt(timeOf(f0) - 0.08) >= 0.3;
  if (!louder && !newPitch) return 0;
  let faded = 0;
  let f = f0 + 1;
  for (; f < stop; f++) {
    if (energy[f] < (pc < 0 ? 0.5 : 0.3) * peak) break;
    if (pc < 0) continue;
    faded = chromaAt(timeOf(f)) < 0.6 ? faded + 1 : 0;
    if (faded > 0.1 * fr) {
      f -= faded;
      break;
    }
  }
  return (f - f0) / fr;
}

function normalizeRobust(arr, pLo, pHi) {
  const lo = percentile(arr, pLo);
  const hi = percentile(arr, pHi);
  const out = new Float32Array(arr.length);
  if (hi - lo < 1e-6) {
    out.fill(0.4);
    return out;
  }
  for (let i = 0; i < arr.length; i++) out[i] = clamp((arr[i] - lo) / (hi - lo), 0, 1);
  return out;
}

// Maps each value to its percentile rank (histogram equalization).
function equalize(arr) {
  const n = arr.length;
  const sorted = Float32Array.from(arr).sort();
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (sorted[m] < arr[i]) lo = m + 1;
      else hi = m;
    }
    out[i] = n > 1 ? lo / (n - 1) : 0.5;
  }
  return out;
}
