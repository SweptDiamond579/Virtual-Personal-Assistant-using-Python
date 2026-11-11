import type { CoreState } from "@jarvis/protocol";
import { CORE_VISUALS } from "@/lib/core-visuals";

/**
 * Numeric targets the scene damps toward for each core state. Colour, energy,
 * spin and pulses come from CORE_VISUALS (the shared source of truth); the
 * rest are scene-specific weights that switch state-only layers on and off.
 */
export interface StateTargets {
  primary: string;
  secondary: string;
  energy: number;
  spin: number;
  /** 0/1 — neural pulses visible. */
  pulses: number;
  /** Layer weights 0..1 (each enables a state-specific visual). */
  listen: number;
  speak: number;
  think: number;
  exec: number;
  gate: number;
  error: number;
  offline: number;
  success: number;
  /** Colour saturation multiplier (1 = as designed). */
  saturation: number;
  /** Overall emissive brightness multiplier. */
  brightness: number;
  /** Breathing angular rate (rad/s) and depth (scale fraction). */
  breathRate: number;
  breathDepth: number;
  /** Nucleus surface displacement multiplier. */
  displacement: number;
  /** Particle orbital speed multiplier. */
  particleSpeed: number;
  /** Bloom intensity multiplier. */
  bloom: number;
}

type SceneTargets = Omit<StateTargets, "primary" | "secondary" | "energy" | "spin" | "pulses">;

const BASE: SceneTargets = {
  listen: 0,
  speak: 0,
  think: 0,
  exec: 0,
  gate: 0,
  error: 0,
  offline: 0,
  success: 0,
  saturation: 1,
  brightness: 1,
  breathRate: 1.2,
  breathDepth: 0.022,
  displacement: 0.6,
  particleSpeed: 0.45,
  bloom: 0.8,
};

const SCENE: Record<CoreState, Partial<SceneTargets>> = {
  IDLE: { brightness: 0.92 },
  LISTENING: { listen: 1, breathDepth: 0.01, displacement: 0.7, particleSpeed: 0.6, bloom: 0.9 },
  THINKING: { think: 1, brightness: 1.12, displacement: 1, particleSpeed: 1.5, bloom: 1, breathRate: 2.2 },
  SPEAKING: { speak: 1, breathDepth: 0.01, displacement: 0.75, particleSpeed: 0.75, bloom: 0.92, brightness: 1.04 },
  EXECUTING: { exec: 1, brightness: 1.08, displacement: 0.85, particleSpeed: 2.1, bloom: 1 },
  WAITING_FOR_APPROVAL: {
    gate: 1,
    breathRate: 2.1,
    breathDepth: 0.05,
    particleSpeed: 0.22,
    displacement: 0.45,
    bloom: 0.9,
    brightness: 0.95,
  },
  SUCCESS: { success: 1, brightness: 1.05, particleSpeed: 0.6, bloom: 0.95 },
  ERROR: { error: 1, brightness: 0.95, particleSpeed: 0.28, breathDepth: 0.006, displacement: 0.9, bloom: 0.85 },
  OFFLINE: {
    offline: 1,
    saturation: 0.18,
    brightness: 0.38,
    breathRate: 0.5,
    breathDepth: 0.008,
    displacement: 0.15,
    particleSpeed: 0.04,
    bloom: 0.35,
  },
};

export function getStateTargets(state: CoreState): StateTargets {
  const v = CORE_VISUALS[state];
  return {
    ...BASE,
    ...SCENE[state],
    primary: v.primary,
    secondary: v.secondary,
    energy: v.energy,
    spin: v.spin,
    pulses: v.pulses ? 1 : 0,
  };
}

/** Global time-scale for motion when the user prefers reduced motion. */
export const REDUCED_MOTION_SCALE = 0.16;

export function motionScale(reducedMotion: boolean): number {
  return reducedMotion ? REDUCED_MOTION_SCALE : 1;
}

/** Accessible description of the current state (used as the role="img" label). */
export function describeCoreState(state: CoreState): string {
  const v = CORE_VISUALS[state];
  return `JARVIS core — ${v.label}. ${v.description}`;
}
