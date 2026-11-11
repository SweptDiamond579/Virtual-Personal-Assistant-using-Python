/** Shared GLSL chunks. */

/** 3D simplex noise — Ashima Arts / Stefan Gustavson (MIT). */
export const SIMPLEX_3D = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

export const HELPERS = /* glsl */ `
#define PI 3.141592653589793
#define TAU 6.283185307179586
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec3 desaturate(vec3 c, float s) { float l = dot(c, vec3(0.2126, 0.7152, 0.0722)); return mix(vec3(l), c, s); }
`;

/** Fragment-only anti-aliasing helpers (use derivatives). */
export const AA = /* glsl */ `
// thin anti-aliased band centred on c with half-width w in units of v
float aaBand(float v, float c, float w) {
  float d = abs(v - c) - w;
  float fw = max(fwidth(v), 1e-5);
  return 1.0 - smoothstep(0.0, fw * 1.25, d);
}
`;

/** Uniform declarations shared by every core material. */
export const SHARED_UNIFORMS_GLSL = /* glsl */ `
uniform float uTime;
uniform float uOrbit;
uniform float uParticleClock;
uniform float uPulseClock;
uniform float uFlow;
uniform float uEnergy;
uniform float uLevel;
uniform float uListen;
uniform float uSpeak;
uniform float uThink;
uniform float uExec;
uniform float uGate;
uniform float uError;
uniform float uOffline;
uniform float uSuccess;
uniform float uPulses;
uniform float uSat;
uniform float uBright;
uniform float uGlitch;
uniform float uShock;
uniform float uDisplace;
uniform float uCamDist;
uniform float uPixelRatio;
uniform vec3 uPrimary;
uniform vec3 uSecondary;
`;

/** Depth cue: 1 for geometry on the near side of the core, fading toward the far side. */
export const DEPTH_FADE = /* glsl */ `
float depthFade(float viewZ, float minF) {
  float z = -viewZ - uCamDist;           // <0 in front of the core centre, >0 behind
  return mix(1.0, minF, smoothstep(-2.5, 3.0, z));
}
`;

/** Output with renderer tone mapping / colour space (no-ops inside the composer). */
export const OUTPUT = /* glsl */ `
#include <tonemapping_fragment>
#include <colorspace_fragment>
`;
