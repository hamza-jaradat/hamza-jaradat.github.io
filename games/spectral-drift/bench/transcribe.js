// The Basic Pitch model's activations for the benchmark's songs (see
// src/audio/analysis/notes.js), run with TensorFlow.js's WebAssembly backend. They take about
// a tenth of a song's length to compute and change only with the audio, so they are cached
// in bench/.cache (out of git), keyed by the audio itself.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTE_SR, keyActivations, loadModel, resample } from '../src/audio/analysis/notes.js';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL = join(HERE, '../src/audio/analysis/basic-pitch');
const CACHE = join(HERE, '.cache');
const KEYS = 88;

let model = null;
let tf = null;

export async function keysFor(x, sr) {
  const audio = resample(x, sr);
  const file = join(CACHE, `${fingerprint(audio)}.keys`);
  if (existsSync(file)) return readKeys(readFileSync(file));
  if (!model) {
    tf = require('@tensorflow/tfjs-core');
    require('@tensorflow/tfjs-backend-wasm');
    const { loadGraphModel } = require('@tensorflow/tfjs-converter');
    await tf.setBackend('wasm');
    const bin = readFileSync(join(MODEL, 'group1-shard1of1.bin'));
    const json = JSON.parse(readFileSync(join(MODEL, 'model.json'), 'utf8'));
    model = await loadModel(loadGraphModel, json, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length));
  }
  const keys = await keyActivations(tf, model, audio);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, writeKeys(keys));
  return keys;
}

// FNV-1a over every 7th sample's bits, the length and the rate.
function fingerprint(x) {
  const bits = new Uint32Array(x.buffer, x.byteOffset, x.length);
  let h = 2166136261 ^ x.length;
  for (let i = 0; i < bits.length; i += 7) h = Math.imul(h ^ bits[i], 16777619);
  return `${(h >>> 0).toString(16)}-${x.length}-${NOTE_SR}`;
}

// Activations stored as 16-bit fractions: [n, frames..., onsets...].
function writeKeys({ frames, onsets, n }) {
  const out = new Uint16Array(2 + 2 * n * KEYS);
  out[0] = n & 0xffff;
  out[1] = n >>> 16;
  for (let i = 0; i < n * KEYS; i++) {
    out[2 + i] = Math.round(frames[i] * 65535);
    out[2 + n * KEYS + i] = Math.round(onsets[i] * 65535);
  }
  return Buffer.from(out.buffer);
}

function readKeys(buf) {
  const data = new Uint16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  const n = data[0] + data[1] * 65536;
  const frames = new Float32Array(n * KEYS);
  const onsets = new Float32Array(n * KEYS);
  for (let i = 0; i < n * KEYS; i++) {
    frames[i] = data[2 + i] / 65535;
    onsets[i] = data[2 + n * KEYS + i] / 65535;
  }
  return { frames, onsets, n };
}
