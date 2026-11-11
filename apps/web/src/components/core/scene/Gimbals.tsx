"use client";

/* eslint-disable react-hooks/immutability -- R3F idiom: three.js objects, uniforms and the DOM bridge are mutated
   imperatively inside frame callbacks/effects by design (no per-frame React state). */
import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { createCoreMaterial, useCore, useDisposable } from "./context";
import { HELPERS, OUTPUT, SHARED_UNIFORMS_GLSL } from "./shaders/common";

/**
 * Physical, lit mechanical structure: two counter-rotating gimbal rings with
 * instanced brackets and indicator LEDs. These are the only PBR-lit parts of
 * the core; they catch the nucleus' point light, giving real depth and scale
 * against the emissive HUD layers.
 */

const ledVert = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
attribute float aIndex;
varying float vI;
void main() {
  vI = aIndex;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;

const ledFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
uniform float uCountLeds;
uniform float uSeed;
varying float vI;
void main() {
  float idle = 0.35 + 0.65 * step(0.45, hash11(vI * 3.1 + uSeed + floor(uPulseClock * 1.5)));
  float head = floor(fract(uTime * 0.9 + uSeed) * uCountLeds);
  float k = mod(head - vI + uCountLeds, uCountLeds);
  float seq = exp(-k * 0.9) * uExec * 3.0;
  float warn = uError * step(0.5, fract(uTime * 2.0)) * 2.0;
  float gate = uGate * (0.6 + 0.4 * sin(uTime * 2.4)) * 1.5;
  vec3 col = mix(uPrimary, vec3(1.0), 0.25) * (idle * 1.3 + seq + warn + gate) * uBright;
  col *= 1.0 - uOffline * 0.8;
  col = desaturate(col, uSat);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
}`;

function annulusGeometry(inner: number, outer: number, depth: number, segments: number) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, outer, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, inner, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    curveSegments: segments,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.006,
    bevelSegments: 1,
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

interface GimbalSpec {
  radius: number;
  width: number;
  depth: number;
  tilt: [number, number, number];
  speed: number;
  brackets: number;
  seed: number;
}

const GIMBALS: GimbalSpec[] = [
  { radius: 1.93, width: 0.045, depth: 0.12, tilt: [-0.25, 0.75, 0], speed: 0.28, brackets: 12, seed: 0.3 },
  { radius: 2.42, width: 0.03, depth: 0.07, tilt: [0.36, -0.62, 0.18], speed: -0.2, brackets: 8, seed: 0.7 },
];

function useRoomEnvironment(): THREE.Texture | null {
  const gl = useThree((s) => s.gl);
  const tex = useMemo(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const rt = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    return rt;
  }, [gl]);
  useEffect(() => () => tex.dispose(), [tex]);
  return tex.texture;
}

function Gimbal({ spec, metal, bracketMat }: { spec: GimbalSpec; metal: THREE.Material; bracketMat: THREE.Material }) {
  const { uniforms, drive, preset } = useCore();
  const spin = useRef<THREE.Group>(null);
  const ringGeo = useDisposable(
    () => annulusGeometry(spec.radius - spec.width / 2, spec.radius + spec.width / 2, spec.depth, Math.max(96, preset.ringSegments)),
    [spec, preset.ringSegments],
  );
  const bracketGeo = useDisposable(() => new THREE.BoxGeometry(spec.width + 0.07, 0.085, spec.depth * 1.75), [spec]);
  const ledGeo = useDisposable(() => {
    const g = new THREE.BoxGeometry(0.018, 0.05, 0.018);
    const idx = new Float32Array(spec.brackets);
    for (let i = 0; i < spec.brackets; i++) idx[i] = i;
    g.setAttribute("aIndex", new THREE.InstancedBufferAttribute(idx, 1));
    return g;
  }, [spec]);
  const ledMat = useDisposable(
    () =>
      createCoreMaterial(uniforms, {
        vertexShader: ledVert,
        fragmentShader: ledFrag,
        transparent: false,
        depthWrite: true,
        blending: THREE.NormalBlending,
        uniforms: { uCountLeds: { value: spec.brackets }, uSeed: { value: spec.seed } },
      }),
    [uniforms, spec],
  );

  const brackets = useRef<THREE.InstancedMesh>(null);
  const leds = useRef<THREE.InstancedMesh>(null);

  useEffect(() => {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const one = new THREE.Vector3(1, 1, 1);
    const z = new THREE.Vector3(0, 0, 1);
    for (let i = 0; i < spec.brackets; i++) {
      const a = (i / spec.brackets) * Math.PI * 2 + spec.seed;
      q.setFromAxisAngle(z, a);
      pos.set(Math.cos(a) * spec.radius, Math.sin(a) * spec.radius, 0);
      m.compose(pos, q, one);
      brackets.current?.setMatrixAt(i, m);
      pos.set(Math.cos(a) * (spec.radius + spec.width / 2 + 0.045), Math.sin(a) * (spec.radius + spec.width / 2 + 0.045), 0);
      m.compose(pos, q, one);
      leds.current?.setMatrixAt(i, m);
    }
    if (brackets.current) brackets.current.instanceMatrix.needsUpdate = true;
    if (leds.current) leds.current.instanceMatrix.needsUpdate = true;
  }, [spec]);

  useFrame(() => {
    if (spin.current) spin.current.rotation.z = drive.orbit * spec.speed + spec.seed;
  });

  return (
    <group rotation={spec.tilt}>
      <group ref={spin}>
        <mesh geometry={ringGeo} material={metal} />
        <instancedMesh ref={brackets} args={[bracketGeo, bracketMat, spec.brackets]} frustumCulled={false} />
        <instancedMesh ref={leds} args={[ledGeo, ledMat, spec.brackets]} frustumCulled={false} />
      </group>
    </group>
  );
}

export function Gimbals() {
  const env = useRoomEnvironment();
  const metal = useDisposable(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#2a3a4e"),
        metalness: 0.82,
        roughness: 0.3,
        envMapIntensity: 0.32,
      }),
    [],
  );
  const bracketMat = useDisposable(
    () =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color("#3a4c62"),
        metalness: 0.7,
        roughness: 0.38,
        envMapIntensity: 0.38,
      }),
    [],
  );
  const { drive } = useCore();
  useFrame(() => {
    const k = 1 - drive.offline * 0.75;
    metal.envMapIntensity = 0.32 * k;
    bracketMat.envMapIntensity = 0.38 * k;
  });
  useEffect(() => {
    metal.envMap = env;
    bracketMat.envMap = env;
    metal.needsUpdate = true;
    bracketMat.needsUpdate = true;
  }, [env, metal, bracketMat]);

  return (
    <group>
      {GIMBALS.map((g) => (
        <Gimbal key={g.seed} spec={g} metal={metal} bracketMat={bracketMat} />
      ))}
    </group>
  );
}
