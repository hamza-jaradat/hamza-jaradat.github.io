// Runs the music analysis (analysis/analyze.js) off the main thread. The notes come from the
// Basic Pitch model and, if asked for, the genre the music sounds like from YAMNet
// (models.js, loaded on demand); where they can't run, the analysis falls back to its own
// pitch tracking and no genre. The worker keeps the song's prepared analysis, so it can
// interpret it again under other params (another genre) in a fraction of the time.
import { interpret, prepare } from './analysis/analyze.js';

const progress = (p, stage = 'beats') => self.postMessage({ type: 'progress', p, stage });
let prep = null;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'analyze') prep = await prepareSong(msg.samples, msg.sampleRate, msg.detectGenre);
    else if (!prep) throw new Error('No song analyzed yet');
    const result = interpret(prep, msg.params, (p) => progress(0.92 + 0.08 * p));
    // Only the arrays interpret() made are handed over: the rest stay for the next run.
    self.postMessage({ type: 'done', result }, [result.onsets.buffer, result.beats.buffer, result.downbeats.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};

async function prepareSong(samples, sampleRate, detectGenre) {
  const loading = import('./models.js');
  const song = prepare(samples, sampleRate, (p) => progress(0.2 * p));
  let models = null;
  try {
    progress(0.2, 'notes');
    models = await loading;
    const t0 = performance.now();
    song.keys = await models.transcribe(samples, sampleRate, (p) => progress(0.2 + (detectGenre ? 0.55 : 0.72) * p, 'notes'));
    if (song.keys) console.info(`Notes from Basic Pitch (${song.keys.backend}) in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } catch (err) {
    console.warn('Basic Pitch could not run; using pitch tracking.', err);
  }
  if (detectGenre && models) {
    try {
      progress(0.75, 'genre');
      const t0 = performance.now();
      song.sound = await models.listen(samples, sampleRate, (p) => progress(0.75 + 0.17 * p, 'genre'));
      if (song.sound) console.info(`Genre from YAMNet in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
    } catch (err) {
      console.warn('YAMNet could not run; no genre from the sound.', err);
    }
  }
  return song;
}
