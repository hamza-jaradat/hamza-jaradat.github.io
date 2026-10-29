// Pickup bursts (glowing points) and speed streaks (lines that stretch with speed).
// Both are stored in world space and uploaded relative to a moving origin.
import * as THREE from 'three';
import { heatRGB } from './shaderLib.js';

export class Bursts {
  constructor(uniforms, capacity = 1400) {
    this.cap = capacity;
    this.world = new Float64Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.next = 0;

    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: uniforms.uPointScale },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float depth = max(0.1, -mv.z);
          // Fade out and cap size as particles drift back past the camera.
          vAlpha = aAlpha * smoothstep(1.5, 5.0, depth);
          gl_PointSize = vAlpha > 0.0 ? min(aSize * uScale / depth, 0.05 * uScale) : 0.0;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = 1.0 - smoothstep(0.0, 0.5, d);
          gl_FragColor = vec4(vColor * a * a * vAlpha * 2.0, 1.0);
        }
      `,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  emit(pos, forward, speed, rgb, count, spread = 7, size = 0.35, life = 0.55) {
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.cap;
      this.world[i * 3] = pos.x;
      this.world[i * 3 + 1] = pos.y;
      this.world[i * 3 + 2] = pos.z;
      // random direction, biased forward so the burst travels with the ship for a moment
      let dx = Math.random() * 2 - 1;
      let dy = Math.random() * 2 - 1;
      let dz = Math.random() * 2 - 1;
      const len = Math.hypot(dx, dy, dz) || 1;
      const s = spread * (0.35 + Math.random() * 0.65);
      dx = (dx / len) * s + forward.x * speed * 0.82;
      dy = (dy / len) * s + forward.y * speed * 0.82;
      dz = (dz / len) * s + forward.z * speed * 0.82;
      this.vel.set([dx, dy, dz], i * 3);
      this.life[i] = this.maxLife[i] = life * (0.6 + Math.random() * 0.6);
      const w = 0.75 + Math.random() * 0.5;
      this.color.set([rgb[0] * w, rgb[1] * w, rgb[2] * w], i * 3);
      this.size[i] = size * (0.5 + Math.random());
    }
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.points.geometry.attributes.aAlpha.needsUpdate = true;
  }

  update(dt, origin) {
    const drag = Math.exp(-dt * 2.5);
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) {
        this.alpha[i] = 0;
        continue;
      }
      this.life[i] -= dt;
      const i3 = i * 3;
      this.vel[i3] *= drag;
      this.vel[i3 + 1] *= drag;
      this.vel[i3 + 2] *= drag;
      this.world[i3] += this.vel[i3] * dt;
      this.world[i3 + 1] += this.vel[i3 + 1] * dt;
      this.world[i3 + 2] += this.vel[i3 + 2] * dt;
      this.pos[i3] = this.world[i3] - origin.x;
      this.pos[i3 + 1] = this.world[i3 + 1] - origin.y;
      this.pos[i3 + 2] = this.world[i3 + 2] - origin.z;
      this.alpha[i] = Math.max(0, this.life[i] / this.maxLife[i]);
    }
    this.points.position.copy(origin);
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = true;
    a.aColor.needsUpdate = true;
    a.aSize.needsUpdate = true;
    a.aAlpha.needsUpdate = true;
  }
}

export class Streaks {
  constructor(count = 240) {
    this.count = count;
    this.t = new Float64Array(count);
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.ready = false;
    this.p = new THREE.Vector3();
    this.frame = { p: new THREE.Vector3(), T: new THREE.Vector3(), R: new THREE.Vector3(), U: new THREE.Vector3() };

    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(count * 6);
    this.col = new Float32Array(count * 6);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.lines = new THREE.LineSegments(geo, mat);
    this.lines.frustumCulled = false;
  }

  spawn(i, t, near) {
    this.t[i] = t + (near ? Math.random() * 4.5 : 3 + Math.random() * 1.5);
    const side = Math.random() < 0.5 ? -1 : 1;
    this.x[i] = side * (5 + Math.random() * 38);
    this.y[i] = -12 + Math.random() * 34;
  }

  reset() {
    this.ready = false;
  }

  update(track, t, origin, intensity, overdrive) {
    if (!this.ready) {
      for (let i = 0; i < this.count; i++) this.spawn(i, t, true);
      this.ready = true;
    }
    const v = track.speedAt(t);
    const len = 1.5 + v * v * 0.001;
    const rgb = heatRGB(intensity);
    const boost = 0.35 + 0.5 * intensity + overdrive * 0.4;
    const F = this.frame;
    for (let i = 0; i < this.count; i++) {
      if (this.t[i] < t - 0.15) this.spawn(i, t, false);
      track.frameAt(this.t[i], F);
      const px = F.p.x + F.R.x * this.x[i] + F.U.x * this.y[i] - origin.x;
      const py = F.p.y + F.R.y * this.x[i] + F.U.y * this.y[i] - origin.y;
      const pz = F.p.z + F.R.z * this.x[i] + F.U.z * this.y[i] - origin.z;
      const i6 = i * 6;
      this.pos[i6] = px;
      this.pos[i6 + 1] = py;
      this.pos[i6 + 2] = pz;
      this.pos[i6 + 3] = px - F.T.x * len;
      this.pos[i6 + 4] = py - F.T.y * len;
      this.pos[i6 + 5] = pz - F.T.z * len;
      const ahead = this.t[i] - t;
      const fade = Math.min(1, ahead < 0.6 ? 1 : (4.5 - ahead) / 2) * boost;
      this.col[i6] = rgb[0] * fade;
      this.col[i6 + 1] = rgb[1] * fade;
      this.col[i6 + 2] = rgb[2] * fade;
      this.col[i6 + 3] = 0;
      this.col[i6 + 4] = 0;
      this.col[i6 + 5] = 0;
    }
    this.lines.position.copy(origin);
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.color.needsUpdate = true;
  }
}
