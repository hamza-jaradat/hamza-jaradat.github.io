// Main-thread side of the analysis: downmix, decimate, and hand off to a worker.
import { ONSET_FIELDS } from './analysis/onsets.js';

// A song's analysis, kept in its worker so it can be redone under other params (another
// genre) in a fraction of the time. openAnalysis() runs the first one.
export class SongAnalysis {
  constructor(duration) {
    this.duration = duration;
    this.features = null;
    this.worker = new Worker(new URL('./analysis.worker.js', import.meta.url), { type: 'module' });
    this.queue = Promise.resolve();
  }

  // The features under other params (overrides of analysis/params.js).
  interpret(params) {
    return this.request({ type: 'interpret', params });
  }

  dispose() {
    this.worker.terminate();
    this.fail?.(new Error('The analysis was closed'));
  }

  // One request at a time, resolving with the unpacked features.
  request(message, transfer = [], onProgress) {
    const run = () =>
      new Promise((resolve, reject) => {
        this.fail = reject;
        this.worker.onmessage = (e) => {
          const msg = e.data;
          if (msg.type === 'progress') onProgress?.(msg.p, msg.stage);
          else if (msg.type === 'done') resolve(unpack(msg.result, this.duration));
          else if (msg.type === 'error') reject(new Error(msg.message));
        };
        this.worker.onerror = (e) => reject(new Error(e.message || 'Analysis worker failed'));
        this.worker.postMessage(message, transfer);
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
}

// The first analysis of a song; with detectGenre, its features say the genre it sounds like
// (`sound`).
export async function openAnalysis(audioBuffer, params, onProgress, { detectGenre = false } = {}) {
  const analysis = new SongAnalysis(audioBuffer.duration);
  const { samples, sampleRate } = prepareSamples(audioBuffer);
  try {
    analysis.features = await analysis.request({ type: 'analyze', samples, sampleRate, params, detectGenre }, [samples.buffer], onProgress);
  } catch (err) {
    analysis.dispose();
    throw err;
  }
  return analysis;
}

// A one-off analysis (the label page): the features, and the worker let go.
export async function analyzeBuffer(audioBuffer, onProgress, params) {
  const analysis = await openAnalysis(audioBuffer, params, onProgress);
  analysis.dispose();
  return analysis.features;
}

// Mono mix at roughly 22 kHz is plenty for onset and loudness analysis. Takes an
// AudioBuffer, or anything shaped like one (the benchmark passes plain arrays).
export function prepareSamples(buffer) {
  const factor = Math.max(1, Math.round(buffer.sampleRate / 22050));
  const len = Math.floor(buffer.length / factor);
  const out = new Float32Array(len);
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const scale = 1 / (channels.length * factor);
  for (let i = 0; i < len; i++) {
    const base = i * factor;
    let s = 0;
    for (const ch of channels) for (let j = 0; j < factor; j++) s += ch[base + j];
    out[i] = s * scale;
  }
  return { samples: out, sampleRate: buffer.sampleRate / factor };
}

function unpack(r, duration) {
  const onsets = [];
  const n = ONSET_FIELDS;
  for (let i = 0; i < r.onsets.length; i += n) {
    const [t, s, b, pitch, sustain, kick, snare] = r.onsets.subarray(i, i + n);
    onsets.push({ t, s, b, pitch, sustain, kick, snare });
  }
  return { ...r, onsets, duration };
}
