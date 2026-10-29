// The player's craft: a faceted dart with neon trim, engine glow, an overdrive
// shield and ribbon trails that follow the road's curvature.
import * as THREE from 'three';
import { clamp, damp } from '../util.js';

const HOVER = 0.55;

export class Ship {
  constructor() {
    this.group = new THREE.Group();
    this.body = new THREE.Group();
    this.group.add(this.body);
    this.frame = { p: new THREE.Vector3(), T: new THREE.Vector3(), R: new THREE.Vector3(), U: new THREE.Vector3() };
    this.basis = new THREE.Matrix4();
    this.back = new THREE.Vector3();
    this.roll = 0;
    this.yaw = 0;
    this.flash = 0;
    this.flashColor = new THREE.Color(1, 1, 1);

    const hullGeo = buildHull();
    this.hullMat = new THREE.MeshStandardMaterial({
      color: 0x1b2140,
      metalness: 0.65,
      roughness: 0.32,
      flatShading: true,
      emissive: new THREE.Color(0x0b1030),
      side: THREE.DoubleSide,
    });
    this.body.add(new THREE.Mesh(hullGeo, this.hullMat));

    this.trimColor = new THREE.Color(0.45, 1.6, 2.2);
    this.trimMat = new THREE.LineBasicMaterial({ color: this.trimColor.clone(), toneMapped: false });
    this.body.add(new THREE.LineSegments(new THREE.EdgesGeometry(hullGeo, 1), this.trimMat));

    this.engineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.1, 1.6) });
    const engine = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), this.engineMat);
    engine.position.set(0, 0.06, 0.72);
    engine.scale.set(1.4, 0.8, 1);
    this.body.add(engine);
    this.engine = engine;

    const tipGeo = new THREE.BoxGeometry(0.07, 0.07, 0.3);
    this.tipMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 0.6, 1.6), toneMapped: false });
    for (const side of [-1, 1]) {
      const tip = new THREE.Mesh(tipGeo, this.tipMat);
      tip.position.set(side * 0.95, -0.02, 0.5);
      this.body.add(tip);
    }

    this.shieldMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.4, 1.0, 0.35),
      wireframe: true,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.shield = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 1), this.shieldMat);
    this.shield.scale.set(1, 0.55, 1.3);
    this.shield.visible = false;
    this.group.add(this.shield);

    this.trails = new THREE.Group();
    this.trailList = [
      new Trail(24, 4, 0.26, new THREE.Color(0.15, 0.5, 0.9), 0, 0.06),
      new Trail(20, 3.5, 0.06, new THREE.Color(1.2, 0.3, 0.9), -0.95, -0.02),
      new Trail(20, 3.5, 0.06, new THREE.Color(1.2, 0.3, 0.9), 0.95, -0.02),
    ];
    for (const tr of this.trailList) this.trails.add(tr.mesh);
  }

  reset() {
    for (const tr of this.trailList) tr.clear();
    this.roll = 0;
    this.yaw = 0;
  }

  pulse(color) {
    this.flash = 1;
    this.flashColor.setRGB(color[0], color[1], color[2]);
  }

  update(track, t, x, vx, dt, { beat = 0, overdrive = 0, invuln = 0, time = 0 } = {}) {
    const F = track.frameAt(t, this.frame);
    const hover = HOVER + Math.sin(time * 3.1) * 0.04 + beat * 0.05;
    this.group.position.copy(F.p).addScaledVector(F.R, x).addScaledVector(F.U, hover);
    this.basis.makeBasis(F.R, F.U, this.back.copy(F.T).negate());
    this.group.quaternion.setFromRotationMatrix(this.basis);

    this.roll += (clamp(-vx * 0.07, -0.65, 0.65) - this.roll) * damp(10, dt);
    this.yaw += (clamp(-vx * 0.02, -0.25, 0.25) - this.yaw) * damp(10, dt);
    this.body.rotation.set(0, this.yaw, this.roll);

    this.flash = Math.max(0, this.flash - dt * 4);
    const glow = 0.7 + beat * 0.3 + this.flash * 0.6;
    const od = overdrive;
    this.trimMat.color.setRGB(
      (this.trimColor.r * (1 - od) + 2.4 * od) * glow,
      (this.trimColor.g * (1 - od) + 1.7 * od) * glow,
      (this.trimColor.b * (1 - od) + 0.5 * od) * glow,
    );
    this.trimMat.color.lerp(this.flashColor, this.flash * 0.6);
    this.engine.scale.set(1.4 + beat * 0.6, 0.8 + beat * 0.3, 1 + beat);

    this.shield.visible = od > 0.01;
    if (this.shield.visible) {
      this.shield.rotation.y += dt * 2.2;
      this.shield.rotation.x += dt * 0.7;
      this.shieldMat.opacity = 0.12 * od + beat * 0.1;
    }

    this.group.visible = !(invuln > 0 && Math.floor(time * 18) % 2 === 0);

    for (const tr of this.trailList) tr.push(t, x, hover);
  }

  // Trails live in world space relative to `origin` (see World).
  updateTrails(track, origin, overdrive) {
    for (const tr of this.trailList) tr.build(track, origin, overdrive);
    this.trails.position.copy(origin);
  }
}

function buildHull() {
  const N = [0, 0.02, -1.5];
  const T = [0, 0.3, 0.15];
  const L = [-0.95, -0.02, 0.55];
  const R = [0.95, -0.02, 0.55];
  const B = [0, -0.16, 0.25];
  const E = [0, 0.08, 0.72];
  const faces = [
    [N, L, T], [N, T, R], [T, L, E], [T, E, R],
    [N, B, L], [N, R, B], [B, E, L], [B, R, E],
  ];
  const pos = new Float32Array(faces.length * 9);
  faces.forEach((f, i) => f.forEach((v, j) => pos.set(v, i * 9 + j * 3)));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

// Ribbon of fixed length (in world units) that replays the ship's recent
// lateral positions along the road behind it.
class Trail {
  constructor(segments, length, width, color, offsetX, offsetY) {
    this.n = segments;
    this.length = length;
    this.width = width;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.hist = [];
    this.s = { x: 0, y: 0 };
    this.frame = { p: new THREE.Vector3(), T: new THREE.Vector3(), R: new THREE.Vector3(), U: new THREE.Vector3() };

    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(segments * 2 * 3);
    this.alpha = new Float32Array(segments * 2);
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let k = 0; k < segments - 1; k++) {
      const a = k * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(idx);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color.clone() }, uBase: { value: color.clone() } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          gl_FragColor = vec4(uColor * vAlpha, 1.0);
        }
      `,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
  }

  clear() {
    this.hist.length = 0;
  }

  push(t, x, y) {
    const h = this.hist;
    if (h.length && t < h[h.length - 1].t) h.length = 0;
    h.push({ t, x, y });
    while (h.length > 2 && h[0].t < t - 1) h.shift();
  }

  sample(t) {
    const h = this.hist;
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1];
      if (a.t > t) continue;
      const b = h[i];
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      this.s.x = a.x + (b.x - a.x) * f;
      this.s.y = a.y + (b.y - a.y) * f;
      return this.s;
    }
    return h[0];
  }

  build(track, origin, overdrive) {
    const h = this.hist;
    if (h.length < 2) {
      this.alpha.fill(0);
      this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
      return;
    }
    const F = this.frame;
    const now = h[h.length - 1].t;
    const span = this.length / Math.max(1, track.speedAt(now));
    for (let k = 0; k < this.n; k++) {
      const f = k / (this.n - 1);
      const tk = now - span * f;
      const e = this.sample(tk);
      track.frameAt(tk, F);
      const cx = e.x + this.offsetX;
      const cy = e.y + this.offsetY;
      const px = F.p.x + F.R.x * cx + F.U.x * cy - origin.x;
      const py = F.p.y + F.R.y * cx + F.U.y * cy - origin.y;
      const pz = F.p.z + F.R.z * cx + F.U.z * cy - origin.z;
      const w = this.width * (1 - f * 0.85) * 0.5;
      this.positions.set([px - F.R.x * w, py - F.R.y * w, pz - F.R.z * w, px + F.R.x * w, py + F.R.y * w, pz + F.R.z * w], k * 6);
      const a = tk < h[0].t ? 0 : Math.pow(1 - f, 1.6);
      this.alpha[k * 2] = this.alpha[k * 2 + 1] = a;
    }
    const geo = this.mesh.geometry;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
    const base = this.material.uniforms.uBase.value;
    this.material.uniforms.uColor.value.setRGB(
      base.r + (2.2 - base.r) * overdrive,
      base.g + (1.5 - base.g) * overdrive,
      base.b + (0.4 - base.b) * overdrive,
    );
  }
}
