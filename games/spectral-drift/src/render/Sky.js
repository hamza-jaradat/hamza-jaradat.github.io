// Gradient sky dome, twinkling stars and a striped sun ringed by a live spectrum.
// All of it follows the camera, so it reads as infinitely far away.
import * as THREE from 'three';

const DOME_RADIUS = 1800;
const STAR_RADIUS = 1600;
const SUN_DISTANCE = 1500;
const GOLD_HAZE = new THREE.Color(0.16, 0.09, 0.015);

export class Sky {
  constructor(uniforms) {
    this.group = new THREE.Group();
    this.top = new THREE.Color();
    this.horizon = new THREE.Color();
    this.heading = new THREE.Vector3(0, 0, -1);
    this.sunDir = new THREE.Vector3();

    this.domeMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: this.top },
        uHorizon: { value: this.horizon },
        uBeat: uniforms.uBeat,
      },
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uHorizon;
        uniform float uBeat;
        varying vec3 vDir;
        void main() {
          float y = vDir.y;
          vec3 bottom = uHorizon * 0.12;
          vec3 c = y > 0.0 ? mix(uHorizon, uTop, pow(y, 0.45)) : mix(uHorizon, bottom, pow(-y, 0.3));
          c += uHorizon * exp(-abs(y) * 45.0) * (0.5 + 0.4 * uBeat);
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 16), this.domeMat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);

    this.stars = buildStars(uniforms);
    this.group.add(this.stars);

    this.sunColA = new THREE.Color(1.0, 0.85, 0.3);
    this.sunColB = new THREE.Color(1.0, 0.2, 0.55);
    this.sunMat = new THREE.ShaderMaterial({
      uniforms: {
        uBeat: uniforms.uBeat,
        uTime: uniforms.uClock,
        uSpectrum: uniforms.uSpectrum,
        uColA: { value: this.sunColA },
        uColB: { value: this.sunColB },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uBeat;
        uniform float uTime;
        uniform sampler2D uSpectrum;
        uniform vec3 uColA;
        uniform vec3 uColB;
        varying vec2 vUv;
        void main() {
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float R0 = 0.4;
          float disc = 1.0 - smoothstep(R0 - 0.006, R0, r);
          float y = p.y / R0;
          float cut = 1.0;
          if (y < 0.15) {
            float k = (0.15 - y) / 1.15;
            float s = fract(y * 7.0 + uTime * 0.25);
            cut = step(k * 0.75, s);
          }
          vec3 grad = mix(uColB, uColA, smoothstep(-R0, R0, p.y));
          vec3 col = grad * disc * cut * 0.8;
          col += mix(uColB, uColA, 0.4) * exp(-max(r - R0, 0.0) * 7.0) * (0.12 + 0.15 * uBeat) * (1.0 - disc);

          float ang = atan(p.y, p.x);
          float band = abs(ang) / 3.14159265;
          float lvl = texture2D(uSpectrum, vec2(band, 0.5)).r;
          float r0 = R0 + 0.06;
          float r1 = r0 + 0.015 + lvl * 0.22;
          float ring = step(r0, r) * (1.0 - smoothstep(r1 - 0.01, r1, r));
          float seg = step(0.25, fract(band * 40.0));
          col += mix(uColA, uColB, band) * ring * seg * (0.25 + 0.75 * lvl);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    this.sun = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.sunMat);
    this.sun.scale.setScalar(700);
    this.sun.renderOrder = -9;
    this.sun.frustumCulled = false;
    this.group.add(this.sun);
  }

  setPalette(intensity, overdrive) {
    // Linear values; the output pass converts to sRGB, which lifts darks a lot.
    const i = intensity;
    this.top.setRGB(0.002 + 0.002 * i, 0.0005, 0.008 + 0.004 * i);
    this.horizon.setRGB(0.04 + 0.1 * i, 0.008 + 0.01 * i, 0.075 - 0.02 * i);
    if (overdrive > 0) this.horizon.lerp(GOLD_HAZE, overdrive * 0.6);
    return this.horizon;
  }

  update(camera, forward, dt) {
    this.group.position.copy(camera.position);
    const h = this.heading;
    const fx = forward.x;
    const fz = forward.z;
    const len = Math.hypot(fx, fz) || 1;
    const k = 1 - Math.exp(-dt * 0.35);
    h.x += (fx / len - h.x) * k;
    h.z += (fz / len - h.z) * k;
    h.y = 0;
    h.normalize();
    this.sunDir.set(h.x, 0.1, h.z).normalize();
    this.sun.position.copy(this.sunDir).multiplyScalar(SUN_DISTANCE);
    this.sun.lookAt(camera.position);
  }

  snapHeading(forward) {
    this.heading.set(forward.x, 0, forward.z).normalize();
  }
}

function buildStars(uniforms) {
  const count = 1800;
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const y = Math.abs(u) * 0.95 + 0.02;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    pos.set([Math.cos(a) * r * STAR_RADIUS, y * STAR_RADIUS, Math.sin(a) * r * STAR_RADIUS], i * 3);
    seed[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: uniforms.uClock, uPixelRatio: uniforms.uPixelRatio },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vTw;
      varying float vSeed;
      void main() {
        vSeed = aSeed;
        vTw = 0.55 + 0.45 * sin(uTime * (1.5 + aSeed * 3.0) + aSeed * 50.0);
        gl_PointSize = (1.0 + aSeed * aSeed * 2.6) * uPixelRatio;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vTw;
      varying float vSeed;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = (1.0 - smoothstep(0.0, 0.5, d)) * vTw;
        vec3 c = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.75, 0.9), vSeed);
        gl_FragColor = vec4(c * a * 0.9, 1.0);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -9;
  return pts;
}
