// Menu background: an autopiloted ride along a synthetic road.
import { clamp } from '../util.js';
import { Track } from './Track.js';

export class Attract {
  constructor(world) {
    this.world = world;
    this.features = makeFeatures();
    this.track = new Track(this.features, { speedMul: 0.85, seed: 7 });
    this.spectrum = new Uint8Array(32);
    this.t = 2;
    this.x = 0;
  }

  activate() {
    this.world.setTrack(this.track, this.features, null, 7);
    this.t = 2;
  }

  update(dt) {
    this.t += dt;
    if (this.t > this.features.duration - 2) {
      this.t = 2;
      this.world.resetDynamics();
    }
    const t = this.t;
    const x = Math.sin(t * 0.7) * 2.2 + Math.sin(t * 1.9) * 0.6;
    const vx = dt > 0 ? (x - this.x) / dt : 0;
    this.x = x;
    const phase = (t % 0.5) / 0.5;
    const beat = Math.exp(-phase * 6);
    for (let b = 0; b < 32; b++) {
      const v = 0.45 + 0.3 * Math.sin(t * 2.3 + b * 0.45) + 0.25 * Math.sin(t * 5.1 - b * 0.9) * beat;
      this.spectrum[b] = clamp(v, 0, 1) * 255;
    }
    this.world.update(
      {
        t,
        shipX: x,
        shipVX: vx,
        beat: beat * 0.6,
        kick: 0,
        intensity: this.track.intensityAt(t),
        overdrive: 0,
        invuln: 0,
        magnet: 0,
        spectrum: this.spectrum,
      },
      dt,
    );
  }
}

function makeFeatures() {
  const duration = 240;
  const frameRate = 20;
  const intensity = new Float32Array(duration * frameRate);
  for (let i = 0; i < intensity.length; i++) {
    const t = i / frameRate;
    intensity[i] = clamp(0.45 + 0.3 * Math.sin(t * 0.21) + 0.15 * Math.sin(t * 0.53 + 1), 0, 1);
  }
  const onsets = [];
  for (let t = 1; t < duration; t += 0.5) onsets.push({ t, s: 0.8, b: 1 });
  return { duration, frameRate, intensity, onsets, bpm: 120, beatOffset: 0 };
}
