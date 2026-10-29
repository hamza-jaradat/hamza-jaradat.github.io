// Bloom plus a final pass for chromatic aberration, vignette and hit flashes.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAberration: { value: 0.0 },
    uVignette: { value: 0.9 },
    uFlash: { value: 0.0 },
    uFlashColor: { value: new THREE.Color(1, 0.1, 0.15) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAberration;
    uniform float uVignette;
    uniform float uFlash;
    uniform vec3 uFlashColor;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      float d = dot(c, c);
      vec2 off = c * uAberration * (0.3 + d * 3.0);
      vec3 col = vec3(
        texture2D(tDiffuse, vUv + off).r,
        texture2D(tDiffuse, vUv).g,
        texture2D(tDiffuse, vUv - off).b
      );
      col *= 1.0 - uVignette * smoothstep(0.12, 0.7, d * 1.4);
      col += uFlashColor * uFlash * smoothstep(0.02, 0.45, d);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    // Sized in CSS pixels: the composer applies the pixel ratio itself in setSize().
    const size = renderer.getSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new RenderPass(scene, camera);
    // Threshold is in linear HDR luminance: only the neon (>~0.7) should glow, not the haze.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 1.0, 0.5, 0.7);
    this.output = new OutputPass();
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.output);
    this.composer.addPass(this.final);
    this.baseBloom = 0.8;
    this.flash = 0;
    this.aberration = 0;
  }

  setQuality(high) {
    this.bloom.enabled = high;
    this.baseBloom = high ? 0.8 : 0;
  }

  setSize(w, h, pr) {
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
  }

  hit(color = [1, 0.1, 0.15], strength = 1) {
    this.flash = Math.max(this.flash, 0.55 * strength);
    this.aberration = Math.max(this.aberration, 0.035 * strength);
    this.final.uniforms.uFlashColor.value.setRGB(color[0], color[1], color[2]);
  }

  update(dt, { beat = 0, overdrive = 0, intensity = 0, tension = 0 } = {}) {
    this.flash = Math.max(0, this.flash - dt * 2.2);
    this.aberration = Math.max(0, this.aberration - dt * 0.09);
    const u = this.final.uniforms;
    u.uFlash.value = this.flash;
    u.uAberration.value = this.aberration + 0.0015 + beat * 0.003 + overdrive * 0.004 + tension * 0.004;
    u.uVignette.value = 0.9 + 0.35 * tension;
    this.bloom.strength = this.baseBloom * (0.9 - 0.15 * intensity + 0.3 * beat + 0.2 * overdrive + 0.25 * tension);
  }

  render(dt) {
    this.composer.render(dt);
  }
}
