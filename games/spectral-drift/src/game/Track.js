// Turns a song's intensity curve into a 3D road: fast and downhill when the
// music is intense, slow and climbing when it is calm, with gentle bends and
// banking. Sampled TRACK_RATE times per second of song time.
import { LEAD_IN, TAIL, TRACK_RATE } from '../config.js';
import { clamp, movingAverage, mulberry32, sampleArray, smoothstep } from '../util.js';

const V_MIN = 30;
const V_MAX = 78;
const TAU = Math.PI * 2;

export class Track {
  constructor(features, { speedMul = 1, seed = 1 } = {}) {
    const { duration, frameRate, intensity } = features;
    const beat = 60 / (features.bpm || 120);
    this.duration = duration;
    this.tStart = -(LEAD_IN + 3);
    this.tEnd = duration + TAIL;
    this.rate = TRACK_RATE;
    const n = (this.count = Math.ceil((this.tEnd - this.tStart) * this.rate) + 1);
    const dt = 1 / this.rate;
    const rng = mulberry32(seed);

    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = this.tStart + i * dt;
      raw[i] = t < 0 || t > duration ? 0.1 : sampleArray(intensity, t * frameRate);
    }
    this.intensity = movingAverage(raw, Math.round(0.25 * this.rate));
    const iSpeed = movingAverage(raw, Math.round(1.0 * this.rate));
    const iSlope = movingAverage(raw, Math.round(1.8 * this.rate));

    const speed = (this.speed = new Float32Array(n));
    const pitch = new Float32Array(n);
    const yawRate = new Float32Array(n);
    const ph = [rng(), rng(), rng(), rng()].map((v) => v * TAU);
    const turnSign = rng() < 0.5 ? -1 : 1;
    for (let i = 0; i < n; i++) {
      const t = this.tStart + i * dt;
      const inSong = smoothstep(-1.5, 1.0, t) * (1 - smoothstep(duration, duration + 4, t));
      const il = iSlope[i];
      speed[i] = (V_MIN + (V_MAX - V_MIN) * Math.pow(iSpeed[i], 1.25)) * speedMul;
      const wave = Math.sin((TAU * t) / (beat * 8) + ph[3]) * 0.07 * smoothstep(0.45, 0.9, il);
      pitch[i] = (0.09 - 0.42 * il + wave) * inSong;
      const bend =
        0.55 * Math.sin((TAU * t) / 23 + ph[0]) +
        0.3 * Math.sin((TAU * t) / 13.7 + ph[1]) +
        0.15 * Math.sin((TAU * t) / 7.9 + ph[2]);
      yawRate[i] = turnSign * bend * (0.18 + 0.22 * il) * inSong;
    }
    const pitchS = movingAverage(pitch, Math.round(0.4 * this.rate));
    const yawS = movingAverage(yawRate, Math.round(0.4 * this.rate));
    const bank = new Float32Array(n);
    for (let i = 0; i < n; i++) bank[i] = clamp(speed[i] * yawS[i] * 0.02, -0.5, 0.5);
    const bankS = movingAverage(bank, Math.round(0.3 * this.rate));

    this.pos = new Float64Array(n * 3);
    this.tan = new Float64Array(n * 3);
    this.right = new Float64Array(n * 3);
    this.up = new Float64Array(n * 3);
    this.dist = new Float64Array(n);
    this.heading = new Float64Array(n);

    let x = 0;
    let y = 0;
    let z = 0;
    let psi = 0;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const cp = Math.cos(psi);
      const sp = Math.sin(psi);
      const ct = Math.cos(pitchS[i]);
      const st = Math.sin(pitchS[i]);
      const cb = Math.cos(bankS[i]);
      const sb = Math.sin(bankS[i]);
      // Unbanked frame: forward T, right R0 (horizontal), up U0 = R0 x T.
      const Tx = sp * ct;
      const Ty = st;
      const Tz = -cp * ct;
      const R0x = cp;
      const R0z = sp;
      const U0x = -sp * st;
      const U0y = ct;
      const U0z = cp * st;
      // Bank around T: a right turn lowers the right edge.
      const i3 = i * 3;
      this.pos[i3] = x;
      this.pos[i3 + 1] = y;
      this.pos[i3 + 2] = z;
      this.tan[i3] = Tx;
      this.tan[i3 + 1] = Ty;
      this.tan[i3 + 2] = Tz;
      this.right[i3] = R0x * cb - U0x * sb;
      this.right[i3 + 1] = -U0y * sb;
      this.right[i3 + 2] = R0z * cb - U0z * sb;
      this.up[i3] = U0x * cb + R0x * sb;
      this.up[i3 + 1] = U0y * cb;
      this.up[i3 + 2] = U0z * cb + R0z * sb;
      this.dist[i] = s;
      this.heading[i] = psi;

      const step = speed[i] * dt;
      x += Tx * step;
      y += Ty * step;
      z += Tz * step;
      s += step;
      psi += yawS[i] * dt;
    }
    this.speedMin = V_MIN * speedMul;
    this.speedMax = V_MAX * speedMul;
  }

  index(t) {
    return clamp((t - this.tStart) * this.rate, 0, this.count - 1.000001);
  }

  timeAt(i) {
    return this.tStart + i / this.rate;
  }

  speedAt(t) {
    return sampleArray(this.speed, this.index(t));
  }

  intensityAt(t) {
    return sampleArray(this.intensity, this.index(t));
  }

  distAt(t) {
    return sampleArray(this.dist, this.index(t));
  }

  // World position of lateral offset x and height y above the road at time t.
  pointAt(t, x, y, out) {
    const f = this.index(t);
    const i = f | 0;
    const a = f - i;
    const i3 = i * 3;
    const j3 = i3 + 3;
    const P = this.pos;
    const R = this.right;
    const U = this.up;
    const px = P[i3] + (P[j3] - P[i3]) * a;
    const py = P[i3 + 1] + (P[j3 + 1] - P[i3 + 1]) * a;
    const pz = P[i3 + 2] + (P[j3 + 2] - P[i3 + 2]) * a;
    const rx = R[i3] + (R[j3] - R[i3]) * a;
    const ry = R[i3 + 1] + (R[j3 + 1] - R[i3 + 1]) * a;
    const rz = R[i3 + 2] + (R[j3 + 2] - R[i3 + 2]) * a;
    const ux = U[i3] + (U[j3] - U[i3]) * a;
    const uy = U[i3 + 1] + (U[j3 + 1] - U[i3 + 1]) * a;
    const uz = U[i3 + 2] + (U[j3 + 2] - U[i3 + 2]) * a;
    return out.set(px + rx * x + ux * y, py + ry * x + uy * y, pz + rz * x + uz * y);
  }

  // Interpolated frame { p, T, R, U } (Vector3s) at time t.
  frameAt(t, frame) {
    const f = this.index(t);
    const i = f | 0;
    const a = f - i;
    lerp3(this.pos, i, a, frame.p);
    lerp3(this.tan, i, a, frame.T).normalize();
    lerp3(this.right, i, a, frame.R).normalize();
    lerp3(this.up, i, a, frame.U).normalize();
    return frame;
  }
}

function lerp3(arr, i, a, out) {
  const i3 = i * 3;
  const j3 = i3 + 3;
  return out.set(
    arr[i3] + (arr[j3] - arr[i3]) * a,
    arr[i3 + 1] + (arr[j3 + 1] - arr[i3 + 1]) * a,
    arr[i3 + 2] + (arr[j3 + 2] - arr[i3 + 2]) * a,
  );
}
