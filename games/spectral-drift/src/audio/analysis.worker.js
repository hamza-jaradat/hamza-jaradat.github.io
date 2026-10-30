// Runs the music analysis (analysis/analyze.js) off the main thread. The notes come from the
// Basic Pitch model (transcribe.js, loaded on demand); where it can't run, the analysis
// falls back to its own pitch tracking. The worker keeps the song's prepared analysis, so
// it can interpret it again under other params (another genre) in a fraction of the time.
import { interpret, prepare } from './analysis/analyze.js';

const progress = (p, stage = 'beats') => self.postMessage({ type: 'progress', p, stage });
let prep = null;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'analyze') prep = await prepareSong(msg.samples, msg.sampleRate);
    else if (!prep) throw new Error('No song analyzed yet');
    const result = interpret(prep, msg.params, (p) => progress(0.9 + 0.1 * p));
    // Only the arrays interpret() made are handed over: the rest stay for the next run.
    self.postMessage({ type: 'done', result }, [result.onsets.buffer, result.beats.buffer, result.downbeats.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};

async function prepareSong(samples, sampleRate) {
  const transcriber = import('./transcribe.js');
  const song = prepare(samples, sampleRate, (p) => progress(0.25 * p));
  try {
    const t0 = performance.now();
    progress(0.25, 'notes');
    const { transcribe } = await transcriber;
    song.keys = await transcribe(samples, sampleRate, (p) => progress(0.25 + 0.65 * p, 'notes'));
    if (song.keys) console.info(`Notes from Basic Pitch (${song.keys.backend}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } catch (err) {
    console.warn('Basic Pitch could not run; using pitch tracking.', err);
  }
  return song;
}
