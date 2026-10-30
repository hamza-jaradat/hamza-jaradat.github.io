// Imports osu! beatmaps as labeled benchmark songs: each map's song, with the beats and
// bars its mappers timed and its kiai highlights, copied into the songs folder.
//
//   npm run bench:osu -w games/spectral-drift -- <source> [options]
//
// The source can be one .osz file, a folder of .osz files, an osu! Songs folder (one
// folder per beatmap set), or one extracted set. Options:
//   --songs <dir>   where to put them (default bench/songs, or $SONGS_DIR)
//   --limit <n>     stop after importing n songs
//   --force         import again songs that are already there
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { hashString } from '../src/util.js';
import { LABELS_SUFFIX } from './labels.js';
import { parseOsu, pickDifficulty } from './osu.js';
import { AUDIO, songsDir, writeLabels } from './songs.js';
import { unzip } from './zip.js';

const args = parseArgs(process.argv.slice(2));
if (!args._.length) {
  console.error('Usage: npm run bench:osu -w games/spectral-drift -- <.osz file, folder of .osz files, or osu! Songs folder> [--songs <dir>] [--limit <n>] [--force]');
  process.exit(1);
}
const out = songsDir(args.songs);
mkdirSync(out, { recursive: true });
const limit = Number(args.limit) || Infinity;
let imported = 0;
const skipped = new Map();

for (const source of sources(resolve(args._[0]))) {
  if (imported >= limit) break;
  let result;
  try {
    result = importSet(source);
  } catch (err) {
    result = { skip: err.message };
  }
  if (result.skip) {
    if (!skipped.has(result.skip)) skipped.set(result.skip, []);
    skipped.get(result.skip).push(source.label);
  } else {
    imported++;
    const { bpm, meter, tempoChanges } = result.info;
    const highlights = result.labels.highlights.length;
    console.log(`  + ${result.name}  ${bpm.toFixed(0)} BPM, ${meter}/4${tempoChanges ? `, ${tempoChanges} tempo change${tempoChanges === 1 ? '' : 's'}` : ''}, ${highlights} highlight${highlights === 1 ? '' : 's'}`);
  }
}

console.log(`\nImported ${imported} song${imported === 1 ? '' : 's'} into ${out}`);
for (const [reason, labels] of skipped) {
  console.log(`Skipped ${labels.length} (${reason}): ${labels.slice(0, 3).join(', ')}${labels.length > 3 ? ', …' : ''}`);
}
if (imported) console.log('\nScore them: npm run bench -w games/spectral-drift');

function importSet(source) {
  const files = source.files;
  const maps = files.filter((f) => /\.osu$/i.test(f.name)).map((f) => parseOsu(f.read().toString('utf8')));
  if (!maps.length) return { skip: 'no .osu files' };
  const best = pickDifficulty(maps);
  if (best.error) return { skip: best.error };
  const { map, labels, info } = best;
  const wanted = (map.general.AudioFilename ?? '').toLowerCase();
  // The map names its audio file; if the name got mangled in the archive, take the biggest
  // MP3, OGG or WAV (never a background video).
  const audio =
    files.find((f) => basename(f.name).toLowerCase() === wanted && AUDIO.test(f.name)) ??
    files.filter((f) => /\.(mp3|ogg|wav)$/i.test(f.name)).sort((a, b) => b.size - a.size)[0];
  if (!audio) return { skip: 'no audio file' };

  const meta = map.metadata;
  const setId = meta.BeatmapSetID && meta.BeatmapSetID !== '-1' ? meta.BeatmapSetID : hashString(source.label).toString(36);
  const name = safeName(`${meta.Artist || 'Unknown artist'} - ${meta.Title || source.label} (osu ${setId})`) + extname(audio.name).toLowerCase();
  if (!args.force && existsSync(join(out, name)) && existsSync(join(out, name + LABELS_SUFFIX))) return { skip: 'already imported' };
  writeFileSync(join(out, name), audio.read());
  writeLabels(out, name, { ...labels, source: `osu! beatmap set ${setId}, "${meta.Version ?? '?'}" by ${meta.Creator ?? '?'}` });
  return { name, labels, info };
}

// Beatmap sets under a path: .osz archives, or folders holding .osu files.
function* sources(path) {
  if (!existsSync(path)) throw new Error(`${path} doesn't exist`);
  const hasMaps = (dir) => readdirSync(dir).some((f) => /\.osu$/i.test(f));
  if (statSync(path).isFile()) {
    if (/\.osz$/i.test(path)) yield archive(path);
    return;
  }
  if (hasMaps(path)) {
    yield folder(path);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const p = join(path, entry.name);
    if (entry.isFile() && /\.osz$/i.test(entry.name)) yield archive(p);
    else if (entry.isDirectory() && hasMaps(p)) yield folder(p);
  }
}

function archive(path) {
  return { label: basename(path), get files() { return unzip(readFileSync(path)); } };
}

function folder(path) {
  return {
    label: basename(path),
    get files() {
      return readdirSync(path, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => ({ name: e.name, size: statSync(join(path, e.name)).size, read: () => readFileSync(join(path, e.name)) }));
    },
  };
}

// A file name Windows, macOS and Linux all accept.
function safeName(text) {
  return text
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)
    .replace(/[. ]+$/, '');
}

function parseArgs(list) {
  const parsed = { _: [] };
  for (let i = 0; i < list.length; i++) {
    if (!list[i].startsWith('--')) parsed._.push(list[i]);
    else if (list[i + 1] !== undefined && !list[i + 1].startsWith('--')) parsed[list[i].slice(2)] = list[++i];
    else parsed[list[i].slice(2)] = true;
  }
  return parsed;
}
