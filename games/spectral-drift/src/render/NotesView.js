// Instanced rendering for the pickups, holds and hazards inside the visible window.
import * as THREE from 'three';
import { HOLD, KIND, STATE, laneX } from '../config.js';
import { smoothstep } from '../util.js';
import { FOG_GLSL, HAZARD_RGB, POWER_RGB, TIER_RGB } from './shaderLib.js';

const VIEW_DIST = 500;
const HOVER = 0.62;
const RIBBON_HEIGHT = 0.42;
const RIBBON_WIDTH = 0.36;
const RIBBON_STEP = 2; // world units per ribbon segment

export class NotesView {
  constructor(uniforms) {
    this.group = new THREE.Group();
    this.cursor = 0;
    this.frame = { p: new THREE.Vector3(), T: new THREE.Vector3(), R: new THREE.Vector3(), U: new THREE.Vector3() };
    this.m = new THREE.Matrix4();

    const gemGeo = new THREE.OctahedronGeometry(0.42, 0).scale(1, 1.35, 1);
    const powerGeo = new THREE.IcosahedronGeometry(0.62, 0);
    const ringGeo = new THREE.TorusGeometry(0.95, 0.05, 6, 40);
    const hazardGeo = new THREE.BoxGeometry(1.25, 0.75, 0.75);

    this.gemMat = gemMaterial(uniforms);
    this.hazardMat = hazardMaterial(uniforms);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.6, 1.25, 0.55),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.ribbonMat = ribbonMaterial(uniforms);
    this.notes = this.instanced(gemGeo, this.gemMat, 600, true);
    this.powers = this.instanced(powerGeo, this.gemMat, 48, true);
    this.rings = this.instanced(ringGeo, this.ringMat, 48, false);
    this.hazards = this.instanced(hazardGeo, this.hazardMat, 256, false);
    this.ribbons = this.instanced(new THREE.BoxGeometry(1, 1, 1), this.ribbonMat, 1600, true);
    this.pa = new THREE.Vector3();
    this.pb = new THREE.Vector3();
  }

  instanced(geo, mat, count, colored) {
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (colored) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(count * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  reset() {
    this.cursor = 0;
  }

  // `pulse` (RoadPulse) moves everything with the road under it as the drums hit.
  update(track, chart, t, origin, shipX, magnet, beat, pulse = null) {
    this.group.position.copy(origin);
    let nNote = 0;
    let nPower = 0;
    let nHazard = 0;
    this.nRibbon = 0;
    if (chart) {
      const objs = chart.objects;
      const F = this.frame;
      const sNow = track.distAt(t);
      const gone = (o) => o.t + o.hold < t - 0.6;
      while (this.cursor < objs.length && gone(objs[this.cursor])) this.cursor++;
      for (let i = this.cursor; i < objs.length; i++) {
        const o = objs[i];
        const ahead = track.distAt(o.t) - sNow;
        if (ahead > VIEW_DIST) break;
        if (gone(o)) continue;
        if (o.hold > 0) this.ribbon(track, o, t, origin, sNow, beat, pulse);
        const st = o.state;
        if (st === STATE.COLLECTED || st === STATE.HIT || st === STATE.SMASHED) continue;
        const dt = o.t - t;
        let x = laneX(o.lane);
        if (magnet > 0 && o.kind !== KIND.HAZARD && st === STATE.PENDING && Math.abs(x - shipX) < magnet) {
          x += (shipX - x) * smoothstep(0.45, 0.0, dt);
        }
        track.frameAt(o.t, F);
        const bob = Math.sin(t * 4 + o.t * 7) * 0.06;
        const h = HOVER + bob;
        const px = F.p.x + F.R.x * x + F.U.x * h - origin.x;
        const py = F.p.y + F.R.y * x + F.U.y * h - origin.y + (pulse ? pulse.lift(sNow + ahead, x) : 0);
        const pz = F.p.z + F.R.z * x + F.U.z * h - origin.z;
        const appear = smoothstep(VIEW_DIST, VIEW_DIST * 0.8, ahead);
        const dim = st === STATE.MISSED ? 0.22 : 1;

        if (o.kind === KIND.HAZARD) {
          if (nHazard >= this.hazards.instanceMatrix.count) continue;
          oriented(this.m, F, px, py, pz, 0, appear);
          this.hazards.setMatrixAt(nHazard++, this.m);
        } else if (o.kind === KIND.POWER) {
          if (nPower >= this.powers.instanceMatrix.count) continue;
          const s = appear * (1 + beat * 0.18);
          oriented(this.m, F, px, py, pz, t * 2.6 + i, s);
          this.powers.setMatrixAt(nPower, this.m);
          this.powers.instanceColor.setXYZ(nPower, POWER_RGB[0] * dim, POWER_RGB[1] * dim, POWER_RGB[2] * dim);
          ringMatrix(this.m, F, px, py, pz, t * 1.7 + i, s * (1 + 0.1 * Math.sin(t * 8)));
          this.rings.setMatrixAt(nPower, this.m);
          nPower++;
        } else {
          if (nNote >= this.notes.instanceMatrix.count) continue;
          oriented(this.m, F, px, py, pz, t * 2.2 + o.t * 13, appear);
          this.notes.setMatrixAt(nNote, this.m);
          const c = TIER_RGB[o.tier];
          this.notes.instanceColor.setXYZ(nNote, c[0] * dim, c[1] * dim, c[2] * dim);
          nNote++;
        }
      }
    }
    this.notes.count = nNote;
    this.powers.count = nPower;
    this.rings.count = nPower;
    this.hazards.count = nHazard;
    this.ribbons.count = this.nRibbon;
    for (const mesh of [this.notes, this.powers, this.rings, this.hazards, this.ribbons]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  // A hold's beam along its lane, from its head (or the ship, once held) to its end:
  // bright while held, faint once let go.
  ribbon(track, o, t, origin, sNow, beat, pulse) {
    const hs = o.holdState;
    if (hs === HOLD.DONE) return;
    const t1 = o.t + o.hold;
    let ta = hs === HOLD.HOLDING ? Math.max(o.t, t) : o.t;
    if (t1 <= ta) return;
    const c = o.kind === KIND.POWER ? POWER_RGB : TIER_RGB[o.tier];
    const glow = hs === HOLD.HOLDING ? 1.5 + 0.6 * beat : hs === HOLD.DROPPED ? 0.12 : 0.55;
    const x = laneX(o.lane);
    const { R, U } = this.frame;
    const mesh = this.ribbons;
    const max = mesh.instanceMatrix.count;
    const pa = track.pointAt(ta, x, RIBBON_HEIGHT, this.pa);
    if (pulse) pa.y += pulse.lift(track.distAt(ta), x);
    while (ta < t1 && this.nRibbon < max) {
      const tb = Math.min(t1, ta + RIBBON_STEP / Math.max(10, track.speedAt(ta)));
      const pb = track.pointAt(tb, x, RIBBON_HEIGHT, this.pb);
      if (pulse) pb.y += pulse.lift(track.distAt(tb), x);
      track.frameAt((ta + tb) / 2, this.frame);
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dz = pb.z - pa.z;
      const w = RIBBON_WIDTH;
      const h = 0.05;
      this.m.set(
        R.x * w, U.x * h, dx, (pa.x + pb.x) / 2 - origin.x,
        R.y * w, U.y * h, dy, (pa.y + pb.y) / 2 - origin.y,
        R.z * w, U.z * h, dz, (pa.z + pb.z) / 2 - origin.z,
        0, 0, 0, 1,
      );
      mesh.setMatrixAt(this.nRibbon, this.m);
      mesh.instanceColor.setXYZ(this.nRibbon, c[0] * glow, c[1] * glow, c[2] * glow);
      this.nRibbon++;
      pa.copy(pb);
      ta = tb;
      if (track.distAt(ta) - sNow > VIEW_DIST) break;
    }
  }
}

// Basis aligned to the road (x = right, y = up, z = backward) spun around up.
function oriented(m, F, px, py, pz, spin, scale) {
  const c = Math.cos(spin) * scale;
  const s = Math.sin(spin) * scale;
  const { R, U, T } = F;
  m.set(
    R.x * c + T.x * s, U.x * scale, R.x * s - T.x * c, px,
    R.y * c + T.y * s, U.y * scale, R.y * s - T.y * c, py,
    R.z * c + T.z * s, U.z * scale, R.z * s - T.z * c, pz,
    0, 0, 0, 1,
  );
}

// Ring facing down the road, spinning around the road direction.
function ringMatrix(m, F, px, py, pz, spin, scale) {
  const c = Math.cos(spin) * scale;
  const s = Math.sin(spin) * scale;
  const { R, U, T } = F;
  m.set(
    R.x * c + U.x * s, U.x * c - R.x * s, -T.x * scale, px,
    R.y * c + U.y * s, U.y * c - R.y * s, -T.y * scale, py,
    R.z * c + U.z * s, U.z * c - R.z * s, -T.z * scale, pz,
    0, 0, 0, 1,
  );
}

function gemMaterial(U) {
  return new THREE.ShaderMaterial({
    uniforms: { uBeat: U.uBeat, uFogColor: U.uFogColor, uFogDensity: U.uFogDensity },
    vertexShader: /* glsl */ `
      varying vec3 vColor;
      varying vec3 vNormalV;
      varying vec3 vViewPos;
      void main() {
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vColor = instanceColor;
        vNormalV = normalMatrix * mat3(instanceMatrix) * normal;
        vViewPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uBeat;
      varying vec3 vColor;
      varying vec3 vNormalV;
      varying vec3 vViewPos;
      ${FOG_GLSL}
      void main() {
        float ndv = clamp(abs(dot(normalize(vNormalV), normalize(-vViewPos))), 0.0, 1.0);
        float rim = pow(1.0 - ndv, 2.0);
        vec3 col = vColor * (0.45 + 1.1 * rim + 0.25 * uBeat) + vec3(pow(ndv, 10.0) * 0.3);
        col = mix(col, uFogColor, fogFactor(-vViewPos.z));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

// Additive beam that fades into the distance (rather than into the fog color).
function ribbonMaterial(U) {
  return new THREE.ShaderMaterial({
    uniforms: { uFogColor: U.uFogColor, uFogDensity: U.uFogDensity },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vColor;
      varying float vDepth;
      varying vec2 vUv;
      void main() {
        vColor = instanceColor;
        vUv = uv;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vDepth;
      varying vec2 vUv;
      ${FOG_GLSL}
      void main() {
        gl_FragColor = vec4(vColor * (1.0 - fogFactor(vDepth)), 1.0);
      }
    `,
  });
}

function hazardMaterial(U) {
  const red = HAZARD_RGB.map((v) => v.toFixed(3)).join(', ');
  return new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uBeat: U.uBeat, uFogColor: U.uFogColor, uFogDensity: U.uFogDensity },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying float vDepth;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uBeat;
      varying vec2 vUv;
      varying float vDepth;
      ${FOG_GLSL}
      void main() {
        vec3 red = vec3(${red});
        vec2 e = min(vUv, 1.0 - vUv);
        float border = 1.0 - smoothstep(0.06, 0.1, min(e.x, e.y));
        float diag = min(abs(vUv.x - vUv.y), abs(vUv.x + vUv.y - 1.0));
        float cross = 1.0 - smoothstep(0.03, 0.06, diag);
        float pulse = 0.75 + 0.25 * sin(uTime * 12.0) + uBeat * 0.4;
        vec3 col = vec3(0.05, 0.0, 0.012) + red * (border * 2.2 + cross * 0.9) * pulse;
        col = mix(col, uFogColor, fogFactor(vDepth));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}
