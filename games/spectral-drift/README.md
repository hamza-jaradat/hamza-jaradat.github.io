# Spectral Drift

A music-driven rhythm racer built with three.js. Drop in any song and the browser
analyzes it and turns it into a neon road: fast and downhill where the music is
intense, slow and climbing where it's calm, with pickups landing exactly on the beats.
A procedurally composed demo track is built in, so it plays without any files.

## Run

This game lives in the arcade workspace. From the repository root:

```bash
npm install
npm run dev -w games/spectral-drift
```

Then open http://localhost:5173. The arcade's `npm run build` publishes it at `games/spectral-drift/`.

## Play

| Action | Input |
| --- | --- |
| Steer | Mouse / touch (absolute position), `A` `D` or `←` `→` (lane steps), gamepad stick or d-pad |
| Overdrive (2× points, magnet, smash hazards) | `Space`, right-click, gamepad `A`, or tap the meter |
| Pause | `Esc` / `P`, gamepad Start |

Collect gems to build combo (multiplier up to x8) and charge Overdrive. Glowing beams
are holds: stay in their lane until they end for extra points. Red blocks break your
combo. Each song keeps a best score per difficulty. If the beats feel early or late on
your setup, adjust **Settings → Audio offset**.

Before you start, pick the song's **genre**: Hip-hop, Rock, Electronic, Pop or Ambient.
Each plays its own way: hip-hop bounces on the drums, rock is fast and dense, electronic
dives into its drops, pop follows the vocal line, ambient is a slow, flowing road of long
holds. **Auto** goes by the genre tag in the file (MP3, M4A, FLAC, OGG, Opus or WAV), or,
when there's none to go by, by how the song sounds. The game remembers your pick for each
song.

The road moves with the drums. Every kick thumps it down under you and sends a ring of light
racing ahead. The backbeat (beats 2 and 4, where most songs put the snare) twists it one way,
then the other, and flashes its edges. Every drop sends a shockwave down it. Hip-hop moves it
hardest, Ambient hardly at all. **Settings → Road motion with the drums** tones the motion
down or turns it off; the lights still react.

## How it works

- `src/audio/analysis.worker.js` runs the analysis (`src/audio/analysis/analyze.js`) off
  the main thread. Every tunable number is in `params.js`. The stages:
  - `spectrogram.js`, `hpss.js`: a 64-band spectrogram split into harmonic (tones) and
    percussive (hits) parts by median filtering.
  - `onsets.js`: spectral flux per layer (kick, snare, hats, tones) and peak picking that
    keeps only impulsive attacks, so pads and drones don't turn into notes. Hits that land
    together merge into one, which keeps how hard its kick and its snare hit.
  - `notes.js`: the melody's notes, from Spotify's [Basic Pitch](https://github.com/spotify/basic-pitch)
    model (a small neural network that hears which piano keys sound, and when they start).
    The melody is the highest note that stands out above the bass; each onset takes its
    pitch, and each melody note its real length (holds). `src/audio/models.js` runs the
    model with TensorFlow.js, on the GPU (WebGL) or else with WebAssembly, and only after
    the rest of the analysis has started.
  - `sound.js`: the genre a song sounds like, from Google's [YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet)
    sound classifier, which hears 521 kinds of sound, music genres among them. It listens
    to four stretches of the song, and the genre most of its moments sound like wins. It
    runs only for files without a usable genre tag.
  - `pitch.js`: a chroma (harmony) per frame, and the fallback melody pitch for browsers
    that can't run the model.
  - `beats.js`: tempo, a dynamic-programming beat tracker, a steady-grid fit for
    produced music, and bar lines (downbeats) from chord changes, kicks and backbeats.
  - `structure.js`: sections from a bar self-similarity matrix (repeats share a letter),
    with drops, build-ups and breakdowns.
- `src/game/genres.js`: what each genre expects of the music (its usual tempo) and how
  its chart and road play; `src/audio/tags.js` reads a file's genre tag for Auto (else
  `sound.js` listens). The analysis worker keeps the song, so switching genre redoes only
  the fast half of the analysis.
- `src/game/Chart.js`: notes snap to the beat grid; easier difficulties keep the
  strongest notes on the strongest beats; lanes follow the melody's pitch (or sway with
  the beat); repeated bars repeat their pattern; long tones become holds; every drop
  lands on a power note. Every move is within what a player can reach.
- `src/game/Track.js`: intensity becomes speed, slope, bends and banking, sampled 60×/s;
  build-ups climb towards their drop, which dives and surges.
- `src/render/RoadPulse.js`: the road's reaction to the drums (kicks, backbeats and drops),
  as a height offset along and across the road. The road's shaders apply it, and the ship,
  gems and camera follow it the same way, so everything on the road moves together and the
  chart is unchanged.
- `src/game/Session.js`: steering, hit windows, holds, scoring and overdrive, plus the
  beat pulse and the drop and build-up cues.
- `src/render/`: chunked road with spectrum towers and arches, instanced gems, ship and
  trails, sky with a spectrum-ringed sun, particles, bloom.
- `src/audio/demoSong.synth.js`: a small software synth that composes the demo track.

## Measuring and tuning the analysis

`bench/` scores the analysis against songs whose beats, bars, sections and drops are
known, and can tune `params.js` to score better. It is a development tool; none of it
ships with the game.

### Score it

```bash
npm run bench -w games/spectral-drift
```

This analyzes every labeled song and prints one score per song and task, plus means:

| Score | Measures |
| --- | --- |
| Beats | Beats found within 70 ms of a labeled beat (F-measure) |
| Beats (any) | The same, if the beats were on the off-beat or at double or half tempo: tells a tempo or phase mistake from being lost |
| Bars | Downbeats (first beat of each bar) within 70 ms |
| Sections | Section boundaries within 3 s (and, for "tight", 0.5 s) |
| Drops | Drops within 0.5 s, including no false ones |
| Notes | Melody notes found as tonal onsets, within 50 ms |
| Pitch | Melody notes found at the right pitch |
| Holds | Notes of 0.45 s or more found with about their length |
| Genre | Whether the song's sound says its labeled genre (songs labeled with one) |
| Overall | A weighted mean of the above (beats count most) |

Six built-in songs always run: the demo, whose layout and notes the synth knows exactly,
and synthetic tracks that each catch one mistake (a steady groove, beat-less pads, a tempo
ramp, pads before the drums come in, a held melody). They show regressions, but they are
not real music: add your own songs for scores that mean something.

The Basic Pitch model runs on every song too (about a tenth of the song's length, then
cached in `bench/.cache/`). `--no-notes` leaves it out, to score the fallback.

After a change to the analysis or the charts, check that every chart is still playable:

```bash
npm run bench:play -w games/spectral-drift
```

A bot plays every genre and difficulty of the built-in songs; it should collect every
note, hit no hazard and finish every hold.

A song's labels can name its genre (`"genre": "rock"`): it is then analyzed as the game
would analyze that genre, the benchmark checks that YAMNet hears that genre in it (the
Genre score, also cached), and it adds a mean per genre, which shows the genres the
analysis handles worst.

### Label your own songs

1. Put audio files (MP3, WAV, FLAC, OGG, M4A…) in `bench/songs/` (it stays out of git),
   or point `SONGS_DIR` at another folder.
2. Run `npm run dev -w games/spectral-drift` and open
   http://localhost:5173/bench/label.html.
3. Pick a song, copy the analysis into your labels, then fix what it got wrong while
   listening with clicks on your beats: shift or re-phase the beats, set where bars start,
   mark sections and drops. Save writes `<song file>.labels.json` next to the audio.

The page shows the analysis's scores against your labels as you go. Labels from the
[Harmonix Set](https://github.com/urinieto/harmonixset) (`<song>.beats.txt`,
`<song>.segments.txt`, named like the audio file) are read too. Decoding your songs for
`npm run bench` needs [ffmpeg](https://ffmpeg.org/) on your PATH.

### Import osu! beatmaps

osu! mappers time every song's beat grid to the millisecond, and each beatmap ships with
its song, so beatmaps are ready-made labels
([Osu2MIR](https://arxiv.org/abs/2509.12667) studies them as a beat dataset):

```bash
npm run bench:osu -w games/spectral-drift -- "C:\path\to\beatmaps"
```

The source can be one `.osz` file, a folder of them, or an osu! `Songs` folder. Each map's
song is copied into the songs folder with labels for its beats, bars (from its timing
points) and highlights (its kiai sections, usually choruses and drops), covering the
stretch the map plays. Maps whose tempo changes come less than 5 s apart are skipped:
their grids chase a drifting live tempo and need checking by hand. Options:
`--songs <dir>`, `--genre <name>` (label them all with a genre, e.g. a folder of rock
maps), `--limit <n>`, `--force`.

Kiai marks a song's high points, not all its sections, so it is scored as "Highlights"
(how many of them start at a section boundary or drop the analysis found), and drops still
need labeling by ear. If the benchmark reports that the beats of imported songs sit early
or late by the same amount, the offset comes from MP3 decoding, not from the analysis. Most
songs on osu! are copyrighted: keep them in the songs folder, which stays out of git.

### Tune it

```bash
npm run bench -w games/spectral-drift -- --tune 300
```

The tuner nudges a few params at a time and keeps any change that scores better. A third
of the songs are held out: if their score doesn't rise along with the rest, the change
only fits those songs. The best params are written to `bench/tuned-params.json`; check
them with `--params bench/tuned-params.json`, then copy the ones you trust into
`params.js`. Other options: `--only <names>`, `--no-builtin`, `--songs <dir>`, `--json`.

## Credits

The melody comes from [Basic Pitch](https://github.com/spotify/basic-pitch) by Spotify
(Apache License 2.0). Its model is in `src/audio/analysis/basic-pitch/` with its license, and
`src/audio/analysis/notes.js` follows its note tracking.

The genre a song sounds like comes from [YAMNet](https://github.com/tensorflow/models/tree/master/research/audioset/yamnet)
by Google (Apache License 2.0), from its [TensorFlow.js release](https://www.kaggle.com/models/google/yamnet).
Its model is in `src/audio/analysis/yamnet/` with its license; the weights of its larger
layers are stored as 8-bit values there, which keeps it to 4.4 MB.
