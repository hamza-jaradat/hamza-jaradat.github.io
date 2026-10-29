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

## How it works

- `src/audio/analysis.worker.js` runs the analysis stages in `src/audio/analysis/`:
  - `spectrogram.js`, `hpss.js`: a 64-band spectrogram split into harmonic (tones) and
    percussive (hits) parts by median filtering.
  - `onsets.js`: spectral flux per layer (kick, snare, hats, tones) and peak picking that
    keeps only impulsive attacks, so pads and drones don't turn into notes.
  - `pitch.js`: the melody's pitch and a chroma (harmony) per frame; with it, each note's
    pitch and how long it rings.
  - `beats.js`: tempo, a dynamic-programming beat tracker, a steady-grid fit for
    produced music, and bar lines (downbeats) from chord changes, kicks and backbeats.
  - `structure.js`: sections from a bar self-similarity matrix (repeats share a letter),
    with drops, build-ups and breakdowns.
- `src/game/Chart.js`: notes snap to the beat grid; easier difficulties keep the
  strongest notes on the strongest beats; lanes follow the melody's pitch (or sway with
  the beat); repeated bars repeat their pattern; long tones become holds; every drop
  lands on a power note. Every move is within what a player can reach.
- `src/game/Track.js`: intensity becomes speed, slope, bends and banking, sampled 60×/s;
  build-ups climb towards their drop, which dives and surges.
- `src/game/Session.js`: steering, hit windows, holds, scoring and overdrive, plus the
  beat pulse and the drop and build-up cues.
- `src/render/`: chunked road with spectrum towers and arches, instanced gems, ship and
  trails, sky with a spectrum-ringed sun, particles, bloom.
- `src/audio/demoSong.worker.js`: a small software synth that composes the demo track.
