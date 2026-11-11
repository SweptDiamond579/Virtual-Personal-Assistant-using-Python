"use client";

import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { createCoreMaterial, useCore, useDisposable } from "./context";
import { DEPTH_FADE, HELPERS, OUTPUT, SHARED_UNIFORMS_GLSL } from "./shaders/common";

/**
 * Neural lattice on an outer shell: instanced nodes, line-segment synapses
 * with shader-driven travelling pulses, and energy filaments that feed the
 * lattice from the nucleus.
 */

const nodeVert = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
attribute float aSeed;
varying float vAct;
varying float vViewZ;
void main() {
  float act = step(0.78, hash11(aSeed * 17.0 + floor(uPulseClock * 2.5))) * uPulses;
  vAct = act;
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position * (1.0 + act * 0.7), 1.0);
  vViewZ = mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const nodeFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
${DEPTH_FADE}
varying float vAct;
varying float vViewZ;
void main() {
  float fade = depthFade(vViewZ, 0.18);
  vec3 col = mix(uPrimary, uSecondary, 0.35) * (0.3 + vAct * 2.6 + uEnergy * 0.25) * uBright * fade;
  col *= 1.0 - uOffline * 0.7;
  col = desaturate(col, uSat);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
}`;

const edgeVert = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
attribute float aT;
attribute float aSeed;
varying float vT;
varying float vSeed;
varying float vViewZ;
void main() {
  vT = aT;
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewZ = mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const edgeFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
${DEPTH_FADE}
varying float vT;
varying float vSeed;
varying float vViewZ;
void main() {
  float live = step(0.42, hash11(vSeed * 31.0));
  float t = hash11(vSeed * 3.0) > 0.5 ? vT : 1.0 - vT;
  float p = fract(uPulseClock * (0.3 + vSeed * 0.45) + vSeed * 7.0);
  float pulse = exp(-pow((t - p) * 16.0, 2.0)) * live * uPulses;
  float base = 0.025 + uEnergy * 0.03 + uThink * 0.03;
  float fade = depthFade(vViewZ, 0.15);
  vec3 col = uPrimary * base + mix(uSecondary, vec3(1.0), 0.3) * pulse * 1.9;
  col *= uBright * fade * (1.0 - uOffline * 0.85);
  col = desaturate(col, uSat);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
}`;

const filamentVert = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
attribute float aSeed;
varying vec2 vUv;
varying float vSeed;
varying float vViewZ;
void main() {
  vUv = uv;
  vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewZ = mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const filamentFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
${DEPTH_FADE}
varying vec2 vUv;
varying float vSeed;
varying float vViewZ;
void main() {
  float t = vUv.x;
  float speed = 0.55 + vSeed * 0.6 + uExec * 0.8;
  float flow = fract(t * 1.6 - uFlow * speed + vSeed * 5.0);
  float packet = smoothstep(0.0, 0.05, flow) * (1.0 - smoothstep(0.05, 0.3, flow));
  float envelope = smoothstep(0.0, 0.1, t) * (1.0 - smoothstep(0.7, 1.0, t) * 0.75);
  float audio = uLevel * (uListen + uSpeak);
  float a = (0.12 + packet * (0.55 + uEnergy * 1.3 + audio * 1.5)) * envelope;
  a *= (0.45 + uEnergy * 0.8) * (1.0 - uOffline * 0.92) * (1.0 - uGate * 0.55);
  float fade = depthFade(vViewZ, 0.25);
  vec3 col = mix(mix(uPrimary, vec3(1.0), 0.25), uSecondary, smoothstep(0.2, 1.0, t)) * a * fade * uBright;
  col = desaturate(col, uSat);
  gl_FragColor = vec4(col, 1.0);
  ${OUTPUT}
}`;

/** Deterministic node layout: jittered Fibonacci sphere. */
export function neuralNodePositions(count: number, radius = 2.78): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const rr = Math.sqrt(1 - y * y);
    const th = golden * i;
    const jitter = 1 + (Math.sin(i * 12.9898) * 43758.5453 - Math.floor(Math.sin(i * 12.9898) * 43758.5453) - 0.5) * 0.22;
    // flatten slightly so the lattice reads as a halo around the core
    pts.push(new THREE.Vector3(Math.cos(th) * rr, y * 0.82, Math.sin(th) * rr).multiplyScalar(radius * jitter));
  }
  return pts;
}

function buildEdges(nodes: THREE.Vector3[], k = 3): THREE.BufferGeometry {
  const seen = new Set<string>();
  const pos: number[] = [];
  const ts: number[] = [];
  const seeds: number[] = [];
  nodes.forEach((a, i) => {
    const near = nodes
      .map((b, j) => ({ j, d: a.distanceToSquared(b) }))
      .filter((n) => n.j !== i)
      .sort((x, y) => x.d - y.d)
      .slice(0, k);
    for (const { j } of near) {
      const key = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const b = nodes[j]!;
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
      ts.push(0, 1);
      const s = ((i * 73 + j * 151) % 997) / 997;
      seeds.push(s, s);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aT", new THREE.Float32BufferAttribute(ts, 1));
  g.setAttribute("aSeed", new THREE.Float32BufferAttribute(seeds, 1));
  return g;
}

function buildFilaments(nodes: THREE.Vector3[], count: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const axis = new THREE.Vector3(0, 1, 0);
  const n = Math.min(count, nodes.length);
  for (let i = 0; i < n; i++) {
    const end = nodes[Math.floor((i * nodes.length) / n + 1) % nodes.length]!.clone();
    const dir = end.clone().normalize();
    const twist = 0.55 + (i % 3) * 0.2;
    const start = dir.clone().applyAxisAngle(axis, -twist).multiplyScalar(0.84);
    const m1 = dir.clone().applyAxisAngle(axis, -twist * 0.55).multiplyScalar(1.45);
    const m2 = dir.clone().applyAxisAngle(axis, -twist * 0.18).multiplyScalar(2.15);
    m1.y += (i % 2 ? 0.15 : -0.15);
    const curve = new THREE.CatmullRomCurve3([start, m1, m2, end]);
    const tube = new THREE.TubeGeometry(curve, 56, 0.0055, 3, false);
    const seed = new Float32Array(tube.getAttribute("position").count).fill(((i * 37) % 101) / 101);
    tube.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    tube.deleteAttribute("normal");
    parts.push(tube);
  }
  const merged = mergeGeometries(parts, false) ?? new THREE.BufferGeometry();
  parts.forEach((p) => p.dispose());
  return merged;
}

export function Neural() {
  const { uniforms, drive, preset } = useCore();
  const group = useRef<THREE.Group>(null);
  const nodesMesh = useRef<THREE.InstancedMesh>(null);
  const count = preset.neuralNodes;

  const nodeGeo = useDisposable(() => {
    const g = new THREE.OctahedronGeometry(0.022, 0);
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) seeds[i] = ((i * 61) % 113) / 113;
    g.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
    return g;
  }, [count]);
  const edgeGeo = useDisposable(() => buildEdges(neuralNodePositions(count), 2), [count]);
  const filGeo = useDisposable(
    () => buildFilaments(neuralNodePositions(count), preset.filaments),
    [count, preset.filaments],
  );
  const nodeMat = useDisposable(
    () => createCoreMaterial(uniforms, { vertexShader: nodeVert, fragmentShader: nodeFrag }),
    [uniforms],
  );
  const edgeMat = useDisposable(
    () => createCoreMaterial(uniforms, { vertexShader: edgeVert, fragmentShader: edgeFrag }),
    [uniforms],
  );
  const filMat = useDisposable(
    () => createCoreMaterial(uniforms, { vertexShader: filamentVert, fragmentShader: filamentFrag }),
    [uniforms],
  );

  useEffect(() => {
    const mesh = nodesMesh.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    neuralNodePositions(count).forEach((p, i) => {
      m.makeTranslation(p.x, p.y, p.z);
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [count]);

  useFrame(() => {
    const g = group.current;
    if (!g) return;
    g.rotation.y = drive.orbit * 0.05 + drive.time * 0.01;
    g.rotation.z = Math.sin(drive.time * 0.05) * 0.05;
  });

  return (
    <group ref={group}>
      <instancedMesh key={count} ref={nodesMesh} args={[nodeGeo, nodeMat, count]} frustumCulled={false} renderOrder={2} />
      <lineSegments geometry={edgeGeo} material={edgeMat} renderOrder={2} />
      <mesh geometry={filGeo} material={filMat} renderOrder={2} />
    </group>
  );
}
