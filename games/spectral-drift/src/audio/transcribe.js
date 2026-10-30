// Runs the Basic Pitch model (analysis/notes.js) in the analysis worker with TensorFlow.js:
// on the GPU through WebGL where the browser offers it to workers, else with WebAssembly.
// The worker loads this on demand, so TensorFlow.js downloads while the rest of the
// analysis runs.
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgl';
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import { loadGraphModel } from '@tensorflow/tfjs-converter';
import wasmPlain from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm.wasm?url';
import wasmSimd from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-simd.wasm?url';
import wasmThreads from '@tensorflow/tfjs-backend-wasm/dist/tfjs-backend-wasm-threaded-simd.wasm?url';
import weightsUrl from './analysis/basic-pitch/group1-shard1of1.bin?url';
import modelJson from './analysis/basic-pitch/model.json';
import { NOTE_SR, keyActivations, loadModel, resample } from './analysis/notes.js';

setWasmPaths({
  'tfjs-backend-wasm.wasm': wasmPlain,
  'tfjs-backend-wasm-simd.wasm': wasmSimd,
  'tfjs-backend-wasm-threaded-simd.wasm': wasmThreads,
});

// The model's activations for mono audio at any sample rate, or null if no backend here
// runs it right. Windows go through one at a time: batches overflow GPU textures.
export async function transcribe(x, sr, progress) {
  const weights = await (await fetch(weightsUrl)).arrayBuffer();
  for (const backend of ['webgl', 'wasm']) {
    if (!(await use(backend))) continue;
    const model = await loadModel(loadGraphModel, modelJson, weights);
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
