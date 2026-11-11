import { createContext, useContext, useEffect, useMemo } from "react";
import * as THREE from "three";
import type { GraphicsQuality } from "@/lib/core-visuals";
import type { DriveState } from "../logic/driver";
import type { QualityPreset } from "../logic/quality";

/** Uniform objects shared (by reference) between every core material. */
export interface SharedUniforms {
  uTime: THREE.IUniform<number>;
  uOrbit: THREE.IUniform<number>;
  uParticleClock: THREE.IUniform<number>;
  uPulseClock: THREE.IUniform<number>;
  uFlow: THREE.IUniform<number>;
  uEnergy: THREE.IUniform<number>;
  uLevel: THREE.IUniform<number>;
  uListen: THREE.IUniform<number>;
  uSpeak: THREE.IUniform<number>;
  uThink: THREE.IUniform<number>;
  uExec: THREE.IUniform<number>;
  uGate: THREE.IUniform<number>;
  uError: THREE.IUniform<number>;
  uOffline: THREE.IUniform<number>;
  uSuccess: THREE.IUniform<number>;
  uPulses: THREE.IUniform<number>;
  uSat: THREE.IUniform<number>;
  uBright: THREE.IUniform<number>;
  uGlitch: THREE.IUniform<number>;
  uShock: THREE.IUniform<number>;
  uDisplace: THREE.IUniform<number>;
  uCamDist: THREE.IUniform<number>;
  uPixelRatio: THREE.IUniform<number>;
  uPrimary: THREE.IUniform<THREE.Color>;
  uSecondary: THREE.IUniform<THREE.Color>;
}

export function createSharedUniforms(): SharedUniforms {
  const f = (v = 0): THREE.IUniform<number> => ({ value: v });
  return {
    uTime: f(),
    uOrbit: f(),
    uParticleClock: f(),
    uPulseClock: f(),
    uFlow: f(),
    uEnergy: f(),
    uLevel: f(),
    uListen: f(),
    uSpeak: f(),
    uThink: f(),
    uExec: f(),
    uGate: f(),
    uError: f(),
    uOffline: f(),
    uSuccess: f(),
    uPulses: f(),
    uSat: f(1),
    uBright: f(1),
    uGlitch: f(),
    uShock: f(-1),
    uDisplace: f(0.6),
    uCamDist: f(10),
    uPixelRatio: f(1),
    uPrimary: { value: new THREE.Color() },
    uSecondary: { value: new THREE.Color() },
  };
}

/** Copy the driver's numbers into the shared uniforms (once per frame). */
export function writeUniforms(u: SharedUniforms, d: DriveState) {
  u.uTime.value = d.time;
  u.uOrbit.value = d.orbit;
  u.uParticleClock.value = d.particleClock;
  u.uPulseClock.value = d.pulseClock;
  u.uFlow.value = d.flow;
  u.uEnergy.value = d.energy;
  u.uLevel.value = d.level;
  u.uListen.value = d.listen;
  u.uSpeak.value = d.speak;
  u.uThink.value = d.think;
  u.uExec.value = d.exec;
  u.uGate.value = d.gate;
  u.uError.value = d.error;
  u.uOffline.value = d.offline;
  u.uSuccess.value = d.success;
  u.uPulses.value = d.pulses;
  u.uSat.value = d.saturation;
  u.uBright.value = d.brightness;
  u.uGlitch.value = d.glitch;
  u.uShock.value = d.shock;
  u.uDisplace.value = d.displacement;
  u.uPrimary.value.setRGB(d.primary[0], d.primary[1], d.primary[2], THREE.LinearSRGBColorSpace);
  u.uSecondary.value.setRGB(d.secondary[0], d.secondary[1], d.secondary[2], THREE.LinearSRGBColorSpace);
}

export interface CoreSceneContext {
  uniforms: SharedUniforms;
  drive: DriveState;
  preset: QualityPreset;
  quality: GraphicsQuality;
  reducedMotion: boolean;
}

export const CoreCtx = createContext<CoreSceneContext | null>(null);

export function useCore(): CoreSceneContext {
  const v = useContext(CoreCtx);
  if (!v) throw new Error("useCore must be used inside the core scene");
  return v;
}

export interface MaterialOptions {
  vertexShader: string;
  fragmentShader: string;
  uniforms?: Record<string, THREE.IUniform>;
  blending?: THREE.Blending;
  transparent?: boolean;
  depthWrite?: boolean;
  depthTest?: boolean;
  side?: THREE.Side;
}

/** Build a ShaderMaterial that shares the core uniforms. */
export function createCoreMaterial(shared: SharedUniforms, o: MaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: o.vertexShader,
    fragmentShader: o.fragmentShader,
    uniforms: { ...(shared as unknown as Record<string, THREE.IUniform>), ...(o.uniforms ?? {}) },
    blending: o.blending ?? THREE.AdditiveBlending,
    transparent: o.transparent ?? true,
    depthWrite: o.depthWrite ?? false,
    depthTest: o.depthTest ?? true,
    side: o.side ?? THREE.FrontSide,
  });
}

/** useMemo + dispose-on-unmount for GPU resources (geometries, materials, textures). */
export function useDisposable<T extends { dispose: () => void }>(factory: () => T, deps: readonly unknown[]): T {
  // Callers pass literal dependency arrays; this is a thin generic wrapper.
  // eslint-disable-next-line react-hooks/use-memo, react-hooks/exhaustive-deps
  const obj = useMemo(factory, deps);
  useEffect(() => () => obj.dispose(), [obj]);
  return obj;
}
