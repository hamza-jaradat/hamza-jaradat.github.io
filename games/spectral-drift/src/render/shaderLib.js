// Shared GLSL snippets and the matching JS color helpers.

export const HEAT_GLSL = /* glsl */ `
vec3 heat(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 c0 = vec3(0.10, 0.45, 1.00);
  vec3 c1 = vec3(0.55, 0.25, 1.00);
  vec3 c2 = vec3(1.00, 0.22, 0.62);
  vec3 c3 = vec3(1.00, 0.50, 0.15);
  vec3 c4 = vec3(1.00, 0.86, 0.35);
  if (x < 0.25) return mix(c0, c1, x * 4.0);
  if (x < 0.5) return mix(c1, c2, (x - 0.25) * 4.0);
  if (x < 0.75) return mix(c2, c3, (x - 0.5) * 4.0);
  return mix(c3, c4, (x - 0.75) * 4.0);
}
`;

export const FOG_GLSL = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogDensity;
float fogFactor(float depth) {
  float d = uFogDensity * depth;
  return 1.0 - exp(-d * d);
}
`;

const HEAT_STOPS = [
  [0.1, 0.45, 1.0],
  [0.55, 0.25, 1.0],
  [1.0, 0.22, 0.62],
  [1.0, 0.5, 0.15],
  [1.0, 0.86, 0.35],
];

export function heatRGB(x) {
  x = Math.min(1, Math.max(0, x)) * 4;
  const i = Math.min(3, Math.floor(x));
  const a = x - i;
  const p = HEAT_STOPS[i];
  const q = HEAT_STOPS[i + 1];
  return [p[0] + (q[0] - p[0]) * a, p[1] + (q[1] - p[1]) * a, p[2] + (q[2] - p[2]) * a];
}

export function heatCSS(x, alpha = 1) {
  const [r, g, b] = heatRGB(x);
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
}

// Note colors per intensity tier; power notes are white-gold.
export const TIER_RGB = [
  [0.25, 0.85, 1.0],
  [0.62, 0.4, 1.0],
  [1.0, 0.32, 0.72],
  [1.0, 0.62, 0.2],
];
export const POWER_RGB = [1.0, 0.92, 0.55];
export const HAZARD_RGB = [1.0, 0.12, 0.18];
