// Runs the analysis's two neural networks in its worker with TensorFlow.js: Basic Pitch for
// the notes (analysis/notes.js) and YAMNet for what the music sounds like (analysis/sound.js).
// They run on the GPU through WebGL where the browser offers it to workers, else with
// WebAssembly. The worker loads this on demand, so TensorFlow.js downloads while the rest of
// the analysis runs.
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import { loadGraphModel } from '@tensorflow/tfjs-converter';
import wasmPlain from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url';
import wasmSimd from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url';
import wasmThreads from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url';
import pitchWeightsUrl from './analysis/basic-pitch/group1-shard1of1.bin?url';
import pitchJson from './analysis/basic-pitch/model.json';
import { NOTE_SR, keyActivations, loadModel, resample } from './analysis/notes.js';
import { soundScores } from './analysis/sound.js';
import soundWeightsUrl from './analysis/yamnet/group1-shard1of1.bin?url';
import soundJson from './analysis/yamnet/model.json';

setWasmPaths({
  'tfjs-backend-wasm.wasm': wasmPlain,
  'tfjs-backend-wasm-simd.wasm': wasmSimd,
  'tfjs-backend-wasm-threaded-simd.wasm': wasmThreads,
});

const load = async (json, url) => loadModel(loadGraphModel, json, await (await fetch(url)).arrayBuffer());

// Basic Pitch's activations for mono audio at any sample rate, or null if no backend here
// runs it right. Windows go through one at a time: batches overflow GPU textures.
export async function transcribe(x, sr, progress) {
  for (const backend of ['webgl', 'wasm']) {
    if (!(await use(backend))) continue;
    const model = await load(pitchJson, pitchWeightsUrl);
    try {
      if (!(await hearsA4(model))) continue;
      const keys = await keyActivations(tf, model, resample(x, sr), progress, 1);
      return { ...keys, backend };
    } finally {
      model.dispose();
    }
  }
  return null;
}

// YAMNet's genre scores over the song (see sound.js), on the backend Basic Pitch settled on.
export async function listen(x, sr, progress) {
  if (!tf.getBackend() && !(await use('webgl')) && !(await use('wasm'))) return null;
  const model = await load(soundJson, soundWeightsUrl);
  try {
    return await soundScores(tf, model, x, sr, progress);
  } finally {
    model.dispose();
  }
}

async function use(backend) {
  try {
    return await tf.setBackend(backend);
  } catch {
    return false; // not available in this browser
  }
}

// A backend can run the model and still get it wrong (some GPUs only do half floats): it
// must hear a 440 Hz tone as an A4 (MIDI 69, key 48).
async function hearsA4(model) {
  const x = new Float32Array(NOTE_SR);
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / NOTE_SR);
  const { frames, n } = await keyActivations(tf, model, x, undefined, 1);
  let peak = 0;
  for (let f = 0; f < n; f++) peak = Math.max(peak, frames[f * 88 + 48]);
  return peak > 0.5;
}
