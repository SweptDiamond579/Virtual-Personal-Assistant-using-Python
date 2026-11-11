"use client";

/* eslint-disable react-hooks/immutability -- R3F idiom: three.js objects, uniforms and the DOM bridge are mutated
   imperatively inside frame callbacks/effects by design (no per-frame React state). */
import { useEffect, useLayoutEffect, useRef, type ComponentRef, type ReactNode } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import type { CoreBridge } from "../bridge";
import { fitDistance, POLAR_MAX, POLAR_MIN, zoomLimits, type CameraKeyAction } from "../logic/camera";
import { damp } from "../logic/damping";
import { useCore } from "./context";

const DEFAULT_POLAR = 1.24;

type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

/**
 * Camera framing (fits the composition to the container aspect), constrained
 * OrbitControls, keyboard orbit/zoom via the bridge, and a damped pointer
 * parallax + slow drift applied to the world group (so it never fights the
 * controls).
 */
export function CameraRig({ bridge, children }: { bridge: React.RefObject<CoreBridge>; children: ReactNode }) {
  const { drive, reducedMotion, uniforms } = useCore();
  const controls = useRef<OrbitControlsImpl>(null);
  const world = useRef<THREE.Group>(null);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const base = fitDistance(size.width / Math.max(1, size.height));
  const limits = zoomLimits(base);
  const lastBase = useRef<number | null>(null);
  const pendingZoom = useRef(0); // remaining log-zoom

  // Frame the composition on mount and keep the relative zoom on resize.
  useLayoutEffect(() => {
    if (lastBase.current === null) {
      const y = Math.cos(DEFAULT_POLAR) * base;
      const z = Math.sin(DEFAULT_POLAR) * base;
      camera.position.set(0, y, z);
      camera.lookAt(0, 0, 0);
    } else {
      camera.position.multiplyScalar(base / lastBase.current);
    }
    lastBase.current = base;
    controls.current?.update();
  }, [base, camera]);

  useEffect(() => {
    const b = bridge.current;
    b.camera = {
      apply(action: CameraKeyAction) {
        const c = controls.current;
        if (!c) return;
        if (action.type === "orbit") {
          if (action.azimuth) c.setAzimuthalAngle(c.getAzimuthalAngle() + action.azimuth);
          if (action.polar) c.setPolarAngle(c.getPolarAngle() + action.polar);
        } else if (action.type === "zoom") {
          pendingZoom.current += Math.log(action.factor);
        } else {
          c.setAzimuthalAngle(0);
          c.setPolarAngle(DEFAULT_POLAR);
          pendingZoom.current = Math.log(base / Math.max(0.001, c.getDistance()));
        }
      },
    };
    return () => {
      b.camera = null;
    };
  }, [bridge, base]);

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.1);
    const c = controls.current;
    if (c && Math.abs(pendingZoom.current) > 1e-4) {
      const step = pendingZoom.current * (1 - Math.exp(-9 * dt));
      pendingZoom.current -= step;
      c.dollyIn(Math.exp(step)); // three-stdlib: dollyIn(s) multiplies the radius by s
    }
    uniforms.uCamDist.value = camera.position.length();
    uniforms.uPixelRatio.value = state.viewport.dpr;

    const w = world.current;
    if (!w) return;
    const amt = reducedMotion ? 0.25 : 1;
    const drift = Math.sin(drive.time * 0.07) * 0.08 * amt;
    w.rotation.y = damp(w.rotation.y, state.pointer.x * 0.1 * amt + drift, 2.5, dt);
    w.rotation.x = damp(w.rotation.x, -state.pointer.y * 0.06 * amt, 2.5, dt);
    w.position.y = Math.sin(drive.time * 0.35) * 0.045 * amt;
    // ERROR: subtle positional jitter during glitch bursts
    w.position.x = drive.glitch > 0 ? (Math.random() - 0.5) * 0.05 * drive.glitch : 0;
  });

  return (
    <>
      <OrbitControls
        ref={controls}
        makeDefault
        enablePan={false}
        enableDamping
        dampingFactor={0.07}
        rotateSpeed={0.5}
        zoomSpeed={0.6}
        minDistance={limits.min}
        maxDistance={limits.max}
        minPolarAngle={POLAR_MIN}
        maxPolarAngle={POLAR_MAX}
      />
      <group ref={world}>{children}</group>
    </>
  );
}
