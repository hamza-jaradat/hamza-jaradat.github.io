// The neural networks' output for the benchmark's songs: Basic Pitch's activations (see
// src/audio/analysis/notes.js) and YAMNet's genre scores (sound.js), run with TensorFlow.js's
// WebAssembly backend. They take a while to compute and change only with the audio, so
// they are cached in bench/.cache (out of git), keyed by the audio itself.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTE_SR, keyActivations, loadModel, resample } from '../src/audio/analysis/notes.js';
import { soundScores } from '../src/audio/analysis/sound.js';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS = join(HERE, '../src/audio/analysis');
const CACHE = join(HERE, '.cache');
const KEYS = 88;

let tf = null;
const models = {};

async function model(name) {
  if (!tf) {
    tf = require('@tensorflow/tfjs-core');
    require('@tensorflow/tfjs-backend-wasm');
    await tf.setBackend('wasm');
  }
  if (!models[name]) {
    const { loadGraphModel } = require('@tensorflow/tfjs-converter');
    const bin = readFileSync(join(MODELS, name, 'group1-shard1of1.bin'));
    const json = JSON.parse(readFileSync(join(MODELS, name, 'model.json'), 'utf8'));
    models[name] = await loadModel(loadGraphModel, json, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length));
  }
  return models[name];
}

export async function keysFor(x, sr) {
  const audio = resample(x, sr);
  const file = join(CACHE, `${fingerprint(audio, NOTE_SR)}.keys`);
  if (existsSync(file)) return readKeys(readFileSync(file));
  const basicPitch = await model('basic-pitch');
  const keys = await keyActivations(tf, basicPitch, audio);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, writeKeys(keys));
  return keys;
}

export async function soundFor(x, sr) {
  const file = join(CACHE, `${fingerprint(x, sr)}.sound`);
  if (existsSync(file)) {
    const buf = readFileSync(file);
    const scores = new Float32Array(buf.buffer.slice(buf.byteOffset + 4, buf.byteOffset + buf.length));
    return { scores, n: buf.readUInt32LE(0) };
  }
  const yamnet = await model('yamnet');
  const sound = await soundScores(tf, yamnet, x, sr);
  mkdirSync(CACHE, { recursive: true });
  const head = Buffer.alloc(4);
  head.writeUInt32LE(sound.n);
  writeFileSync(file, Buffer.concat([head, Buffer.from(sound.scores.buffer, sound.scores.byteOffset, sound.scores.byteLength)]));
  return sound;
}

// FNV-1a over every 7th sample's bits, the length and the rate.
function fingerprint(x, sr) {
  const bits = new Uint32Array(x.buffer, x.byteOffset, x.length);
  let h = 2166136261 ^ x.length;
  for (let i = 0; i < bits.length; i += 7) h = Math.imul(h ^ bits[i], 16777619);
  return `${(h >>> 0).toString(16)}-${x.length}-${sr}`;
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
