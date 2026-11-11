"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { steppedAngle } from "../logic/damping";
import { createCoreMaterial, useCore, useDisposable, type SharedUniforms } from "./context";
import { AA, DEPTH_FADE, HELPERS, OUTPUT, SHARED_UNIFORMS_GLSL } from "./shaders/common";

export const RING_KIND = { ticks: 0, segments: 1, dashed: 2, cursor: 3, lock: 4, path: 5 } as const;

const ringVert = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
uniform float uSeed;
varying vec2 vLocal;
varying float vViewZ;
void main() {
  vec3 p = position;
  // ERROR glitch: momentary angular slip
  float slip = (hash11(floor(uTime * 30.0) + uSeed * 17.0) - 0.5) * 0.25 * uGlitch;
  float c = cos(slip), s = sin(slip);
  p.xy = mat2(c, s, -s, c) * p.xy;
  vLocal = position.xy;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewZ = mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const ringFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
${AA}
${DEPTH_FADE}
uniform float uInner;
uniform float uOuter;
uniform float uKind;
uniform float uCount;
uniform float uIntensity;
uniform float uSeed;
uniform float uColorMix;
varying vec2 vLocal;
varying float vViewZ;

// seam-safe angular derivative (atan wraps at a = 0/1)
float angFw(float a) { return min(fwidth(a), fwidth(fract(a + 0.5))); }

void main() {
  float r = length(vLocal);
  float rn = (r - uInner) / (uOuter - uInner);
  float a = atan(vLocal.y, vLocal.x) / TAU + 0.5;
  float fwa = angFw(a);
  float cell = a * uCount;
  float fwc = fwa * uCount;
  float idx = floor(cell);
  float fc = fract(cell);
  float v = 0.0;
  float hot = 0.0;
  int kind = int(uKind + 0.5);

  if (kind == 0) {
    // hairline + minor / major tick marks
    float base = aaBand(rn, 0.04, 0.035);
    float major = 1.0 - step(0.5, mod(idx, 5.0));
    float len = mix(0.42, 1.0, major);
    float tick = 1.0 - smoothstep(0.1, 0.1 + fwc * 1.5, abs(fc - 0.5));
    tick *= 1.0 - smoothstep(len - 0.04, len, rn);
    v = max(base * 0.8, tick * mix(0.55, 1.0, major));
    // THINKING: a sweep that brightens ticks as it passes
    float sweep = fract(a - uOrbit * 0.35);
    hot = tick * pow(sweep, 18.0) * (uThink + uExec * 0.5) * 2.5;
  } else if (kind == 1) {
    // segmented arcs
    float gap = 0.16;
    float seg = 1.0 - smoothstep(0.5 - gap * 0.5 - fwc, 0.5 - gap * 0.5, abs(fc - 0.5));
    float band = aaBand(rn, 0.5, 0.36);
    float rnd = hash11(idx + uSeed * 13.1);
    float bright = 0.2 + 0.55 * step(0.62, rnd);
    // EXECUTING: segments light sequentially
    float head = floor(fract(uTime * 0.42 + uSeed) * uCount);
    float k = mod(head - idx + uCount, uCount);
    float seq = exp(-k * 0.38) * uExec;
    // THINKING: random firing
    float flick = step(0.84, hash11(idx * 1.7 + floor(uPulseClock * 5.0) + uSeed)) * uThink;
    // ERROR: alternating warning blink
    float blink = mix(1.0, 0.25 + 0.75 * step(0.5, fract(uTime * 1.4 + mod(idx, 2.0) * 0.5)), uError);
    // OFFLINE: broken, missing segments
    float alive = mix(1.0, step(0.5, rnd) * 0.6, uOffline);
    float edges = (aaBand(rn, 0.0, 0.02) + aaBand(rn, 1.0, 0.02)) * 0.25 * seg;
    v = (seg * band * bright + edges) * blink * alive;
    hot = seg * band * (seq * 2.6 + flick * 1.6) * alive;
  } else if (kind == 2) {
    float line = aaBand(rn, 0.5, 0.42);
    float dash = 1.0 - smoothstep(0.55 - fwc, 0.55, fc);
    float alive = mix(1.0, step(0.35, hash11(floor(a * 12.0) + uSeed)), uOffline);
    v = line * dash * 0.85 * alive;
  } else if (kind == 3) {
    // hairline with travelling cursor arcs
    float line = aaBand(rn, 0.5, 0.18) * 0.55;
    float arcs = 0.0;
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float dir = mod(fi, 2.0) * 2.0 - 1.0;
      float c = fract(uOrbit * (0.05 + fi * 0.03) * dir + fi * 0.37 + uSeed);
      float da = abs(fract(a - c + 0.5) - 0.5);
      float len = 0.025 + fi * 0.018;
      arcs += (1.0 - smoothstep(len, len + fwa * 1.5, da)) * aaBand(rn, 0.5, 0.5);
    }
    v = line + arcs * 0.35;
    hot = arcs * (0.6 + uEnergy * 1.2);
  } else if (kind == 4) {
    // authorisation lock ring (gate)
    float rails = aaBand(rn, 0.05, 0.05) + aaBand(rn, 0.95, 0.05);
    float c4 = a * 4.0;
    float lockMark = 1.0 - smoothstep(0.035, 0.035 + fwa * 6.0, abs(fract(c4) - 0.5));
    float ticks = (1.0 - smoothstep(0.5 - fwa * 48.0, 0.5, fract(a * 48.0))) * aaBand(rn, 0.5, 0.2);
    v = (rails * 0.7 + ticks * 0.35);
    hot = lockMark * aaBand(rn, 0.5, 0.5) * 1.6 * (0.7 + 0.3 * sin(uTime * 2.4));
    v *= uGate;
    hot *= uGate;
  } else {
    // faint dashed orbit path
    float line = aaBand(rn, 0.5, 0.35);
    float dash = 1.0 - smoothstep(0.5 - fwc, 0.5, fc);
    v = line * dash * 0.5;
  }

  float fade = depthFade(vViewZ, 0.28);
  vec3 base = mix(uPrimary, uSecondary, uColorMix);
  vec3 col = base * v * uIntensity + mix(base, vec3(1.0), 0.35) * hot * uIntensity;
  col *= uBright * fade;
  col = desaturate(col, uSat);
  float alpha = clamp(max(v, hot), 0.0, 1.0);
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
}`;

export interface RingSpec {
  inner: number;
  outer: number;
  kind: number;
  count: number;
  intensity: number;
  colorMix?: number;
  seed: number;
  /** Euler tilt of the ring plane. */
  tilt: [number, number, number];
  /** Continuous rotation (multiplier of the integrated spin clock). */
  speed?: number;
  /** Mechanical stepped rotation instead of continuous. */
  stepped?: { interval: number; step: number };
}

export function createRingMaterial(shared: SharedUniforms, spec: RingSpec): THREE.ShaderMaterial {
  return createCoreMaterial(shared, {
    vertexShader: ringVert,
    fragmentShader: ringFrag,
    side: THREE.DoubleSide,
    uniforms: {
      uInner: { value: spec.inner },
      uOuter: { value: spec.outer },
      uKind: { value: spec.kind },
      uCount: { value: spec.count },
      uIntensity: { value: spec.intensity },
      uSeed: { value: spec.seed },
      uColorMix: { value: spec.colorMix ?? 0 },
    },
  });
}

const TAU = Math.PI * 2;

export const RING_SPECS: RingSpec[] = [
  // inner tick collar
  { inner: 1.24, outer: 1.34, kind: RING_KIND.ticks, count: 120, intensity: 0.9, seed: 0.11, tilt: [1.18, 0, 0.12], speed: 0.32 },
  // segmented arcs — stepped, mechanical
  {
    inner: 1.47,
    outer: 1.53,
    kind: RING_KIND.segments,
    count: 36,
    intensity: 1,
    seed: 0.37,
    tilt: [0.28, 0.42, 0],
    stepped: { interval: 1.8, step: (TAU / 36) * 3 },
  },
  // dashed thin ring
  { inner: 1.715, outer: 1.728, kind: RING_KIND.dashed, count: 96, intensity: 0.75, colorMix: 0.6, seed: 0.53, tilt: [1.0, -0.45, 0.32], speed: -0.42 },
  // cursor hairline
  { inner: 2.16, outer: 2.2, kind: RING_KIND.cursor, count: 1, intensity: 0.9, seed: 0.71, tilt: [1.44, 0, -0.14], speed: 0.12 },
  // equatorial HUD plane: fine ticks + outer segmented band
  { inner: 2.6, outer: 2.67, kind: RING_KIND.ticks, count: 240, intensity: 0.42, colorMix: 0.25, seed: 0.23, tilt: [1.4, 0, 0.06], speed: -0.06 },
  {
    inner: 2.86,
    outer: 2.9,
    kind: RING_KIND.segments,
    count: 72,
    intensity: 0.6,
    colorMix: 0.15,
    seed: 0.89,
    tilt: [1.4, 0, 0.06],
    stepped: { interval: 2.6, step: -(TAU / 72) * 4 },
  },
];

function Ring({ spec, segments }: { spec: RingSpec; segments: number }) {
  const { uniforms, drive } = useCore();
  const mesh = useRef<THREE.Mesh>(null);
  const geo = useDisposable(
    () => new THREE.RingGeometry(spec.inner, spec.outer, segments, 1),
    [spec.inner, spec.outer, segments],
  );
  const mat = useDisposable(() => createRingMaterial(uniforms, spec), [uniforms, spec]);

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    if (spec.stepped) {
      m.rotation.z = steppedAngle(drive.orbit * 1.6 + drive.time * 0.15, spec.stepped.interval, spec.stepped.step);
    } else {
      m.rotation.z = drive.orbit * (spec.speed ?? 0);
    }
  });

  return (
    <group rotation={spec.tilt}>
      <mesh ref={mesh} geometry={geo} material={mat} renderOrder={2} />
    </group>
  );
}

export function Rings() {
  const { preset } = useCore();
  const specs = useMemo(() => RING_SPECS, []);
  return (
    <group>
      {specs.map((s) => (
        <Ring key={s.seed} spec={s} segments={preset.ringSegments} />
      ))}
    </group>
  );
}
