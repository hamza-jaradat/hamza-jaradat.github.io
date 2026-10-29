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

Collect gems to build combo (multiplier up to x8) and charge Overdrive. Red blocks
break your combo. Each song keeps a best score per difficulty. If the beats feel
early or late on your setup, adjust **Settings → Audio offset**.

## How it works

- `src/audio/analysis.worker.js`: FFT spectral flux per band (low/mid/high) for onsets,
  loudness + onset density for an equalized intensity curve, autocorrelation tempo,
  and a 32-band spectrogram that drives the visuals in sync with the song clock.
- `src/game/Track.js`: intensity becomes speed, slope, bends and banking, sampled 60×/s.
- `src/game/Chart.js`: onsets become gems and hazard gates, limited to lane jumps a
  player can actually make, with density set by difficulty.
- `src/game/Session.js`: steering, hit windows, scoring and overdrive.
- `src/render/`: chunked road with spectrum towers and arches, instanced gems, ship and
  trails, sky with a spectrum-ringed sun, particles, bloom.
- `src/audio/demoSong.worker.js`: a small software synth that composes the demo track.
