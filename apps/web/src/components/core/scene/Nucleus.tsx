"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard } from "@react-three/drei";
import * as THREE from "three";
import { breathScale } from "../logic/driver";
import { createCoreMaterial, useCore, useDisposable } from "./context";
import { DEPTH_FADE, HELPERS, OUTPUT, SHARED_UNIFORMS_GLSL, SIMPLEX_3D } from "./shaders/common";

const PRELUDE = SHARED_UNIFORMS_GLSL + HELPERS + SIMPLEX_3D;

/* ------------------------------------------------------------------ */
/* Hot inner core — opaque, drawn first, seen through the membrane      */
/* ------------------------------------------------------------------ */
const innerVert = /* glsl */ `
${PRELUDE}
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main() {
  vP = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const innerFrag = /* glsl */ `
${PRELUDE}
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main() {
  float fres = 1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
  float churn = snoise(vP * 3.4 + vec3(0.0, uFlow * 0.9, uFlow * 0.5));
  vec3 hot = mix(uPrimary, vec3(1.0), 0.35);
  vec3 col = mix(hot * 2.8, uPrimary * 0.45, smoothstep(0.0, 0.95, fres));
  col *= 0.78 + churn * 0.3;
  float audio = uLevel * (uListen + uSpeak);
  float flash = uShock >= 0.0 ? pow(1.0 - uShock, 3.0) * 1.6 : 0.0;
  col *= uBright * (1.0 + audio * 0.9 + flash);
  col = desaturate(col, uSat);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
}`;

/* ------------------------------------------------------------------ */
/* Plasma membrane — displaced, flowing veins, fresnel rim              */
/* ------------------------------------------------------------------ */
const membraneVert = /* glsl */ `
${PRELUDE}
varying vec3 vN; varying vec3 vV; varying vec3 vP; varying float vDisp;
void main() {
  vec3 n = normalize(normal);
  float t = uFlow;
  float d = snoise(n * 1.6 + vec3(0.0, t * 0.32, t * 0.21)) * 0.06
          + snoise(n * 4.2 - vec3(t * 0.4)) * 0.018;
  d *= uDisplace;
  // LISTENING: spiky, mic-reactive surface
  float sp = max(0.0, snoise(n * 3.0 + vec3(uTime * 1.3, 0.0, uTime * 0.7)));
  d += (sp * sp * 0.3 + 0.025) * uLevel * uListen;
  // SPEAKING: concentric ripples travelling outward from the camera-facing pole
  vec3 nv = normalize(normalMatrix * n);
  float ang = acos(clamp(nv.z, -1.0, 1.0));
  d += sin(ang * 10.0 - uTime * 9.0) * (0.02 + uLevel * 0.085) * uSpeak * smoothstep(2.6, 0.2, ang);
  vec3 p = position + n * d;
  // ERROR: horizontal slice glitch
  float slice = floor((position.y + 1.0) * 8.0);
  float g = step(0.55, hash11(slice + floor(uTime * 30.0))) * uGlitch;
  p.x += (hash11(slice * 3.7 + floor(uTime * 30.0)) - 0.5) * 0.22 * g;
  vDisp = d;
  vP = position;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vN = nv;
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const membraneFrag = /* glsl */ `
${PRELUDE}
varying vec3 vN; varying vec3 vV; varying vec3 vP; varying float vDisp;
void main() {
  float fres = 1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
  float t = uFlow;
  vec3 q = vP * 1.0;
  float f1 = snoise(q * 2.1 + vec3(0.0, t * 0.55, t * 0.3));
  float f2 = snoise(q * 4.6 - vec3(t * 0.45, 0.0, t * 0.35));
  float veins = pow(1.0 - abs(f1), 9.0) * 0.85 + pow(1.0 - abs(f2), 14.0) * 0.55;
  vec3 deep = uPrimary * 0.1;
  vec3 col = mix(deep, uPrimary * 0.55, smoothstep(0.15, 1.0, fres));
  col += mix(uPrimary, uSecondary, 0.5) * veins * (0.35 + uEnergy * 1.1) * (1.0 - fres * 0.6);
  col += mix(uPrimary, vec3(1.0), 0.3) * pow(fres, 3.2) * 1.5;
  col += uPrimary * max(vDisp, 0.0) * 5.0 * (uListen + uSpeak);
  col *= uBright;
  col = desaturate(col, uSat);
  float alpha = mix(0.6, 0.97, smoothstep(0.0, 0.85, fres)) + veins * 0.2;
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  ${OUTPUT}
}`;

/* ------------------------------------------------------------------ */
/* Geodesic shell — barycentric lattice, masked into drifting panels   */
/* ------------------------------------------------------------------ */
const shellVert = /* glsl */ `
${PRELUDE}
attribute vec3 aBary;
varying vec3 vB; varying vec3 vN; varying vec3 vV; varying vec3 vP; varying float vViewZ;
void main() {
  vB = aBary;
  vP = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewZ = mv.z;
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const shellFrag = /* glsl */ `
${PRELUDE}
${DEPTH_FADE}
varying vec3 vB; varying vec3 vN; varying vec3 vV; varying vec3 vP; varying float vViewZ;
void main() {
  float e = min(min(vB.x, vB.y), vB.z);
  float fw = fwidth(e);
  float edge = 1.0 - smoothstep(fw * 0.6, fw * 1.8, e);
  float nd = dot(normalize(vN), normalize(vV));
  float fres = 1.0 - abs(nd);
  // panels that drift across the shell
  float panel = smoothstep(0.1, 0.55, snoise(normalize(vP) * 1.8 + vec3(uFlow * 0.18, uFlow * 0.1, 0.0)));
  // THINKING: a scanning band sweeping the shell
  float scanY = sin(uTime * 1.7) * 1.05;
  float scan = exp(-pow((vP.y - scanY) * 7.0, 2.0)) * uThink;
  float a = edge * (0.08 + panel * 0.5 + scan * 1.2) * (0.25 + fres * 0.95);
  a += pow(fres, 4.0) * 0.12;
  a *= (gl_FrontFacing ? 1.0 : 0.35);
  a *= 1.0 - uOffline * 0.6;
  vec3 col = mix(uPrimary, uSecondary, panel * 0.4 + scan) * (0.9 + scan * 1.4) * uBright;
  col = desaturate(col, uSat);
  gl_FragColor = vec4(col, a);
  ${OUTPUT}
}`;

/* ------------------------------------------------------------------ */
/* Atmospheric halo behind the core (gives glow without heavy bloom)    */
/* ------------------------------------------------------------------ */
const haloVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const haloFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
varying vec2 vUv;
void main() {
  float r = length(vUv);
  float glow = exp(-r * r * 14.0) * 0.32 + exp(-r * r * 4.0) * 0.05;
  glow *= 1.0 - smoothstep(0.6, 1.0, r);
  float breathe = 0.85 + 0.15 * sin(uTime * 0.7);
  vec3 col = mix(uSecondary, uPrimary, 0.75) * glow * uBright * breathe * (0.55 + uEnergy * 0.6);
  col = desaturate(col, uSat);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
}`;

function makeShellGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1.06, 3);
  const count = g.getAttribute("position").count;
  const bary = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) bary[i * 3 + (i % 3)] = 1;
  g.setAttribute("aBary", new THREE.BufferAttribute(bary, 3));
  return g;
}

export function Nucleus() {
  const { uniforms, drive, preset } = useCore();
  const group = useRef<THREE.Group>(null);
  const membraneRef = useRef<THREE.Mesh>(null);
  const shellRef = useRef<THREE.Mesh>(null);

  const innerGeo = useDisposable(() => new THREE.IcosahedronGeometry(0.34, 8), []);
  const membraneGeo = useDisposable(
    () => new THREE.IcosahedronGeometry(0.8, preset.nucleusDetail),
    [preset.nucleusDetail],
  );
  const shellGeo = useDisposable(makeShellGeometry, []);
  const haloGeo = useDisposable(() => new THREE.PlaneGeometry(9, 9), []);

  const innerMat = useDisposable(
    () =>
      createCoreMaterial(uniforms, {
        vertexShader: innerVert,
        fragmentShader: innerFrag,
        transparent: false,
        depthWrite: true,
        blending: THREE.NormalBlending,
      }),
    [uniforms],
  );
  const membraneMat = useDisposable(
    () =>
      createCoreMaterial(uniforms, {
        vertexShader: membraneVert,
        fragmentShader: membraneFrag,
        transparent: true,
        depthWrite: true,
        blending: THREE.NormalBlending,
      }),
    [uniforms],
  );
  const shellMat = useDisposable(
    () =>
      createCoreMaterial(uniforms, {
        vertexShader: shellVert,
        fragmentShader: shellFrag,
        side: THREE.DoubleSide,
      }),
    [uniforms],
  );
  const haloMat = useDisposable(
    () => createCoreMaterial(uniforms, { vertexShader: haloVert, fragmentShader: haloFrag }),
    [uniforms],
  );

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    const audio = drive.level * (drive.listen * 0.16 + drive.speak * 0.08);
    const flash = drive.shock >= 0 ? Math.sin(Math.min(drive.shock * 4, 1) * Math.PI) * 0.06 : 0;
    const s = breathScale(drive) * (1 + audio + flash);
    g.scale.setScalar(s);
    if (membraneRef.current) membraneRef.current.rotation.y = drive.flow * 0.12;
    if (shellRef.current) {
      shellRef.current.rotation.y = -drive.orbit * 0.18;
      shellRef.current.rotation.x = drive.orbit * 0.05;
    }
  });

  return (
    <>
      <Billboard>
        <mesh geometry={haloGeo} material={haloMat} position={[0, 0, -2.2]} renderOrder={-10} />
      </Billboard>
      <group ref={group}>
        <mesh geometry={innerGeo} material={innerMat} />
        <mesh ref={membraneRef} geometry={membraneGeo} material={membraneMat} renderOrder={-1} />
        <mesh ref={shellRef} geometry={shellGeo} material={shellMat} renderOrder={1} />
      </group>
    </>
  );
}
