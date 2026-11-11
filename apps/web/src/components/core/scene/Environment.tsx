"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { createCoreMaterial, useCore, useDisposable } from "./context";
import { HELPERS, OUTPUT, SHARED_UNIFORMS_GLSL } from "./shaders/common";

/** Holographic polar floor grid that grounds the core in space, plus the scene lights. */

const floorVert = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const floorFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
varying vec2 vLocal;
void main() {
  float r = length(vLocal);
  float a = atan(vLocal.y, vLocal.x) / TAU + 0.5;
  float fwr = fwidth(r);
  float rings = 1.0 - smoothstep(0.0, fwr * 1.5, abs(fract(r / 0.55 + 0.5) - 0.5) * 0.55);
  float fa = min(fwidth(a), fwidth(fract(a + 0.5))) * 48.0;
  float spokes = 1.0 - smoothstep(0.0, fa * 1.5, abs(fract(a * 48.0 + 0.5) - 0.5));
  spokes *= smoothstep(1.2, 2.2, r);
  float grid = max(rings * 0.8, spokes * 0.4);
  float fade = pow(smoothstep(6.2, 1.0, r), 1.6) * smoothstep(0.6, 1.6, r);
  // slow outward scan pulse
  float scan = exp(-pow((r - mod(uTime * 0.9, 10.0)) * 2.2, 2.0)) * 0.6;
  float pool = exp(-r * r * 0.35) * 0.5;
  vec3 col = uPrimary * (grid * (0.07 + scan * 0.5) * fade + pool * 0.12) * uBright;
  col = desaturate(col, uSat);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
}`;

export const FLOOR_Y = -2.85;

export function Floor() {
  const { uniforms } = useCore();
  const geo = useDisposable(() => new THREE.PlaneGeometry(20, 20, 1, 1), []);
  const mat = useDisposable(
    () => createCoreMaterial(uniforms, { vertexShader: floorVert, fragmentShader: floorFrag }),
    [uniforms],
  );
  return <mesh geometry={geo} material={mat} rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y, 0]} renderOrder={-5} />;
}

export function Lights() {
  const { drive } = useCore();
  const point = useRef<THREE.PointLight>(null);
  const rim = useRef<THREE.DirectionalLight>(null);
  useFrame(() => {
    const p = point.current;
    if (!p) return;
    p.color.setRGB(drive.primary[0], drive.primary[1], drive.primary[2], THREE.LinearSRGBColorSpace);
    const audio = drive.level * (drive.listen + drive.speak) * 0.6;
    p.intensity = 26 * drive.brightness * (0.55 + drive.energy * 0.7 + audio) * (1 - drive.offline * 0.7);
    if (rim.current) rim.current.intensity = 0.9 * (1 - drive.offline * 0.5);
  });
  return (
    <>
      <ambientLight intensity={0.05} />
      <pointLight ref={point} position={[0, 0, 0]} distance={0} decay={2} />
      <directionalLight ref={rim} position={[-4, 5, -6]} color="#c4f1ff" />
      <directionalLight position={[5, 2, 6]} intensity={0.25} color="#8b7bff" />
    </>
  );
}
