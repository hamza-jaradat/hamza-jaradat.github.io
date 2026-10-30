// Plays every chart of the built-in songs with a bot, to check charts stay playable after a
// change to the analysis or to Chart.js:
//
//   npm run bench:play -w games/spectral-drift            (add -- --no-notes for the fallback)
//
// The bot steers to the next note, stays in a hold's lane until it ends, and dodges
// hazards. Every chart should come out with every note collected, no hazard hit and every
// hold finished; "BAD" marks one that doesn't.
import { interpret, prepare } from '../src/audio/analysis/analyze.js';
import { ONSET_FIELDS } from '../src/audio/analysis/onsets.js';
import { DIFFICULTIES, KIND, LANES, STATE, laneX } from '../src/config.js';
import { buildChart } from '../src/game/Chart.js';
import { Session } from '../src/game/Session.js';
import { BUILT_IN } from './suite.js';
import { keysFor } from './transcribe.js';

const noNotes = process.argv.includes('--no-notes');
const noop = () => {};
const stubs = {
  world: { postfx: { hit: noop }, rig: { addShake: noop, punch: noop }, burst: noop, ship: { pulse: noop }, resetDynamics: noop, drop: noop },
  audio: { overdrive: noop, smash: noop, hit: noop, power: noop, pickup: noop, holdDone: noop },
  hud: { toast: noop, hit: noop, overdriveReady: noop },
  track: { intensityAt: () => 0.5 },
};

let bad = 0;
for (const [name, song] of Object.entries(BUILT_IN)) {
  const { x, sr } = song.make();
  const prep = prepare(x, sr);
  if (!noNotes) prep.keys = await keysFor(x, sr);
  const features = unpack(interpret(prep), x.length / sr);
  console.log(`${name}: ${features.onsets.length} onsets`);
  for (const diff of Object.values(DIFFICULTIES)) {
    const chart = buildChart(features, diff, 99);
    const r = play(features, chart);
    const ok = r.collected === chart.notesTotal && r.hits === 0 && r.holdsDone === chart.holdsTotal;
    if (!ok) bad++;
    console.log(`  ${diff.id.padEnd(8)} ${ok ? 'ok ' : 'BAD'} ${r.collected}/${chart.notesTotal} notes, ${r.hits} hazards hit, ${r.holdsDone}/${chart.holdsTotal} holds, ${(chart.notesTotal / features.duration).toFixed(2)} notes/s`);
  }
}
console.log(bad ? `\n${bad} chart${bad === 1 ? '' : 's'} not playable.` : '\nEvery chart is playable.');
process.exitCode = bad ? 1 : 0;

// The worker's packed onsets as the game unpacks them (src/audio/analyzer.js).
function unpack(result, duration) {
  const onsets = [];
  for (let i = 0; i < result.onsets.length; i += ONSET_FIELDS) {
    const [t, s, b, pitch, sustain] = result.onsets.subarray(i, i + ONSET_FIELDS);
    onsets.push({ t, s, b, pitch, sustain });
  }
  return { ...result, onsets, duration };
}

function play(features, chart) {
  const input = { targetX: 0, mode: 'mouse', reset: noop, shipX: 0 };
  const session = new Session({ features, chart, input, ...stubs });
  const notes = chart.objects.filter((o) => o.kind !== KIND.HAZARD);
  const hazards = chart.objects.filter((o) => o.kind === KIND.HAZARD);
  for (let t = -3.5; t < features.duration + 1.5; t += 1 / 60) {
    let target;
    if (session.holds[0]) target = session.holds[0].lane;
    else {
      const next = notes.find((n) => n.state === STATE.PENDING && n.t >= t - 0.04);
      target = next ? next.lane : 2;
      const until = next ? next.t : t + 0.5;
      const blocking = hazards.filter((h) => h.state === STATE.PENDING && h.t >= t && h.t <= Math.min(until - 0.02, t + 0.3));
      if (blocking.some((h) => h.lane === target)) {
        const free = [target - 1, target + 1, target - 2, target + 2].filter((l) => l >= 0 && l < LANES && !blocking.some((h) => h.lane === l));
        target = free[0] ?? target;
      }
    }
    input.targetX = laneX(target);
    session.update(t, 1 / 60);
  }
  return session.score;
}
