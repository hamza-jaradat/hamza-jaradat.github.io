// Chunked road meshes plus everything bolted to the road: glowing rails,
// support pylons, spectrum towers, arches on big hits, and distant wireframes.
// Each chunk stores geometry relative to its own origin to keep float32 precise.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LANES, TRACK_HALF_WIDTH, TRACK_MARGIN } from '../config.js';
import { mulberry32, sampleArray } from '../util.js';
import { ROAD_PULSE_GLSL } from './RoadPulse.js';
import { FOG_GLSL, HEAT_GLSL } from './shaderLib.js';

const CHUNK_SECONDS = 4;
const RAIL_HEIGHT = 0.34;
const PYLON_SPACING = 14;
const PYLON_DEPTH = 60;
const BAR_SPACING = 7;
const VIEW_BEHIND = 40;
const VIEW_AHEAD = 560;

export class TrackView {
  constructor(track, features, uniforms, seed = 1) {
    this.track = track;
    this.group = new THREE.Group();
    this.chunks = [];
    this.seed = seed;
    this.materials = createMaterials(uniforms);
    this.gateGeo = new THREE.TorusGeometry(TRACK_HALF_WIDTH + 0.6, 0.07, 6, 48, Math.PI);
    this.barGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    this.decoGeos = [
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1, 0)),
      new THREE.EdgesGeometry(new THREE.OctahedronGeometry(1, 0)),
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1, 1)),
    ];
    this.gateTimes = pickGateTimes(features);

    const per = CHUNK_SECONDS * track.rate;
    for (let i0 = 0, c = 0; i0 < track.count - 1; i0 += per, c++) {
      const chunk = this.buildChunk(i0, Math.min(track.count - 1, i0 + per), c);
      this.chunks.push(chunk);
      this.group.add(chunk.group);
    }
  }

  buildChunk(i0, i1, index) {
    const tr = this.track;
    const m = this.materials;
    const rng = mulberry32(this.seed * 977 + index * 7919);
    const group = new THREE.Group();
    const ox = tr.pos[i0 * 3];
    const oy = tr.pos[i0 * 3 + 1];
    const oz = tr.pos[i0 * 3 + 2];
    group.position.set(ox, oy, oz);
    const n = i1 - i0 + 1;
    const w = TRACK_HALF_WIDTH;

    // --- Road surface and rails ---------------------------------------------
    const sPos = new Float32Array(n * 6);
    const sUv = new Float32Array(n * 4);
    const sI = new Float32Array(n * 2);
    const sS = new Float32Array(n * 2);
    const rPos = new Float32Array(n * 12);
    const rH = new Float32Array(n * 4);
    const rI = new Float32Array(n * 4);
    const rS = new Float32Array(n * 4);
    const rX = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      const i3 = (i0 + k) * 3;
      const px = tr.pos[i3] - ox;
      const py = tr.pos[i3 + 1] - oy;
      const pz = tr.pos[i3 + 2] - oz;
      const rx = tr.right[i3] * w;
      const ry = tr.right[i3 + 1] * w;
      const rz = tr.right[i3 + 2] * w;
      const ux = tr.up[i3] * RAIL_HEIGHT;
      const uy = tr.up[i3 + 1] * RAIL_HEIGHT;
      const uz = tr.up[i3 + 2] * RAIL_HEIGHT;
      const t = tr.timeAt(i0 + k);
      const I = tr.intensity[i0 + k];
      sPos.set([px - rx, py - ry, pz - rz, px + rx, py + ry, pz + rz], k * 6);
      sUv.set([0, t, 1, t], k * 4);
      sI[k * 2] = sI[k * 2 + 1] = I;
      sS[k * 2] = sS[k * 2 + 1] = tr.dist[i0 + k];
      rPos.set(
        [
          px - rx, py - ry, pz - rz,
          px - rx + ux, py - ry + uy, pz - rz + uz,
          px + rx, py + ry, pz + rz,
          px + rx + ux, py + ry + uy, pz + rz + uz,
        ],
        k * 12,
      );
      rH.set([0, 1, 0, 1], k * 4);
      rI.set([I, I, I, I], k * 4);
      rS.fill(tr.dist[i0 + k], k * 4, k * 4 + 4);
      rX.set([-w, -w, w, w], k * 4);
    }
    const sIdx = [];
    const rIdx = [];
    for (let k = 0; k < n - 1; k++) {
      const a = k * 2;
      sIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      for (const side of [0, 2]) {
        const b = k * 4 + side;
        rIdx.push(b, b + 4, b + 1, b + 1, b + 4, b + 5);
      }
    }
    const surfGeo = new THREE.BufferGeometry();
    surfGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
    surfGeo.setAttribute('uv', new THREE.BufferAttribute(sUv, 2));
    surfGeo.setAttribute('aI', new THREE.BufferAttribute(sI, 1));
    surfGeo.setAttribute('aS', new THREE.BufferAttribute(sS, 1));
    surfGeo.setIndex(sIdx);
    surfGeo.computeBoundingSphere();
    const surface = new THREE.Mesh(surfGeo, m.surface);
    group.add(surface);

    const railGeo = new THREE.BufferGeometry();
    railGeo.setAttribute('position', new THREE.BufferAttribute(rPos, 3));
    railGeo.setAttribute('aH', new THREE.BufferAttribute(rH, 1));
    railGeo.setAttribute('aI', new THREE.BufferAttribute(rI, 1));
    railGeo.setAttribute('aS', new THREE.BufferAttribute(rS, 1));
    railGeo.setAttribute('aX', new THREE.BufferAttribute(rX, 1));
    railGeo.setIndex(rIdx);
    railGeo.computeBoundingSphere();
    const rails = new THREE.Mesh(railGeo, m.rail);
    rails.renderOrder = 2;
    group.add(rails);

    // --- Pylons and spectrum towers, spaced by distance -----------------------
    const pPos = [];
    const pH = [];
    const pI = [];
    const pS = [];
    const pX = [];
    const bars = [];
    let nextPylon = Math.ceil(tr.dist[i0] / PYLON_SPACING) * PYLON_SPACING;
    let nextBar = Math.ceil(tr.dist[i0] / BAR_SPACING) * BAR_SPACING;
    for (let i = i0; i < i1; i++) {
      const i3 = i * 3;
      const px = tr.pos[i3] - ox;
      const py = tr.pos[i3 + 1] - oy;
      const pz = tr.pos[i3 + 2] - oz;
      if (tr.dist[i] >= nextPylon) {
        nextPylon += PYLON_SPACING;
        for (const side of [-1, 1]) {
          const ex = px + tr.right[i3] * w * side;
          const ey = py + tr.right[i3 + 1] * w * side;
          const ez = pz + tr.right[i3 + 2] * w * side;
          pPos.push(ex, ey, ez, ex, ey - PYLON_DEPTH, ez);
          pH.push(0, 1);
          pI.push(tr.intensity[i], tr.intensity[i]);
          pS.push(tr.dist[i], tr.dist[i]);
          pX.push(w * side, w * side);
        }
      }
      if (tr.dist[i] >= nextBar) {
        nextBar += BAR_SPACING;
        const psi = tr.heading[i];
        for (const side of [-1, 1]) {
          if (rng() < 0.4) continue;
          const reach = rng();
          const lateral = side * (w + 7 + reach * 28);
          bars.push({
            x: px + Math.cos(psi) * lateral,
            y: py - (8 + rng() * 26),
            z: pz + Math.sin(psi) * lateral,
            psi,
            h: 14 + rng() * 28,
            w: 1.2 + rng() * 2.4,
            band: Math.min(1, reach * 0.8 + rng() * 0.2),
          });
        }
      }
    }
    if (pPos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pPos, 3));
      g.setAttribute('aH', new THREE.Float32BufferAttribute(pH, 1));
      g.setAttribute('aI', new THREE.Float32BufferAttribute(pI, 1));
      g.setAttribute('aS', new THREE.Float32BufferAttribute(pS, 1));
      g.setAttribute('aX', new THREE.Float32BufferAttribute(pX, 1));
      g.computeBoundingSphere();
      group.add(new THREE.LineSegments(g, m.pylon));
    }
    if (bars.length) {
      const mesh = new THREE.InstancedMesh(this.barGeo, m.bar, bars.length);
      const band = new Float32Array(bars.length);
      const mat = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const v = new THREE.Vector3();
      const s = new THREE.Vector3();
      bars.forEach((b, k) => {
        q.setFromEuler(e.set(0, -b.psi, 0));
        mat.compose(v.set(b.x, b.y, b.z), q, s.set(b.w, b.h, b.w));
        mesh.setMatrixAt(k, mat);
        band[k] = b.band;
      });
      mesh.geometry = this.barGeo.clone();
      mesh.geometry.setAttribute('aBand', new THREE.InstancedBufferAttribute(band, 1));
      mesh.frustumCulled = false;
      group.add(mesh);
    }

    // --- Arches on strong low-end hits ------------------------------------------
    const t0 = tr.timeAt(i0);
    const t1 = tr.timeAt(i1);
    const gates = [];
    const frame = { p: new THREE.Vector3(), T: new THREE.Vector3(), R: new THREE.Vector3(), U: new THREE.Vector3() };
    const basis = new THREE.Matrix4();
    for (const gt of this.gateTimes) {
      if (gt < t0 || gt >= t1) continue;
      tr.frameAt(gt, frame);
      basis.makeBasis(frame.R, frame.U, frame.T.clone().negate());
      basis.setPosition(frame.p.x - ox, frame.p.y - oy, frame.p.z - oz);
      const g = this.gateGeo.clone().applyMatrix4(basis);
      const count = g.attributes.position.count;
      g.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(count).fill(gt), 1));
      g.setAttribute('aI', new THREE.BufferAttribute(new Float32Array(count).fill(tr.intensityAt(gt)), 1));
      g.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(count).fill(tr.distAt(gt)), 1));
      gates.push(g);
    }
    if (gates.length) {
      const merged = mergeGeometries(gates);
      gates.forEach((g) => g.dispose());
      const gateMesh = new THREE.Mesh(merged, m.gate);
      gateMesh.renderOrder = 3;
      group.add(gateMesh);
    }

    // --- Distant wireframe shapes -------------------------------------------------
    const decos = [];
    if (rng() < 0.75) {
      const im = Math.floor((i0 + i1) / 2);
      const i3 = im * 3;
      const psi = tr.heading[im];
      const side = rng() < 0.5 ? -1 : 1;
      const lateral = side * (70 + rng() * 140);
      const deco = new THREE.LineSegments(this.decoGeos[Math.floor(rng() * this.decoGeos.length)], m.deco);
      deco.position.set(
        tr.pos[i3] - ox + Math.cos(psi) * lateral,
        tr.pos[i3 + 1] - oy - 20 + rng() * 90,
        tr.pos[i3 + 2] - oz + Math.sin(psi) * lateral,
      );
      deco.scale.setScalar(10 + rng() * 26);
      deco.rotation.set(rng() * 6, rng() * 6, 0);
      deco.userData.spin = (rng() - 0.5) * 0.4;
      group.add(deco);
      decos.push(deco);
    }

    return { group, sStart: tr.dist[i0], sEnd: tr.dist[i1], decos };
  }

  update(t, dt) {
    const s = this.track.distAt(t);
    for (const c of this.chunks) {
      const visible = c.sEnd > s - VIEW_BEHIND && c.sStart < s + VIEW_AHEAD;
      c.group.visible = visible;
      if (!visible) continue;
      for (const d of c.decos) {
        d.rotation.y += d.userData.spin * dt;
        d.rotation.x += d.userData.spin * 0.6 * dt;
      }
    }
  }

  dispose() {
    for (const c of this.chunks) {
      c.group.traverse((o) => {
        if ((o.isMesh || o.isLineSegments) && !this.decoGeos.includes(o.geometry)) o.geometry.dispose();
        if (o.isInstancedMesh) o.dispose();
      });
    }
    this.gateGeo.dispose();
    this.barGeo.dispose();
    this.decoGeos.forEach((g) => g.dispose());
    Object.values(this.materials).forEach((mat) => mat.dispose());
  }
}

// Arches mark the music's phrasing: every drop, every bar of a drop's first phrase, every
// other bar in the song's peaks, every fourth in grooves, and the last bars of build-ups.
function pickGateTimes(features) {
  const { downbeats, sections = [], drops = [], builds = [] } = features;
  if (!downbeats || downbeats.length < 8 || !sections.length) return gatesOnKicks(features);
  const times = [...drops];
  let s = 0;
  let barInSection = 0;
  for (const t of downbeats) {
    while (s < sections.length - 1 && sections[s + 1].start <= t + 0.05) {
      s++;
      barInSection = 0;
    }
    const sec = sections[s];
    const every = sec.drop && barInSection < 8 ? 1 : sec.kind === 'peak' ? 2 : sec.kind === 'groove' ? 4 : 0;
    const build = builds.some((b) => t >= b.end - 4 * (b.end - b.start) / 8 && t < b.end);
    if (build || (every && barInSection % every === 0)) times.push(t);
    barInSection++;
  }
  times.sort((a, b) => a - b);
  return times.filter((t, i) => i === 0 || t - times[i - 1] > 0.8);
}

// Without a bar grid: arches on strong kicks in the intense parts.
function gatesOnKicks(features) {
  const times = [];
  let last = -10;
  for (const o of features.onsets) {
    if (!(o.b & 1) || o.s < 0.55 || o.t - last < 1.6) continue;
    if (sampleArray(features.intensity, o.t * features.frameRate) < 0.55) continue;
    times.push(o.t);
    last = o.t;
  }
  return times;
}

function createMaterials(U) {
  const shared = {
    uTime: U.uTime,
    uBeat: U.uBeat,
    uOverdrive: U.uOverdrive,
    uFogColor: U.uFogColor,
    uFogDensity: U.uFogDensity,
    // The drums' motion and light (RoadPulse.js).
    uShipS: U.uShipS,
    uDip: U.uDip,
    uTwist: U.uTwist,
    uRipples: U.uRipples,
    uBackbeat: U.uBackbeat,
  };
  const edge = (TRACK_MARGIN / (2 * TRACK_HALF_WIDTH)).toFixed(5);

  const surface = new THREE.ShaderMaterial({
    uniforms: { ...shared, uShipU: U.uShipU },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aI;
      attribute float aS;
      varying vec2 vUv;
      varying float vI;
      varying float vS;
      varying float vDepth;
      ${ROAD_PULSE_GLSL}
      void main() {
        vUv = uv;
        vI = aI;
        vS = aS;
        vec3 p = position;
        p.y += roadLift(aS, (uv.x - 0.5) * ${(2 * TRACK_HALF_WIDTH).toFixed(4)});
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uBeat;
      uniform float uOverdrive;
      uniform float uShipU;
      uniform float uBackbeat;
      varying vec2 vUv;
      varying float vI;
      varying float vS;
      varying float vDepth;
      ${HEAT_GLSL}
      ${FOG_GLSL}
      ${ROAD_PULSE_GLSL}
      const float LANES = ${LANES}.0;
      const float EDGE = ${edge};
      void main() {
        float u = vUv.x;
        float lanePos = (u - EDGE) / (1.0 - 2.0 * EDGE) * LANES;
        vec3 hc = mix(heat(vI), vec3(1.0, 0.82, 0.4), uOverdrive * 0.75);
        vec3 col = vec3(0.004, 0.004, 0.012) + hc * 0.025;

        float fw = fwidth(lanePos);
        float d = abs(lanePos - floor(lanePos + 0.5));
        float line = 1.0 - smoothstep(0.014, 0.014 + fw * 1.5, d);
        float inner = step(0.5, lanePos) * step(lanePos, LANES - 0.5);
        float dash = step(0.42, fract(vS / 3.2));
        float pulse = 0.65 + 0.9 * uBeat;
        col += hc * line * inner * dash * 0.6 * pulse;
        col += hc * line * (1.0 - inner) * 1.15 * pulse;

        float gs = vS / 12.0;
        float gfw = fwidth(gs);
        float gd = abs(fract(gs) - 0.5);
        col += hc * smoothstep(0.5 - gfw * 1.5, 0.5, gd) * 0.16;

        float margin = 1.0 - smoothstep(0.0, EDGE, min(u, 1.0 - u));
        col += hc * margin * 0.3;

        // The kicks' ripples cross the road as bands of light; backbeats flash its edges.
        float glow = roadGlow(vS);
        col += mix(hc, vec3(1.0, 0.97, 0.92), 0.65) * glow * (0.45 + 1.2 * line + 0.5 * margin);
        col += hc * uBackbeat * (line * (1.0 - inner) * 1.2 + margin * 0.4);

        float ahead = vUv.y - uTime;
        float du = (u - uShipU) * 22.0;
        float spot = exp(-du * du) * exp(-ahead * ahead * 2500.0);
        col += hc * spot * 0.5;

        col = mix(col, uFogColor, fogFactor(vDepth));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const additive = {
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  };

  const rail = new THREE.ShaderMaterial({
    ...additive,
    uniforms: shared,
    vertexShader: /* glsl */ `
      attribute float aH;
      attribute float aI;
      attribute float aS;
      attribute float aX;
      varying float vH;
      varying float vI;
      varying float vGlow;
      varying float vDepth;
      ${ROAD_PULSE_GLSL}
      void main() {
        vH = aH;
        vI = aI;
        vGlow = roadGlow(aS);
        vec3 p = position;
        p.y += roadLift(aS, aX);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uBeat;
      uniform float uOverdrive;
      uniform float uBackbeat;
      varying float vH;
      varying float vI;
      varying float vGlow;
      varying float vDepth;
      ${HEAT_GLSL}
      ${FOG_GLSL}
      void main() {
        vec3 hc = mix(heat(vI), vec3(1.0, 0.82, 0.4), uOverdrive * 0.75);
        float a = pow(clamp(1.0 - vH, 0.0, 1.0), 1.6);
        vec3 col = hc * a * (0.5 + 0.8 * uBeat + 1.5 * uBackbeat) + mix(hc, vec3(1.0, 0.97, 0.92), 0.65) * a * 1.4 * vGlow;
        col *= 1.0 - fogFactor(vDepth);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const pylon = new THREE.ShaderMaterial({
    ...additive,
    uniforms: shared,
    vertexShader: /* glsl */ `
      attribute float aH;
      attribute float aI;
      attribute float aS;
      attribute float aX;
      varying float vH;
      varying float vI;
      varying float vDepth;
      ${ROAD_PULSE_GLSL}
      void main() {
        vH = aH;
        vI = aI;
        vec3 p = position;
        p.y += roadLift(aS, aX) * (1.0 - aH); // the top stays on the road's edge
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOverdrive;
      varying float vH;
      varying float vI;
      varying float vDepth;
      ${HEAT_GLSL}
      ${FOG_GLSL}
      void main() {
        vec3 hc = mix(heat(vI), vec3(1.0, 0.82, 0.4), uOverdrive * 0.75);
        vec3 col = hc * pow(clamp(1.0 - vH, 0.0, 1.0), 2.5) * 0.55;
        col *= 1.0 - fogFactor(vDepth);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const bar = new THREE.ShaderMaterial({
    uniforms: { ...shared, uSpectrum: U.uSpectrum },
    vertexShader: /* glsl */ `
      attribute float aBand;
      uniform sampler2D uSpectrum;
      uniform float uBeat;
      varying float vLevel;
      varying float vY;
      varying float vBand;
      varying float vDepth;
      varying vec3 vN;
      varying vec2 vUv;
      void main() {
        float level = texture2D(uSpectrum, vec2(aBand, 0.5)).r;
        vLevel = level;
        vBand = aBand;
        vY = position.y;
        vN = normal;
        vUv = uv;
        vec3 p = position;
        p.y *= 0.2 + level * 1.5 + uBeat * 0.08;
        vec4 mv = modelViewMatrix * instanceMatrix * vec4(p, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uOverdrive;
      varying float vLevel;
      varying float vY;
      varying float vBand;
      varying float vDepth;
      varying vec3 vN;
      varying vec2 vUv;
      ${FOG_GLSL}
      void main() {
        vec3 base = mix(vec3(1.0, 0.25, 0.7), vec3(0.2, 0.75, 1.0), vBand);
        base = mix(base, vec3(1.0, 0.8, 0.35), uOverdrive * 0.6);
        float side = 0.55 + 0.45 * abs(vN.x);
        float top = step(0.999, vY);
        vec3 col = base * (0.012 + 0.22 * vLevel * vY * vY) * side;
        float edge = 1.0 - smoothstep(0.0, 0.07, min(vUv.x, 1.0 - vUv.x));
        col += base * edge * (0.12 + 0.9 * vLevel) * (0.3 + 0.7 * vY);
        col += base * step(0.9, fract(vY * 16.0)) * vLevel * 0.25;
        col += base * top * (0.35 + 1.8 * vLevel);
        col = mix(col, uFogColor, fogFactor(vDepth));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const gate = new THREE.ShaderMaterial({
    ...additive,
    uniforms: shared,
    vertexShader: /* glsl */ `
      attribute float aT;
      attribute float aI;
      attribute float aS;
      varying float vT;
      varying float vI;
      varying float vGlow;
      varying float vDepth;
      ${ROAD_PULSE_GLSL}
      void main() {
        vT = aT;
        vI = aI;
        vGlow = roadGlow(aS);
        vec3 p = position;
        p.y += roadLift(aS, 0.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uBeat;
      uniform float uOverdrive;
      varying float vT;
      varying float vI;
      varying float vGlow;
      varying float vDepth;
      ${HEAT_GLSL}
      ${FOG_GLSL}
      void main() {
        vec3 hc = mix(heat(vI), vec3(1.0, 0.82, 0.4), uOverdrive * 0.75);
        float flash = exp(-abs(uTime - vT) * 5.0);
        vec3 col = hc * (0.9 + 0.8 * uBeat + 3.0 * flash + 1.2 * vGlow);
        col *= 1.0 - fogFactor(vDepth);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const deco = new THREE.LineBasicMaterial({
    color: new THREE.Color(0.32, 0.16, 0.6),
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
  });

  return { surface, rail, pylon, bar, gate, deco };
}
