// The genre a song file is tagged with, if any: ID3 (MP3), MP4 metadata (M4A, AAC), Vorbis
// comments (FLAC, OGG, Opus) or RIFF INFO (WAV). Read from the file's bytes before they are
// decoded (decoding may take the buffer over).

// ID3v1 genre numbers (with Winamp's additions), which tags may give instead of a name.
const ID3_GENRES = (
  'Blues|Classic Rock|Country|Dance|Disco|Funk|Grunge|Hip-Hop|Jazz|Metal|New Age|Oldies|Other|Pop|R&B|Rap|' +
  'Reggae|Rock|Techno|Industrial|Alternative|Ska|Death Metal|Pranks|Soundtrack|Euro-Techno|Ambient|Trip-Hop|' +
  'Vocal|Jazz+Funk|Fusion|Trance|Classical|Instrumental|Acid|House|Game|Sound Clip|Gospel|Noise|AlternRock|' +
  'Bass|Soul|Punk|Space|Meditative|Instrumental Pop|Instrumental Rock|Ethnic|Gothic|Darkwave|' +
  'Techno-Industrial|Electronic|Pop-Folk|Eurodance|Dream|Southern Rock|Comedy|Cult|Gangsta|Top 40|' +
  'Christian Rap|Pop/Funk|Jungle|Native American|Cabaret|New Wave|Psychedelic|Rave|Showtunes|Trailer|Lo-Fi|' +
  'Tribal|Acid Punk|Acid Jazz|Polka|Retro|Musical|Rock & Roll|Hard Rock|Folk|Folk-Rock|National Folk|Swing|' +
  'Fast Fusion|Bebop|Latin|Revival|Celtic|Bluegrass|Avantgarde|Gothic Rock|Progressive Rock|' +
  'Psychedelic Rock|Symphonic Rock|Slow Rock|Big Band|Chorus|Easy Listening|Acoustic|Humour|Speech|Chanson|' +
  'Opera|Chamber Music|Sonata|Symphony|Booty Bass|Primus|Porn Groove|Satire|Slow Jam|Club|Tango|Samba|' +
  'Folklore|Ballad|Power Ballad|Rhythmic Soul|Freestyle|Duet|Punk Rock|Drum Solo|A Cappella|Euro-House|' +
  'Dance Hall|Goa|Drum & Bass|Club-House|Hardcore Techno|Terror|Indie|BritPop||Polsk Punk|Beat|' +
  'Christian Gangsta Rap|Heavy Metal|Black Metal|Crossover|Contemporary Christian|Christian Rock|Merengue|' +
  'Salsa|Thrash Metal|Anime|JPop|Synthpop|Abstract|Art Rock|Baroque|Bhangra|Big Beat|Breakbeat|Chillout|' +
  'Downtempo|Dub|EBM|Eclectic|Electro|Electroclash|Emo|Experimental|Garage|Global|IDM|Illbient|Industro-Goth|' +
  'Jam Band|Krautrock|Leftfield|Lounge|Math Rock|New Romantic|Nu-Breakz|Post-Punk|Post-Rock|Psytrance|' +
  'Shoegaze|Space Rock|Trop Rock|World Music|Neoclassical|Audiobook|Audio Theatre|Neue Deutsche Welle|' +
  'Podcast|Indie Rock|G-Funk|Dubstep|Garage Rock|Psybient'
).split('|');

export function readGenre(buffer) {
  const b = new Uint8Array(buffer);
  try {
    return clean(id3v2(b) ?? mp4(b) ?? vorbis(b) ?? riff(b) ?? id3v1(b));
  } catch {
    return null; // a damaged tag is no tag
  }
}

const ascii = (b, at, n) => String.fromCharCode(...b.subarray(at, at + n));
const be32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const le32 = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
const syncsafe = (b, at) => (b[at] << 21) | (b[at + 1] << 14) | (b[at + 2] << 7) | b[at + 3];
const decode = (bytes, encoding = 'utf-8') => new TextDecoder(encoding).decode(bytes);

// "Rock", "(17)", "17", "(17)Rock" or several values: one readable name.
function clean(text) {
  if (!text) return null;
  const names = text
    .split('\0')
    .map((s) => s.trim().replace(/^\((\d+)\)$/, '$1').replace(/^\(\d+\)/, ''))
    .map((s) => (/^\d+$/.test(s) ? ID3_GENRES[Number(s)] : s))
    .filter(Boolean);
  return names.length ? names.join(' / ') : null;
}

// ID3v2.2 to 2.4 at the start of the file: the TCON (TCO) frame.
function id3v2(b) {
  if (b.length < 10 || ascii(b, 0, 3) !== 'ID3') return null;
  const version = b[3];
  const end = Math.min(b.length, 10 + syncsafe(b, 6));
  let p = 10;
  if (b[5] & 0x40) p += version === 4 ? syncsafe(b, p) : be32(b, p) + 4; // extended header
  const idLen = version === 2 ? 3 : 4;
  const head = version === 2 ? 6 : 10;
  while (p + head <= end) {
    const id = ascii(b, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // padding
    const size = version === 2 ? (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5] : version === 4 ? syncsafe(b, p + 4) : be32(b, p + 4);
    if (id === 'TCON' || id === 'TCO') return id3Text(b.subarray(p + head, p + head + size));
    p += head + size;
  }
  return null;
}

function id3Text(body) {
  const text = body.subarray(1);
  switch (body[0]) {
    case 1:
      return decode(text, text[0] === 0xfe ? 'utf-16be' : 'utf-16le').replace(/^﻿/, '');
    case 2:
      return decode(text, 'utf-16be');
    case 3:
      return decode(text);
    default:
      return decode(text, 'iso-8859-1');
  }
}

// ID3v1: the last 128 bytes, genre as a number.
function id3v1(b) {
  if (b.length < 128 || ascii(b, b.length - 128, 3) !== 'TAG') return null;
  return ID3_GENRES[b[b.length - 1]] ?? null;
}

// MP4: moov > udta > meta > ilst > ©gen (a name) or gnre (an ID3v1 number plus one).
function mp4(b) {
  if (b.length < 12 || ascii(b, 4, 4) !== 'ftyp') return null;
  let box = { start: 0, end: b.length };
  for (const type of ['moov', 'udta', 'meta', 'ilst']) {
    box = child(b, box, type);
    if (!box) return null;
    if (type === 'meta') box.start += 4; // version and flags
  }
  const named = child(b, box, '©gen');
  const data = named && child(b, named, 'data');
  if (data) return decode(b.subarray(data.start + 8, data.end));
  const numbered = child(b, box, 'gnre');
  const num = numbered && child(b, numbered, 'data');
  return num ? (ID3_GENRES[((b[num.start + 8] << 8) | b[num.start + 9]) - 1] ?? null) : null;
}

function child(b, { start, end }, type) {
  for (let p = start; p + 8 <= end; ) {
    let size = be32(b, p);
    let head = 8;
    if (size === 1) {
      size = be32(b, p + 8) * 2 ** 32 + be32(b, p + 12);
      head = 16;
    } else if (size === 0) size = end - p;
    if (size < head) return null;
    if (ascii(b, p + 4, 4) === type) return { start: p + head, end: Math.min(end, p + size) };
    p += size;
  }
  return null;
}

// Vorbis comments (FLAC, OGG, Opus): a little-endian length, then "GENRE=...".
function vorbis(b) {
  const kind = ascii(b, 0, 4);
  if (kind !== 'fLaC' && kind !== 'OggS') return null;
  const key = [0x67, 0x65, 0x6e, 0x72, 0x65, 0x3d]; // "genre=", any case
  const end = Math.min(b.length, 1 << 20);
  for (let i = 4; i + 6 <= end; i++) {
    let k = 0;
    while (k < 6 && (b[i + k] | (k < 5 ? 0x20 : 0)) === key[k]) k++;
    if (k < 6) continue;
    const len = le32(b, i - 4);
    if (len > 6 && len < 512) return decode(b.subarray(i + 6, i + len));
  }
  return null;
}

// WAV: a LIST chunk of INFO holding IGNR.
function riff(b) {
  if (b.length < 12 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WAVE') return null;
  for (let p = 12; p + 8 <= b.length; ) {
    const size = le32(b, p + 4);
    if (ascii(b, p, 4) === 'LIST' && ascii(b, p + 8, 4) === 'INFO') {
      for (let q = p + 12; q + 8 <= Math.min(b.length, p + 8 + size); ) {
        const n = le32(b, q + 4);
        if (ascii(b, q, 4) === 'IGNR') return decode(b.subarray(q + 8, q + 8 + n), 'iso-8859-1');
        q += 8 + n + (n & 1);
      }
    }
    p += 8 + size + (size & 1);
  }
  return null;
}
