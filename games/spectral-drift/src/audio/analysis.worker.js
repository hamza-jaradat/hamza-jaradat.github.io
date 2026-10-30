// Runs the music analysis (analysis/analyze.js) off the main thread. The notes come from the
// Basic Pitch model (transcribe.js, loaded on demand); where it can't run, the analysis
// falls back to its own pitch tracking.
import { interpret, prepare } from './analysis/analyze.js';

const progress = (p, stage = 'beats') => self.postMessage({ type: 'progress', p, stage });

self.onmessage = async (e) => {
  const { samples, sampleRate } = e.data;
  try {
    const transcriber = import('./transcribe.js');
    const prep = prepare(samples, sampleRate, (p) => progress(0.25 * p));
    try {
      const t0 = performance.now();
      progress(0.25, 'notes');
      const { transcribe } = await transcriber;
      prep.keys = await transcribe(samples, sampleRate, (p) => progress(0.25 + 0.65 * p, 'notes'));
      if (prep.keys) console.info(`Notes from Basic Pitch (${prep.keys.backend}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    } catch (err) {
      console.warn('Basic Pitch could not run; using pitch tracking.', err);
    }
    const result = interpret(prep, undefined, (p) => progress(0.9 + 0.1 * p));
    const transfer = ['intensity', 'low', 'mid', 'high', 'spectrum', 'onsets', 'beats', 'downbeats'].map((k) => result[k].buffer);
    self.postMessage({ type: 'done', result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
