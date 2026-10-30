// Runs the music analysis (analysis/analyze.js) off the main thread.
import { analyze } from './analysis/analyze.js';

self.onmessage = (e) => {
  const { samples, sampleRate } = e.data;
  try {
    const result = analyze(samples, sampleRate, (p) => self.postMessage({ type: 'progress', p }));
    const transfer = ['intensity', 'low', 'mid', 'high', 'spectrum', 'onsets', 'beats', 'downbeats'].map((k) => result[k].buffer);
    self.postMessage({ type: 'done', result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
