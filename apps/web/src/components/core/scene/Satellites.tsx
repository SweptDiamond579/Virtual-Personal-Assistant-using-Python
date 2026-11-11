"use client";

/* eslint-disable react-hooks/immutability -- R3F idiom: three.js objects, uniforms and the DOM bridge are mutated
   imperatively inside frame callbacks/effects by design (no per-frame React state). */
import { useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import type { CoreBridge } from "../bridge";
import { damp } from "../logic/damping";
import { CORE_NODES, nodeIndex, satellitePosition, SATELLITE_ORBIT } from "../logic/nodes";
import { motionScale } from "../logic/state-targets";
import type { CoreNodeId } from "../types";
import { createCoreMaterial, useCore, useDisposable } from "./context";
import { createRingMaterial, RING_KIND } from "./Rings";
import { DEPTH_FADE, HELPERS, OUTPUT, SHARED_UNIFORMS_GLSL } from "./shaders/common";

const N = CORE_NODES.length;

const satVert = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
attribute float aIndex;
uniform float uHL[${N}];
varying float vH;
varying float vViewZ;
varying vec3 vN;
varying vec3 vV;
void main() {
  vH = uHL[int(aIndex + 0.5)];
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vViewZ = mv.z;
  vN = normalize(normalMatrix * mat3(instanceMatrix) * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const satFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
${DEPTH_FADE}
uniform float uPart;
varying float vH;
varying float vViewZ;
varying vec3 vN;
varying vec3 vV;
void main() {
  float fade = depthFade(vViewZ, 0.4);
  vec3 col;
  if (uPart < 0.5) {
    float fres = 1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
    col = mix(uSecondary, vec3(1.0), 0.35 + vH * 0.4) * (0.7 + fres * 0.9 + vH * 1.6);
  } else {
    col = mix(uPrimary, vec3(1.0), vH * 0.3) * (0.55 + vH * 1.5);
  }
  col *= fade * mix(1.0, 0.4, uOffline) * max(uBright, 0.6);
  gl_FragColor = vec4(desaturate(col, uSat), 1.0);
  ${OUTPUT}
}`;

const tetherVert = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
attribute float aT;
attribute float aIndex;
uniform float uHL[${N}];
varying float vT;
varying float vH;
varying float vViewZ;
void main() {
  vT = aT;
  vH = uHL[int(aIndex + 0.5)];
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewZ = mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const tetherFrag = /* glsl */ `
${SHARED_UNIFORMS_GLSL}
${HELPERS}
${DEPTH_FADE}
varying float vT;
varying float vH;
varying float vViewZ;
void main() {
  float flow = fract(vT * 6.0 + uTime * (0.4 + vH * 1.2));
  float dash = step(0.5, flow);
  float v = (0.1 + vH * 0.75) * dash * smoothstep(0.0, 0.25, vT);
  vec3 col = uPrimary * v * depthFade(vViewZ, 0.3) * uBright;
  gl_FragColor = vec4(desaturate(col, uSat), 1.0);
  ${OUTPUT}
}`;

function indexed<T extends THREE.BufferGeometry>(g: T, count: number): T {
  const idx = new Float32Array(count);
  for (let i = 0; i < count; i++) idx[i] = i;
  g.setAttribute("aIndex", new THREE.InstancedBufferAttribute(idx, 1));
  return g;
}

const TETHER_INNER = 2.92;

export function Satellites({
  bridge,
  onSelect,
}: {
  bridge: React.RefObject<CoreBridge>;
  onSelect: React.RefObject<((node: CoreNodeId) => void) | undefined>;
}) {
  const { uniforms, preset, reducedMotion, drive } = useCore();
  const group = useRef<THREE.Group>(null);
  const cores = useRef<THREE.InstancedMesh>(null);
  const frames = useRef<THREE.InstancedMesh>(null);
  const hits = useRef<THREE.InstancedMesh>(null);
  const hovered = useRef<number>(-1);
  const phase = useRef(0.35);
  const hoverPause = useRef(0);

  const coreGeo = useDisposable(() => indexed(new THREE.IcosahedronGeometry(0.075, 1), N), []);
  const frameGeo = useDisposable(() => indexed(new THREE.TorusGeometry(0.17, 0.0055, 6, 64), N), []);
  const hitGeo = useDisposable(() => new THREE.SphereGeometry(0.38, 10, 8), []);
  const hitMat = useDisposable(() => new THREE.MeshBasicMaterial({ visible: false }), []);
  const hl = useRef<number[]>(new Array<number>(N).fill(0));

  const coreMat = useDisposable(
    () =>
      createCoreMaterial(uniforms, {
        vertexShader: satVert,
        fragmentShader: satFrag,
        transparent: false,
        depthWrite: true,
        blending: THREE.NormalBlending,
        uniforms: { uHL: { value: hl.current }, uPart: { value: 0 } },
      }),
    [uniforms],
  );
  const frameMat = useDisposable(
    () =>
      createCoreMaterial(uniforms, {
        vertexShader: satVert,
        fragmentShader: satFrag,
        uniforms: { uHL: { value: hl.current }, uPart: { value: 1 } },
      }),
    [uniforms],
  );
  const tetherGeo = useDisposable(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    const t = new Float32Array(N * 2);
    const idx = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      t[i * 2] = 0;
      t[i * 2 + 1] = 1;
      idx[i * 2] = i;
      idx[i * 2 + 1] = i;
    }
    g.setAttribute("aT", new THREE.BufferAttribute(t, 1));
    g.setAttribute("aIndex", new THREE.BufferAttribute(idx, 1));
    return g;
  }, []);
  const tetherMat = useDisposable(
    () =>
      createCoreMaterial(uniforms, {
        vertexShader: tetherVert,
        fragmentShader: tetherFrag,
        uniforms: { uHL: { value: hl.current } },
      }),
    [uniforms],
  );
  const pathGeo = useDisposable(
    () => new THREE.RingGeometry(SATELLITE_ORBIT.radius - 0.008, SATELLITE_ORBIT.radius + 0.008, preset.ringSegments * 2, 1),
    [preset.ringSegments],
  );
  const pathMat = useDisposable(
    () =>
      createRingMaterial(uniforms, {
        inner: SATELLITE_ORBIT.radius - 0.008,
        outer: SATELLITE_ORBIT.radius + 0.008,
        kind: RING_KIND.path,
        count: 260,
        intensity: 0.7,
        seed: 0.9,
        tilt: [0, 0, 0],
      }),
    [uniforms],
  );

  const tmp = useRef({
    p: [0, 0, 0] as [number, number, number],
    m: new THREE.Matrix4(),
    q: new THREE.Quaternion(),
    pq: new THREE.Quaternion(),
    v: new THREE.Vector3(),
    s: new THREE.Vector3(),
    one: new THREE.Vector3(1, 1, 1),
  });

  useFrame((state, delta) => {
    const g = group.current;
    if (!g || !cores.current || !frames.current || !hits.current) return;
    const dt = Math.min(delta, 0.1);
    const b = bridge.current;
    const focus = b.focusNode ? nodeIndex(b.focusNode) : -1;
    const any = hovered.current >= 0 || focus >= 0;
    hoverPause.current = damp(hoverPause.current, any ? 1 : 0, 6, dt);
    phase.current += dt * motionScale(reducedMotion) * (0.035 + drive.spin * 0.02) * (1 - hoverPause.current);

    const t = tmp.current;
    g.updateWorldMatrix(true, false);
    g.getWorldQuaternion(t.pq).invert();
    t.q.copy(state.camera.quaternion).premultiply(t.pq);
    const pos = tetherGeo.getAttribute("position") as THREE.BufferAttribute;
    const { width, height } = state.size;

    for (let i = 0; i < N; i++) {
      const target = i === hovered.current || i === focus ? 1 : 0;
      hl.current[i] = damp(hl.current[i] ?? 0, target, 10, dt);
      const p = satellitePosition(i, N, phase.current, t.p);
      const h = hl.current[i] ?? 0;
      t.v.set(p[0], p[1], p[2]);
      t.s.setScalar(1 + h * 0.45);
      t.m.compose(t.v, t.q, t.s);
      cores.current.setMatrixAt(i, t.m);
      frames.current.setMatrixAt(i, t.m);
      t.m.compose(t.v, t.q, t.one);
      hits.current.setMatrixAt(i, t.m);
      // tether from the HUD ring out to the satellite
      const len = Math.hypot(p[0], p[1], p[2]);
      const k = TETHER_INNER / len;
      pos.setXYZ(i * 2, p[0] * k, p[1] * k, p[2] * k);
      pos.setXYZ(i * 2 + 1, p[0] * 0.95, p[1] * 0.95, p[2] * 0.95);

      const label = b.labels[i];
      if (label) {
        t.v.applyMatrix4(g.matrixWorld);
        const viewZ = t.v.clone().applyMatrix4(state.camera.matrixWorldInverse).z;
        t.v.project(state.camera);
        const x = (t.v.x * 0.5 + 0.5) * width;
        const y = (-t.v.y * 0.5 + 0.5) * height;
        const camDist = state.camera.position.length();
        const behind = THREE.MathUtils.smoothstep(-viewZ - camDist, -0.5, 2.5);
        label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        label.style.setProperty("--vis", (1 - behind * 0.65).toFixed(3));
        const active = h > 0.5;
        if ((label.dataset.active === "true") !== active) label.dataset.active = String(active);
      }
    }
    cores.current.instanceMatrix.needsUpdate = true;
    frames.current.instanceMatrix.needsUpdate = true;
    hits.current.instanceMatrix.needsUpdate = true;
    pos.needsUpdate = true;
  });

  const setCursor = (c: string) => {
    const el = bridge.current.container;
    if (el) el.style.cursor = c;
  };
  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    hovered.current = e.instanceId ?? -1;
    setCursor("pointer");
  };
  const out = () => {
    hovered.current = -1;
    setCursor("");
  };
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const node = CORE_NODES[e.instanceId ?? -1];
    if (node) onSelect.current?.(node.id);
  };

  return (
    <group>
      <group rotation={[0, SATELLITE_ORBIT.yaw, 0]}>
        <group rotation={[SATELLITE_ORBIT.inclination, 0, 0]}>
          <mesh geometry={pathGeo} material={pathMat} rotation={[-Math.PI / 2, 0, 0]} renderOrder={2} />
        </group>
      </group>
      <group ref={group}>
        <instancedMesh ref={cores} args={[coreGeo, coreMat, N]} frustumCulled={false} />
        <instancedMesh ref={frames} args={[frameGeo, frameMat, N]} frustumCulled={false} renderOrder={3} />
        <lineSegments geometry={tetherGeo} material={tetherMat} frustumCulled={false} renderOrder={2} />
        <instancedMesh
          ref={hits}
          args={[hitGeo, hitMat, N]}
          frustumCulled={false}
          onPointerOver={over}
          onPointerMove={over}
          onPointerOut={out}
          onClick={click}
        />
      </group>
    </group>
  );
}
