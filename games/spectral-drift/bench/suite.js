// The benchmark's built-in songs: the game's demo track, and synthetic tracks that each
// catch a specific mistake. Their labels are exact, because they're known by construction.
import { prepareSamples } from '../src/audio/analyzer.js';
import { DEMO_LAYOUT, SR as DEMO_SR, compose } from '../src/audio/demoSong.synth.js';
import { track } from './synth.js';

const PROG = [
  [57, 60, 64],
  [53, 57, 60],
  [55, 59, 62],
  [52, 55, 59],
];
const range = (n, f) => Array.from({ length: n }, (_, k) => f(k));

export const BUILT_IN = {
  demo: {
    about: 'the built-in demo: 124 BPM, build-ups and two drops',
    make: demo,
  },
  steadyGroove: {
    about: 'drums and chords at 100 BPM; no drop',
    make: () => {
      const s = track(64);
      const b = 0.6;
      for (let k = 0; k < 104; k++) {
        const t = 0.2 + k * b;
        s.kick(t);
        if (k % 4 === 1 || k % 4 === 3) s.snare(t);
        s.hat(t + b / 2);
        if (k % 8 === 0) s.chord(t, 8 * b, PROG[(k / 8) % 4]);
      }
      return { ...s, labels: { beats: range(104, (k) => 0.2 + k * b), downbeats: range(26, (k) => 0.2 + 4 * k * b), drops: [] } };
    },
  },
  ambientPads: {
    about: 'slow pad chords with no beat; nothing should become a drop',
    make: () => {
      const s = track(40);
      for (let k = 0; k < 10; k++) s.chord(0.2 + k * 4, 4.2, PROG[k % 4]);
      return { ...s, labels: { drops: [] } };
    },
  },
  tempoRamp: {
    about: 'drums speeding up from 90 to 130 BPM',
    make: () => {
      const s = track(60);
      const beats = [];
      for (let t = 0.2, bpm = 90, k = 0; t < 59; t += 60 / bpm, bpm += 40 / 110, k++) {
        s.kick(t);
        if (k % 2 === 1) s.snare(t);
        s.hat(t + 30 / bpm);
        beats.push(t);
      }
      return { ...s, labels: { beats, drops: [] } };
    },
  },
  padsThenDrums: {
    about: 'pads alone, then drums come in at 24.2 s: the drop',
    make: () => {
      const s = track(48);
      const b = 0.5;
      for (let k = 0; k < 12; k++) s.chord(0.2 + k * 4, 4.2, PROG[k % 4]);
      for (let k = 0; k < 48; k++) {
        const t = 24.2 + k * b;
        s.kick(t);
        if (k % 2 === 1) s.snare(t);
        s.hat(t + b / 2);
      }
      return {
        ...s,
        labels: {
          beats: range(96, (k) => 0.2 + k * b),
          downbeats: range(24, (k) => 0.2 + 4 * k * b),
          sections: [
            { start: 0, label: 'pads' },
            { start: 24.2, label: 'drums' },
          ],
          drops: [24.2],
        },
      };
    },
  },
  heldMelody: {
    about: 'a melody of long notes over a kick at 100 BPM',
    make: () => {
      const s = track(40);
      const b = 0.6;
      for (let k = 0; k < 64; k++) s.kick(0.2 + k * b, 0.7);
      const tune = [[2, 72], [1, 74], [1, 76], [3, 79], [1, 77], [2, 76], [2, 74], [4, 72], [1, 67], [1, 69], [2, 71], [2, 72], [4, 74], [2, 76], [2, 74], [4, 72]];
      let t = 0.2 + 4 * b;
      for (let rep = 0; rep < 2; rep++) {
        for (const [beats, m] of tune) {
          s.note(t, beats * b * 0.95, m);
          t += beats * b;
        }
      }
      return { ...s, labels: { beats: range(64, (k) => 0.2 + k * b), drops: [] } };
    },
  },
};

// The demo, fed to the analysis exactly as the game does (stereo 44.1 kHz, downmixed).
function demo() {
  const { left, right } = compose();
  const channels = [left, right];
  const { samples, sampleRate } = prepareSamples({ sampleRate: DEMO_SR, length: left.length, numberOfChannels: 2, getChannelData: (c) => channels[c] });
  const { bpm, start, sections } = DEMO_LAYOUT;
  const beat = 60 / bpm;
  const bars = sections.reduce((n, [, count]) => n + count, 0);
  let bar = 0;
  const parts = sections.map(([label, count]) => {
    const part = { start: start + bar * 4 * beat, label };
    bar += count;
    return part;
  });
  return {
    x: samples,
    sr: sampleRate,
    labels: {
      beats: range(bars * 4, (k) => start + k * beat),
      downbeats: range(bars, (k) => start + 4 * k * beat),
      sections: parts,
      drops: parts.filter((p) => p.label.startsWith('drop')).map((p) => p.start),
    },
  };
}
