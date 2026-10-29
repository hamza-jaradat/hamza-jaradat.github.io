// Instanced rendering for the pickups and hazards inside the visible window.
import * as THREE from 'three';
import { KIND, STATE, laneX } from '../config.js';
import { smoothstep } from '../util.js';
import { FOG_GLSL, HAZARD_RGB, POWER_RGB, TIER_RGB } from './shaderLib.js';

const VIEW_DIST = 500;
const HOVER = 0.62;

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

    this.notes = this.instanced(gemGeo, this.gemMat, 600, true);
    this.powers = this.instanced(powerGeo, this.gemMat, 48, true);
    this.rings = this.instanced(ringGeo, this.ringMat, 48, false);
    this.hazards = this.instanced(hazardGeo, this.hazardMat, 256, false);
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

  update(track, chart, t, origin, shipX, magnet, beat) {
    this.group.position.copy(origin);
    let nNote = 0;
    let nPower = 0;
    let nHazard = 0;
    if (chart) {
      const objs = chart.objects;
      const F = this.frame;
      const sNow = track.distAt(t);
      while (this.cursor < objs.length && objs[this.cursor].t < t - 0.6) this.cursor++;
      for (let i = this.cursor; i < objs.length; i++) {
        const o = objs[i];
        const ahead = track.distAt(o.t) - sNow;
        if (ahead > VIEW_DIST) break;
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
        const py = F.p.y + F.R.y * x + F.U.y * h - origin.y;
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
    for (const mesh of [this.notes, this.powers, this.rings, this.hazards]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
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
