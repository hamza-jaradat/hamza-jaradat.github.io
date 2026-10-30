// osu! beatmaps as labels. Mappers time a beat grid to the millisecond (players feel
// timing errors), so a map's timing points give a song's beats and bars, and its kiai
// sections mark the song's high points. Following Osu2MIR (Liu & Donahue, ISMIR 2025),
// maps whose tempo changes come less than 5 s apart are skipped: those grids usually chase
// a drifting live tempo and need checking by hand.

const MIN_GAP = 5000; // ms between tempo changes

// The sections of a .osu file that matter here.
export function parseOsu(text) {
  const map = { general: {}, metadata: {}, timing: [], objects: [] };
  let section = '';
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const head = line.match(/^\[(.+)\]$/);
    if (head) {
      section = head[1];
    } else if (section === 'General' || section === 'Metadata') {
      const i = line.indexOf(':');
      if (i > 0) map[section.toLowerCase()][line.slice(0, i).trim()] = line.slice(i + 1).trim();
    } else if (section === 'TimingPoints') {
      // time, beatLength, meter, sampleSet, sampleIndex, volume, uninherited, effects
      const c = line.split(',').map(Number);
      if (!Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      const uninherited = c.length > 6 ? c[6] === 1 : c[1] > 0;
      map.timing.push({ time: c[0], beatLength: c[1], meter: c[2] >= 1 && c[2] <= 16 ? Math.round(c[2]) : 4, uninherited, effects: c[7] || 0 });
    } else if (section === 'HitObjects') {
      const time = Number(line.split(',')[2]);
      if (Number.isFinite(time)) map.objects.push(time);
    }
  }
  return map;
}

// Beats, bars, highlights and the span they cover (seconds), or { error } if the timing
// can't be trusted as labels.
export function osuLabels(map) {
  const red = map.timing.filter((t) => t.uninherited && t.beatLength > 0).sort((a, b) => a.time - b.time);
  if (!red.length) return { error: 'no timing' };
  for (const t of red) {
    const bpm = 60000 / t.beatLength;
    if (bpm < 40 || bpm > 400) return { error: `implausible tempo (${bpm.toFixed(0)} BPM)` };
  }
  for (let i = 1; i < red.length; i++) {
    if (red[i].time - red[i - 1].time < MIN_GAP) return { error: 'tempo changes less than 5 s apart' };
  }
  if (map.objects.length < 32) return { error: 'too few notes' };
  const lastObject = Math.max(...map.objects);
  const start = red[0].time;
  const end = lastObject + red[red.length - 1].beatLength;
  if (end - start < 20000) return { error: 'mapped stretch shorter than 20 s' };

  // Each red line starts a bar on its first beat, unless it's marked to continue the bar
  // it falls in ("omit first barline").
  const beats = [];
  const downbeats = [];
  let pos = 0;
  red.forEach((tp, i) => {
    const until = i + 1 < red.length ? red[i + 1].time : end;
    if (i === 0 || !(tp.effects & 8)) pos = 0;
    for (let k = 0; tp.time + k * tp.beatLength < until - tp.beatLength / 4; k++) {
      const t = (tp.time + k * tp.beatLength) / 1000;
      beats.push(t);
      if (pos === 0) downbeats.push(t);
      pos = (pos + 1) % tp.meter;
    }
  });

  return {
    labels: { beats, downbeats, highlights: kiai(map.timing, red, end), span: [start / 1000, end / 1000] },
    info: { bpm: 60000 / red[0].beatLength, meter: red[0].meter, tempoChanges: red.length - 1 },
  };
}

// Kiai sections (any timing point can switch kiai on or off). Short flashes are effects,
// not sections: keep stretches of four beats or more, joining those a beat or two apart.
function kiai(timing, red, end) {
  const beatAt = (t) => [...red].reverse().find((r) => r.time <= t)?.beatLength ?? red[0].beatLength;
  const spans = [];
  let on = null;
  for (const tp of [...timing].sort((a, b) => a.time - b.time)) {
    const k = (tp.effects & 1) !== 0;
    if (k && on === null) on = tp.time;
    else if (!k && on !== null) {
      spans.push([on, tp.time]);
      on = null;
    }
  }
  if (on !== null) spans.push([on, end]);
  const joined = [];
  for (const [a, b] of spans) {
    const last = joined[joined.length - 1];
    if (last && a - last[1] <= 2 * beatAt(a)) last[1] = b;
    else joined.push([a, b]);
  }
  return joined.filter(([a, b]) => b - a >= 4 * beatAt(a)).map(([a, b]) => ({ start: a / 1000, end: b / 1000 }));
}

// The difficulty to take labels from: the one that maps the most of the song.
export function pickDifficulty(maps) {
  const usable = maps.map((map) => ({ map, ...osuLabels(map) }));
  const ok = usable.filter((u) => !u.error).sort((a, b) => b.map.objects.length - a.map.objects.length);
  return ok[0] ?? usable[0];
}
