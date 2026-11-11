"use client";

/* eslint-disable react-hooks/immutability -- R3F idiom: three.js objects, uniforms and the DOM bridge are mutated
   imperatively inside frame callbacks/effects by design (no per-frame React state). */
import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard } from "@react-three/drei";
import * as THREE from "three";
import { createCoreMaterial, useCore, useDisposable } from "./context";
import { createRingMaterial, RING_KIND } from "./Rings";
import { AA, HELPERS, OUTPUT, SHARED_UNIFORMS_GLSL } from "./shaders/common";

/**
 * State-specific layers. Each is hidden (no draw call) while its state
 * weight is ~0, and fades with the damped weight otherwise.
 */

const flatVert = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/* LISTENING — radial audio bars around the nucleus */
const BAR_INNER = 1.14;
const BAR_OUTER = 1.78;
const waveFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
${AA}
varying vec2 vLocal;
void main() {
  float r = length(vLocal);
  float rn = (r - ${BAR_INNER.toFixed(3)}) / ${(BAR_OUTER - BAR_INNER).toFixed(3)};
  float a = atan(vLocal.y, vLocal.x) / TAU + 0.5;
  float fwa = min(fwidth(a), fwidth(fract(a + 0.5)));
  float bars = 120.0;
  float cell = a * bars;
  float idx = floor(cell);
  float fc = fract(cell);
  float mask = 1.0 - smoothstep(0.2, 0.2 + fwa * bars * 1.5, abs(fc - 0.5));
  float sym = abs(fract(idx / bars + 0.25) - 0.5) * 2.0; // mirrored shape
  float n = 0.5 + 0.5 * sin(idx * 0.61 + uTime * 6.0) * sin(idx * 0.27 - uTime * 3.7 + sym * 4.0);
  float h = 0.03 + uLevel * (0.12 + 0.6 * n) * mix(0.55, 1.0, sym);
  float bar = mask * (1.0 - smoothstep(h - 0.015, h, rn)) * step(0.0, rn);
  float base = aaBand(rn, 0.0, 0.006) * 0.6;
  float v = (bar * (0.28 + rn * 1.1) + base) * uListen;
  vec3 col = mix(uPrimary, uSecondary, clamp(rn / max(h, 0.05), 0.0, 1.0)) * v * uBright;
  if (v < 0.002) discard;
  gl_FragColor = vec4(desaturate(col, uSat), 1.0);
  ${OUTPUT}
}`;

/* SPEAKING — expanding ripple rings, amplitude captured per ring at emission */
const RIPPLES = 5;
const RIPPLE_PERIOD = 2.4;
const rippleFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
uniform float uPhase[${RIPPLES}];
uniform float uAmp[${RIPPLES}];
varying vec2 vLocal;
void main() {
  float r = length(vLocal);
  float v = 0.0;
  for (int i = 0; i < ${RIPPLES}; i++) {
    float ph = uPhase[i];
    float e = 1.0 - pow(1.0 - ph, 2.0);
    float rr = mix(0.98, 3.4, e);
    float w = 0.01 + e * 0.035;
    float ring = exp(-pow((r - rr) / w, 2.0));
    v += ring * pow(1.0 - ph, 1.5) * uAmp[i];
  }
  v *= uSpeak;
  vec3 col = mix(uSecondary, uPrimary, 0.4) * v * 1.6 * uBright;
  if (v < 0.002) discard;
  gl_FragColor = vec4(desaturate(col, uSat), 1.0);
  ${OUTPUT}
}`;

/* WAITING_FOR_APPROVAL — iris blades that close into a lock ring */
const BLADES = 8;
const BLADE_INNER = 1.17;
const BLADE_OUTER = 1.3;
const BLADE_SPAN = (Math.PI * 2) / BLADES - 0.07;
const bladeVert = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
varying vec2 vL;
varying float vZ;
void main() {
  float open = 1.0 - smoothstep(0.0, 1.0, uGate);
  vec3 p = position;
  vL = p.xy;
  vZ = p.z;
  float tw = open * 0.85;
  float c = cos(tw), s = sin(tw);
  p.xy = mat2(c, s, -s, c) * p.xy;
  p.xy += normalize(p.xy) * open * 0.75;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(p, 1.0);
}`;
const bladeFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
varying vec2 vL;
varying float vZ;
void main() {
  float r = length(vL);
  float a = atan(vL.y, vL.x);
  float half_ = ${(BLADE_SPAN / 2).toFixed(4)};
  float fr = fwidth(r);
  float fa = fwidth(a);
  float edgeR = 1.0 - smoothstep(fr * 0.5, fr * 2.0, min(abs(r - ${BLADE_INNER.toFixed(3)}), abs(r - ${BLADE_OUTER.toFixed(3)})));
  float edgeA = 1.0 - smoothstep(fa * 0.5, fa * 2.0, half_ - abs(a));
  float edge = max(edgeR, edgeA);
  float grille = step(0.5, fract(r * 70.0)) * 0.18;
  float breathe = 0.75 + 0.25 * sin(uTime * 2.1);
  float v = (0.16 + grille + edge * 1.1) * breathe * uGate;
  vec3 col = mix(uPrimary, vec3(1.0, 0.92, 0.75), edge * 0.35) * v * uBright;
  gl_FragColor = vec4(desaturate(col, uSat), 1.0);
  ${OUTPUT}
}`;

/* SUCCESS — one controlled shockwave across the equatorial plane */
const shockFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
varying vec2 vLocal;
void main() {
  if (uShock < 0.0) discard;
  float r = length(vLocal);
  float p = uShock;
  float e = 1.0 - pow(1.0 - p, 3.0);
  float rr = mix(1.0, 6.2, e);
  float w = 0.03 + e * 0.16;
  float ring = exp(-pow((r - rr) / w, 2.0));
  float wake = smoothstep(rr - 1.6, rr, r) * step(r, rr) * 0.12;
  float p2 = clamp((p - 0.1) / 0.9, 0.0, 1.0);
  float e2 = 1.0 - pow(1.0 - p2, 3.0);
  float ring2 = exp(-pow((r - mix(1.0, 4.6, e2)) / (0.015 + e2 * 0.05), 2.0)) * step(0.0001, p2);
  float fade = pow(1.0 - p, 1.6);
  vec3 col = (mix(uPrimary, vec3(1.0), 0.45) * ring * 2.2 + uPrimary * wake + uSecondary * ring2 * 1.2) * fade * uBright;
  gl_FragColor = vec4(desaturate(col, uSat), 1.0);
  ${OUTPUT}
}`;

function useLayerMaterial(frag: string, vert = flatVert, extra?: Record<string, THREE.IUniform>) {
  const { uniforms } = useCore();
  return useDisposable(
    () => createCoreMaterial(uniforms, { vertexShader: vert, fragmentShader: frag, side: THREE.DoubleSide, uniforms: extra }),
    [uniforms, frag, vert],
  );
}

function ListeningBars() {
  const { drive } = useCore();
  const mesh = useRef<THREE.Mesh>(null);
  const geo = useDisposable(() => new THREE.RingGeometry(BAR_INNER - 0.01, BAR_OUTER, 240, 1), []);
  const mat = useLayerMaterial(waveFrag);
  useFrame(() => {
    if (mesh.current) mesh.current.visible = drive.listen > 0.004;
  });
  return <mesh ref={mesh} geometry={geo} material={mat} renderOrder={4} />;
}

function SpeakingRipples() {
  const { drive } = useCore();
  const mesh = useRef<THREE.Mesh>(null);
  const geo = useDisposable(() => new THREE.RingGeometry(0.9, 3.6, 200, 1), []);
  const mat = useLayerMaterial(rippleFrag, flatVert, {
    uPhase: { value: new Array<number>(RIPPLES).fill(0) },
    uAmp: { value: new Array<number>(RIPPLES).fill(0) },
  });
  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    m.visible = drive.speak > 0.004;
    if (!m.visible) return;
    const phases = mat.uniforms.uPhase!.value as number[];
    const amps = mat.uniforms.uAmp!.value as number[];
    for (let i = 0; i < RIPPLES; i++) {
      const ph = (drive.time / RIPPLE_PERIOD + i / RIPPLES) % 1;
      if (ph < (phases[i] ?? 0)) amps[i] = 0.12 + drive.level * 1.6; // new ripple born: capture amplitude
      phases[i] = ph;
    }
  });
  return <mesh ref={mesh} geometry={geo} material={mat} renderOrder={4} />;
}

function bladeGeometry() {
  const shape = new THREE.Shape();
  const h = BLADE_SPAN / 2;
  shape.absarc(0, 0, BLADE_OUTER, -h, h, false);
  shape.absarc(0, 0, BLADE_INNER, h, -h, true);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false, curveSegments: 24 });
  g.translate(0, 0, -0.015);
  return g;
}

function ApprovalGate() {
  const { drive, uniforms } = useCore();
  const group = useRef<THREE.Group>(null);
  const blades = useRef<THREE.InstancedMesh>(null);
  const geo = useDisposable(bladeGeometry, []);
  const mat = useLayerMaterial(bladeFrag, bladeVert);
  const lockGeo = useDisposable(() => new THREE.RingGeometry(1.36, 1.43, 256, 1), []);
  const lockMat = useDisposable(
    () =>
      createRingMaterial(uniforms, {
        inner: 1.36,
        outer: 1.43,
        kind: RING_KIND.lock,
        count: 1,
        intensity: 1,
        seed: 0.5,
        tilt: [0, 0, 0],
      }),
    [uniforms],
  );
  const lock = useRef<THREE.Mesh>(null);

  useEffect(() => {
    const m = new THREE.Matrix4();
    for (let i = 0; i < BLADES; i++) {
      m.makeRotationZ((i / BLADES) * Math.PI * 2 + Math.PI / BLADES);
      blades.current?.setMatrixAt(i, m);
    }
    if (blades.current) blades.current.instanceMatrix.needsUpdate = true;
  }, []);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.visible = drive.gate > 0.004;
    if (lock.current) lock.current.rotation.z = -drive.time * 0.12;
  });

  return (
    <group ref={group}>
      <instancedMesh ref={blades} args={[geo, mat, BLADES]} frustumCulled={false} renderOrder={4} />
      <mesh ref={lock} geometry={lockGeo} material={lockMat} renderOrder={4} />
    </group>
  );
}

function Shockwave() {
  const { drive } = useCore();
  const mesh = useRef<THREE.Mesh>(null);
  const geo = useDisposable(() => new THREE.RingGeometry(0.85, 6.8, 220, 1), []);
  const mat = useLayerMaterial(shockFrag);
  useFrame(() => {
    if (mesh.current) mesh.current.visible = drive.shock >= 0;
  });
  return (
    <group rotation={[1.4, 0, 0.06]}>
      <mesh ref={mesh} geometry={geo} material={mat} renderOrder={4} visible={false} />
    </group>
  );
}

export function StateLayers() {
  return (
    <>
      <Billboard>
        <ListeningBars />
        <SpeakingRipples />
        <ApprovalGate />
      </Billboard>
      <Shockwave />
    </>
  );
}
