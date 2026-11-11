"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import * as THREE from "three";
import type { CoreState } from "@jarvis/protocol";
import type { GraphicsQuality } from "@/lib/core-visuals";
import type { CoreBridge } from "../bridge";
import { CAMERA_FOV } from "../logic/camera";
import { createDriveState, stepDrive } from "../logic/driver";
import { QUALITY_PRESETS, stepDown, stepUp } from "../logic/quality";
import type { CoreNodeId } from "../types";
import { CameraRig } from "./CameraRig";
import { CoreCtx, createSharedUniforms, useCore, writeUniforms, type CoreSceneContext } from "./context";
import { Floor, Lights } from "./Environment";
import { Gimbals } from "./Gimbals";
import { Neural } from "./Neural";
import { Nucleus } from "./Nucleus";
import { Particles } from "./Particles";
import { PostFX } from "./PostFX";
import { Rings } from "./Rings";
import { Satellites } from "./Satellites";
import { StateLayers } from "./StateLayers";
import { StatsProbe } from "./StatsProbe";

export interface CoreSceneProps {
  state: CoreState;
  levelRef: React.RefObject<number>;
  quality: GraphicsQuality;
  reducedMotion: boolean;
  active: boolean;
  onNodeSelect?: (node: CoreNodeId) => void;
  bridge: React.RefObject<CoreBridge>;
  onContextLost: () => void;
}

interface Inputs {
  state: CoreState;
  reducedMotion: boolean;
}

/** Advances the state driver and writes shared uniforms before anything else draws. */
function Driver({ inputs, levelRef }: { inputs: React.RefObject<Inputs>; levelRef: React.RefObject<number> }) {
  const { drive, uniforms } = useCore();
  useFrame((_, delta) => {
    const i = inputs.current;
    stepDrive(drive, { state: i.state, level: levelRef.current ?? 0, reducedMotion: i.reducedMotion }, delta);
    writeUniforms(uniforms, drive);
  }, -10);
  return null;
}

const BACKGROUND = "#010309";

export default function CoreScene(props: CoreSceneProps) {
  const { state, levelRef, quality, reducedMotion, active, onNodeSelect, bridge, onContextLost } = props;

  // Adaptive tier: stepped down by the performance monitor, reset when the requested quality changes.
  const [adaptive, setAdaptive] = useState<{ requested: GraphicsQuality; tier: GraphicsQuality }>({
    requested: quality,
    tier: quality,
  });
  const effective = adaptive.requested === quality ? adaptive.tier : quality;
  const preset = QUALITY_PRESETS[effective];

  const [uniforms] = useState(createSharedUniforms);
  const [drive] = useState(() => createDriveState(state));

  const inputs = useRef<Inputs>({ state, reducedMotion });
  useLayoutEffect(() => {
    inputs.current = { state, reducedMotion };
  }, [state, reducedMotion]);

  const selectRef = useRef(onNodeSelect);
  useLayoutEffect(() => {
    selectRef.current = onNodeSelect;
  }, [onNodeSelect]);

  const lostRef = useRef(onContextLost);
  useLayoutEffect(() => {
    lostRef.current = onContextLost;
  }, [onContextLost]);

  const ctx = useMemo<CoreSceneContext>(
    () => ({ uniforms, drive, preset, quality: effective, reducedMotion }),
    [uniforms, drive, preset, effective, reducedMotion],
  );

  const canAdapt = () => typeof window === "undefined" || !window.__JARVIS_CORE_DISABLE_ADAPTIVE__;

  const disposed = useRef(false);
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      delete window.__JARVIS_CORE_STATS__;
    };
  }, []);

  return (
    <Canvas
      frameloop={active ? "always" : "never"}
      dpr={preset.dpr}
      gl={{
        antialias: true,
        alpha: false,
        stencil: false,
        powerPreference: "high-performance",
        toneMapping: THREE.NeutralToneMapping,
      }}
      camera={{ fov: CAMERA_FOV, near: 0.1, far: 120, position: [0, 1.5, 12] }}
      onCreated={({ gl }) => {
        gl.setClearColor(BACKGROUND, 1);
        const canvas = gl.domElement;
        canvas.addEventListener("webglcontextlost", (e) => {
          e.preventDefault();
          // R3F force-loses the context after unmount; only a loss while mounted is a failure.
          if (canvas.isConnected && !disposed.current) lostRef.current();
        });
      }}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={[BACKGROUND]} />
      <CoreCtx.Provider value={ctx}>
        <PerformanceMonitor
          flipflops={4}
          onDecline={() => {
            if (canAdapt()) setAdaptive({ requested: quality, tier: stepDown(effective) });
          }}
          onIncline={() => {
            if (canAdapt() && effective !== quality) setAdaptive({ requested: quality, tier: stepUp(effective, quality) });
          }}
        />
        <Driver inputs={inputs} levelRef={levelRef} />
        <CameraRig bridge={bridge}>
          <Lights />
          <Floor />
          <Nucleus />
          <Rings />
          <Gimbals />
          <Particles />
          <Neural />
          <StateLayers />
          <Satellites bridge={bridge} onSelect={selectRef} />
        </CameraRig>
        {preset.postprocessing ? <PostFX /> : null}
        <StatsProbe bridge={bridge} quality={effective} />
      </CoreCtx.Provider>
    </Canvas>
  );
}
