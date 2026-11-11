"use client";

/* eslint-disable react-hooks/immutability -- R3F idiom: three.js objects, uniforms and the DOM bridge are mutated
   imperatively inside frame callbacks/effects by design (no per-frame React state). */
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { CAMERA_FOV } from "../logic/camera";
import { createCoreMaterial, useCore, useDisposable } from "./context";
import { DEPTH_FADE, HELPERS, OUTPUT, SHARED_UNIFORMS_GLSL } from "./shaders/common";

/**
 * GPU particle system. Every particle's position is computed in the vertex
 * shader from static attributes and integrated clocks, so the CPU never
 * touches particle data after creation.
 *
 * kind 0: orbital band particle, kind 1: spiral data stream, kind 2: depth dust
 */

const vert = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
${DEPTH_FADE}
uniform float uViewport;
attribute vec4 aA; // radius, phase, speed, size
attribute vec4 aB; // tilt x, y, z, kind
attribute vec3 aC; // thickness offset, hue, seed
varying vec3 vColor;
varying float vAlpha;

mat3 tiltMatrix(vec3 e) {
  float cx = cos(e.x), sx = sin(e.x), cy = cos(e.y), sy = sin(e.y), cz = cos(e.z), sz = sin(e.z);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cx, sx, 0.0, -sx, cx);
  mat3 ry = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  mat3 rz = mat3(cz, sz, 0.0, -sz, cz, 0.0, 0.0, 0.0, 1.0);
  return rx * ry * rz;
}

void main() {
  float kind = aB.w;
  float seed = aC.z;
  vec3 p;
  float alpha = 1.0;
  float bright = 1.0;
  if (kind < 0.5) {
    float ang = aA.y + uParticleClock * aA.z;
    float rr = aA.x + sin(ang * 3.0 + seed * 20.0) * 0.035;
    rr += uLevel * uListen * 0.22 * sin(ang * 7.0 + uTime * 6.0 + seed * 30.0);
    rr *= 1.0 + uSpeak * (0.015 + uLevel * 0.07) * sin(aA.x * 5.0 - uTime * 7.0);
    p = tiltMatrix(aB.xyz) * vec3(cos(ang) * rr, sin(ang) * rr, aC.x);
    bright = 0.75 + 0.5 * hash11(seed * 91.0);
    bright *= 1.0 + uThink * 0.6 * step(0.7, hash11(seed * 13.0 + floor(uPulseClock * 4.0)));
  } else if (kind < 1.5) {
    // spiral stream: particles flow outward along curved arms, in packets
    float u = fract(seed + uParticleClock * aA.z * 0.16);
    float rr = mix(1.05, 3.15, u);
    float ang = aA.y + u * TAU * 0.9 + uParticleClock * 0.12;
    p = tiltMatrix(aB.xyz) * vec3(cos(ang) * rr, sin(ang) * rr, aC.x * (0.4 + u));
    alpha = sin(PI * u);
    float packet = step(0.5, aC.y);
    bright = 0.55 + packet * (0.4 + uExec * 3.4);
    alpha *= mix(1.0, mix(0.25, 1.0, packet), uExec);
  } else {
    // dust: slow far-field drift
    float th = aA.y + uParticleClock * 0.015 * aA.z;
    float ph = aB.x;
    p = aA.x * vec3(sin(ph) * cos(th), cos(ph) * 0.6, sin(ph) * sin(th));
    alpha = 0.5;
    bright = 0.55;
  }
  // ERROR: jitter
  p += (vec3(hash11(seed * 7.0 + uTime), hash11(seed * 5.0 - uTime), hash11(seed * 3.0 + uTime * 0.5)) - 0.5) * 0.12 * uGlitch;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float size = aA.w * (1.0 + uEnergy * 0.35 + uLevel * (uListen + uSpeak) * 0.5);
  gl_PointSize = clamp(size * uViewport / -mv.z, 1.0, 64.0);
  float fade = kind > 1.5 ? smoothstep(4.0, 9.0, -mv.z) : depthFade(mv.z, 0.22);
  vec3 col = mix(uPrimary, uSecondary, aC.y);
  if (kind > 1.5) col = mix(col, vec3(0.55, 0.7, 0.85), 0.5);
  vColor = desaturate(col * bright * uBright, uSat);
  vAlpha = alpha * fade * (1.0 - uOffline * 0.55);
}`;

const frag = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  if (d > 1.0) discard;
  float soft = 1.0 - smoothstep(0.0, 1.0, d);
  float core = 1.0 - smoothstep(0.0, 0.35, d);
  float a = (soft * soft * 0.55 + core * 0.6) * vAlpha;
  gl_FragColor = vec4(vColor, a);
  ${OUTPUT}
}`;

interface Band {
  r: number;
  spread: number;
  thickness: number;
  tilt: [number, number, number];
  speed: number;
  weight: number;
  kind: 0 | 1;
  hue: number;
}

const BANDS: Band[] = [
  { r: 1.13, spread: 0.04, thickness: 0.03, tilt: [1.18, 0, 0.12], speed: 0.9, weight: 0.13, kind: 0, hue: 0.2 },
  { r: 1.66, spread: 0.07, thickness: 0.05, tilt: [0.28, 0.42, 0], speed: -0.65, weight: 0.12, kind: 0, hue: 0.5 },
  { r: 2.1, spread: 0.24, thickness: 0.06, tilt: [1.4, 0, 0.06], speed: 0.42, weight: 0.2, kind: 0, hue: 0.1 },
  { r: 2.42, spread: 0.05, thickness: 0.03, tilt: [0.36, -0.62, 0.18], speed: -0.38, weight: 0.08, kind: 0, hue: 0.7 },
  { r: 0, spread: 0, thickness: 0.08, tilt: [1.4, 0, 0.06], speed: 1, weight: 0.27, kind: 1, hue: 0.3 },
  // sparse volumetric sprinkle between the shells
  { r: 2.0, spread: 1.0, thickness: 0.6, tilt: [0, 0, 0], speed: 0.25, weight: 0.14, kind: 0, hue: 0.6 },
];

function gaussian(rand: () => number) {
  const u = Math.max(1e-6, rand());
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildParticleGeometry(count: number, dust: number): THREE.BufferGeometry {
  const rand = mulberry32(1337);
  const total = count + dust;
  const A = new Float32Array(total * 4);
  const B = new Float32Array(total * 4);
  const C = new Float32Array(total * 3);
  const totalWeight = BANDS.reduce((s, b) => s + b.weight, 0);
  let i = 0;
  for (const band of BANDS) {
    const n = Math.round((band.weight / totalWeight) * count);
    const packets = 9;
    for (let k = 0; k < n && i < count; k++, i++) {
      const sprinkle = band.spread >= 1;
      const tilt: [number, number, number] = sprinkle
        ? [rand() * Math.PI, rand() * Math.PI, rand() * Math.PI]
        : band.tilt;
      const radius = sprinkle ? 1.15 + rand() * 2.1 : band.r + gaussian(rand) * band.spread;
      A.set([radius, rand() * Math.PI * 2, band.speed * (0.85 + rand() * 0.3), 0.022 + rand() * 0.03], i * 4);
      B.set([tilt[0], tilt[1], tilt[2], band.kind], i * 4);
      let seed = rand();
      let hue = Math.min(1, Math.max(0, band.hue + (rand() - 0.5) * 0.5));
      if (band.kind === 1) {
        // half the stream particles are clustered into packets (hue slot reused as packet flag)
        const packet = rand() < 0.5;
        const arm = Math.floor(rand() * 3);
        A[i * 4 + 1] = (arm / 3) * Math.PI * 2 + (rand() - 0.5) * 0.12;
        A[i * 4 + 2] = 1;
        seed = packet ? Math.floor(rand() * packets) / packets + rand() * 0.012 : rand();
        hue = packet ? 1 : 0;
      }
      C.set([gaussian(rand) * band.thickness, hue, seed], i * 3);
    }
  }
  // fill rounding remainder as sprinkle
  for (; i < count; i++) {
    A.set([1.2 + rand() * 2, rand() * Math.PI * 2, 0.3, 0.025], i * 4);
    B.set([rand() * Math.PI, rand() * Math.PI, 0, 0], i * 4);
    C.set([0, rand(), rand()], i * 3);
  }
  for (let d = 0; d < dust; d++, i++) {
    A.set([6 + rand() * 9, rand() * Math.PI * 2, 0.5 + rand(), 0.03 + rand() * 0.05], i * 4);
    B.set([0.35 + rand() * 2.4, 0, 0, 2], i * 4);
    C.set([0, rand(), rand()], i * 3);
  }
  const g = new THREE.BufferGeometry();
  // position is required by three for draw range / bounding sphere; real positions are computed on the GPU
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(total * 3), 3));
  g.setAttribute("aA", new THREE.BufferAttribute(A, 4));
  g.setAttribute("aB", new THREE.BufferAttribute(B, 4));
  g.setAttribute("aC", new THREE.BufferAttribute(C, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 16);
  return g;
}

export function Particles() {
  const { uniforms, preset } = useCore();
  const geo = useDisposable(() => buildParticleGeometry(preset.particles, preset.dust), [preset.particles, preset.dust]);
  const mat = useDisposable(
    () =>
      createCoreMaterial(uniforms, {
        vertexShader: vert,
        fragmentShader: frag,
        uniforms: { uViewport: { value: 500 } },
      }),
    [uniforms],
  );

  useFrame((state) => {
    const h = state.size.height * state.viewport.dpr;
    (mat.uniforms.uViewport as THREE.IUniform<number>).value = h / (2 * Math.tan((CAMERA_FOV * Math.PI) / 360));
  });

  return <points geometry={geo} material={mat} frustumCulled={false} renderOrder={3} />;
}
