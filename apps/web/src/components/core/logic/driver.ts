import type { CoreState } from "@jarvis/protocol";
import { clamp01, clampDelta, damp, dampAsymmetric, lambdaFor, TRANSITION_SECONDS } from "./damping";
import { getStateTargets, motionScale, type StateTargets } from "./state-targets";

/**
 * The core "driver": a plain mutable record advanced once per frame. It damps
 * every state-dependent parameter toward its target, integrates clocks (so a
 * speed change never makes anything jump), smooths the audio level and runs
 * the one-shot SUCCESS shockwave and ERROR glitch bursts. No React, no three:
 * the scene copies these numbers into shared shader uniforms.
 */
export type RGB = [number, number, number];

type DampedKey =
  | "energy"
  | "spin"
  | "pulses"
  | "listen"
  | "speak"
  | "think"
  | "exec"
  | "gate"
  | "error"
  | "offline"
  | "success"
  | "saturation"
  | "brightness"
  | "breathRate"
  | "breathDepth"
  | "displacement"
  | "particleSpeed"
  | "bloom";

export const DAMPED_KEYS: readonly DampedKey[] = [
  "energy",
  "spin",
  "pulses",
  "listen",
  "speak",
  "think",
  "exec",
  "gate",
  "error",
  "offline",
  "success",
  "saturation",
  "brightness",
  "breathRate",
  "breathDepth",
  "displacement",
  "particleSpeed",
  "bloom",
];

export type DriveState = Record<DampedKey, number> & {
  primary: RGB;
  secondary: RGB;
  /** Smoothed audio level 0..1. */
  level: number;
  /** Clocks (seconds, scaled by motion preference). */
  time: number;
  /** Integrated spin: ring/orbital phase. */
  orbit: number;
  /** Integrated particle phase. */
  particleClock: number;
  /** Integrated neural pulse clock. */
  pulseClock: number;
  /** Integrated surface-flow clock for the nucleus and filaments. */
  flow: number;
  /** Integrated breathing phase (radians). */
  breathPhase: number;
  /** SUCCESS shockwave progress 0..1, or -1 when inactive. */
  shock: number;
  /** ERROR glitch burst intensity 0..1 (0 outside bursts). */
  glitch: number;
  glitchTimer: number;
  prevState: CoreState | null;
};

/** Convert an sRGB hex colour (#rrggbb) to linear RGB 0..1. */
export function hexToLinear(hex: string): RGB {
  const h = hex.replace("#", "");
  const n = Number.parseInt(h.length === 3 ? h.replace(/(.)/g, "$1$1") : h, 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
}

export function createDriveState(state: CoreState): DriveState {
  const t = getStateTargets(state);
  const base = {} as Record<DampedKey, number>;
  for (const k of DAMPED_KEYS) base[k] = t[k];
  return {
    ...base,
    primary: hexToLinear(t.primary),
    secondary: hexToLinear(t.secondary),
    level: 0,
    time: 0,
    orbit: 0,
    particleClock: 0,
    pulseClock: 0,
    flow: 0,
    breathPhase: 0,
    shock: -1,
    glitch: 0,
    glitchTimer: 0,
    prevState: state,
  };
}

export const SHOCKWAVE_SECONDS = 1.7;
const STATE_LAMBDA = lambdaFor(TRANSITION_SECONDS);
const LEVEL_ATTACK = 28;
const LEVEL_RELEASE = 7;

export interface DriveInput {
  state: CoreState;
  /** Raw audio level (any number; clamped to 0..1). */
  level: number;
  reducedMotion: boolean;
  /** Random source (injectable for tests). */
  random?: () => number;
}

/** Advance the driver by `rawDt` seconds. Returns the targets used. */
export function stepDrive(d: DriveState, input: DriveInput, rawDt: number): StateTargets {
  // generous clamp: keeps timing right on slow devices, still guards against tab-resume jumps
  const dt = clampDelta(rawDt, 0.25);
  const rand = input.random ?? Math.random;
  const targets = getStateTargets(input.state);

  for (const k of DAMPED_KEYS) d[k] = damp(d[k], targets[k], STATE_LAMBDA, dt);
  dampRGB(d.primary, hexToLinear(targets.primary), dt);
  dampRGB(d.secondary, hexToLinear(targets.secondary), dt);

  const lvl = clamp01(Number.isFinite(input.level) ? input.level : 0);
  d.level = dampAsymmetric(d.level, lvl, LEVEL_ATTACK, LEVEL_RELEASE, dt);

  const m = motionScale(input.reducedMotion);
  d.time += dt * m;
  d.orbit += dt * m * d.spin;
  d.particleClock += dt * m * d.particleSpeed;
  d.pulseClock += dt * m * (0.35 + d.energy);
  d.flow += dt * m * (0.25 + d.energy * 0.9);
  d.breathPhase += dt * m * d.breathRate;

  // one controlled shockwave when entering SUCCESS
  if (input.state !== d.prevState) {
    if (input.state === "SUCCESS" && !input.reducedMotion) d.shock = 0;
    d.prevState = input.state;
  }
  if (d.shock >= 0) {
    d.shock += dt / SHOCKWAVE_SECONDS;
    if (d.shock >= 1) d.shock = -1;
  }

  // short, irregular glitch bursts while in ERROR
  if (input.reducedMotion || d.error < 0.5) {
    d.glitch = 0;
    d.glitchTimer = 0;
  } else if (d.glitchTimer > 0) {
    d.glitchTimer -= dt;
    d.glitch = d.glitchTimer > 0 ? d.error * (0.55 + rand() * 0.45) : 0;
  } else if (rand() < dt * 1.6) {
    d.glitchTimer = 0.06 + rand() * 0.16;
    d.glitch = d.error;
  } else {
    d.glitch = 0;
  }
  return targets;
}

function dampRGB(c: RGB, target: RGB, dt: number) {
  c[0] = damp(c[0], target[0], STATE_LAMBDA, dt);
  c[1] = damp(c[1], target[1], STATE_LAMBDA, dt);
  c[2] = damp(c[2], target[2], STATE_LAMBDA, dt);
}

/** Breathing scale multiplier from the drive state. */
export function breathScale(d: DriveState): number {
  return 1 + Math.sin(d.breathPhase) * d.breathDepth;
}
