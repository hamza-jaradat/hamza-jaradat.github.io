// Songs on disk for the benchmark: audio files with their labels next to them. Used by the
// command line (run.mjs) and by the dev server behind the label page (vite.config.js).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSamples } from '../src/audio/analyzer.js';
import { LABELS_SUFFIX, harmonixLabels, normalizeLabels } from './labels.js';

export const AUDIO = /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|webm)$/i;
const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), 'songs');

export function songsDir(dir) {
  return resolve(dir || process.env.SONGS_DIR || DEFAULT_DIR);
}

export function listSongs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => AUDIO.test(file))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => ({ file, labeled: readLabels(dir, file) !== null }));
}

// A song's labels: our JSON if there is one, else Harmonix Set annotations, else null.
export function readLabels(dir, file) {
  const json = join(dir, file + LABELS_SUFFIX);
  if (existsSync(json)) return normalizeLabels(JSON.parse(readFileSync(json, 'utf8')));
  const stem = join(dir, file.replace(AUDIO, ''));
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
  const beats = read(`${stem}.beats.txt`);
  const segments = read(`${stem}.segments.txt`);
  return beats || segments ? harmonixLabels(beats, segments) : null;
}

export function writeLabels(dir, file, labels) {
  const clean = normalizeLabels(labels);
  const round = (t) => Math.round(t * 1e4) / 1e4;
  for (const key of ['beats', 'downbeats', 'drops']) if (clean[key]) clean[key] = clean[key].map(round);
  if (clean.sections) clean.sections = clean.sections.map((s) => ({ start: round(s.start), label: s.label }));
  writeFileSync(join(dir, file + LABELS_SUFFIX), JSON.stringify(clean, null, 1) + '\n');
  return clean;
}

// Decodes any audio file with ffmpeg and prepares it the way the game does (mono, ~22 kHz).
export function decode(path) {
  return new Promise((resolveAudio, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', path, '-ac', '1', '-ar', '44100', '-f', 'f32le', 'pipe:1']);
    const chunks = [];
    let err = '';
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => (err += c));
    ff.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'ffmpeg not found: install it and make sure it is on your PATH' : e.message)));
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not decode ${path}: ${err.trim()}`));
      const bytes = Buffer.concat(chunks);
      const x = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length - (bytes.length % 4)));
      resolveAudio(prepareSamples({ sampleRate: 44100, length: x.length, numberOfChannels: 1, getChannelData: () => x }));
    });
  });
}
