import { describe, expect, it } from "vitest";
import { CORE_STATES } from "@jarvis/protocol";
import { CORE_VISUALS } from "@/lib/core-visuals";
import {
  clampDelta,
  damp,
  dampAsymmetric,
  dampFactor,
  lambdaFor,
  smoothstep,
  steppedAngle,
  TRANSITION_SECONDS,
} from "./damping";
import { minQuality, QUALITY_ORDER, QUALITY_PRESETS, stepDown, stepUp } from "./quality";
import { describeCoreState, getStateTargets, motionScale } from "./state-targets";
import { fitDistance, keyToCameraAction, zoomLimits, CAMERA_FOV, FRAME_HALF_WIDTH } from "./camera";
import { CORE_NODES, nodeIndex, satellitePosition, SATELLITE_ORBIT } from "./nodes";
import { breathScale, createDriveState, hexToLinear, SHOCKWAVE_SECONDS, stepDrive } from "./driver";

describe("damping", () => {
  it("lambdaFor settles 95% within the transition time", () => {
    const l = lambdaFor(TRANSITION_SECONDS);
    expect(dampFactor(l, TRANSITION_SECONDS)).toBeCloseTo(0.95, 5);
  });

  it("is frame-rate independent", () => {
    const l = lambdaFor(0.6);
    let a = 0;
    for (let i = 0; i < 60; i++) a = damp(a, 1, l, 1 / 60);
    let b = 0;
    for (let i = 0; i < 144; i++) b = damp(b, 1, l, 1 / 144);
    expect(a).toBeCloseTo(b, 6);
  });

  it("never overshoots and never snaps in one frame", () => {
    const l = lambdaFor(TRANSITION_SECONDS);
    const v = damp(0, 1, l, 1 / 60);
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(0.2);
    expect(damp(0.99, 1, l, 10)).toBeLessThanOrEqual(1);
  });

  it("asymmetric damping uses attack when rising and release when falling", () => {
    const up = dampAsymmetric(0, 1, 30, 1, 0.05);
    const down = dampAsymmetric(1, 0, 30, 1, 0.05);
    expect(up).toBeGreaterThan(0.7);
    expect(down).toBeGreaterThan(0.9);
  });

  it("clamps bad and large deltas", () => {
    expect(clampDelta(5)).toBe(0.1);
    expect(clampDelta(-1)).toBe(0);
    expect(clampDelta(Number.NaN)).toBe(0);
    expect(clampDelta(0.016)).toBe(0.016);
  });

  it("smoothstep is clamped", () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
  });

  it("steppedAngle holds still between detents and is monotonic", () => {
    const step = Math.PI / 6;
    expect(steppedAngle(0.1, 2, step)).toBe(0);
    expect(steppedAngle(1.0, 2, step)).toBe(0);
    expect(steppedAngle(2.0, 2, step)).toBeCloseTo(step);
    let prev = -Infinity;
    for (let t = 0; t < 10; t += 0.01) {
      const a = steppedAngle(t, 2, step);
      expect(a).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = a;
    }
  });
});

describe("quality presets", () => {
  it("defines every tier with the required DPR clamps", () => {
    expect(QUALITY_PRESETS.low.dpr).toEqual([1, 1]);
    expect(QUALITY_PRESETS.medium.dpr).toEqual([1, 1.5]);
    expect(QUALITY_PRESETS.high.dpr).toEqual([1, 2]);
    expect(QUALITY_PRESETS.ultra.dpr).toEqual([1, 2]);
  });

  it("scales particle counts monotonically and disables postprocessing on low", () => {
    for (let i = 1; i < QUALITY_ORDER.length; i++) {
      const prev = QUALITY_PRESETS[QUALITY_ORDER[i - 1]!];
      const cur = QUALITY_PRESETS[QUALITY_ORDER[i]!];
      expect(cur.particles).toBeGreaterThan(prev.particles);
      expect(cur.neuralNodes).toBeGreaterThanOrEqual(prev.neuralNodes);
    }
    expect(QUALITY_PRESETS.low.postprocessing).toBe(false);
    expect(QUALITY_PRESETS.medium.postprocessing).toBe(true);
  });

  it("steps tiers within bounds", () => {
    expect(stepDown("ultra")).toBe("high");
    expect(stepDown("low")).toBe("low");
    expect(stepUp("low", "high")).toBe("medium");
    expect(stepUp("high", "high")).toBe("high");
    expect(stepUp("medium", "low")).toBe("low");
    expect(minQuality("ultra", "medium")).toBe("medium");
  });
});

describe("state targets", () => {
  it("covers every core state and mirrors CORE_VISUALS", () => {
    for (const s of CORE_STATES) {
      const t = getStateTargets(s);
      expect(t.primary).toBe(CORE_VISUALS[s].primary);
      expect(t.energy).toBe(CORE_VISUALS[s].energy);
      expect(t.spin).toBe(CORE_VISUALS[s].spin);
      expect(t.pulses).toBe(CORE_VISUALS[s].pulses ? 1 : 0);
    }
  });

  it("enables exactly one state layer per active state", () => {
    const layer = {
      LISTENING: "listen",
      THINKING: "think",
      SPEAKING: "speak",
      EXECUTING: "exec",
      WAITING_FOR_APPROVAL: "gate",
      SUCCESS: "success",
      ERROR: "error",
      OFFLINE: "offline",
    } as const;
    const keys = Object.values(layer);
    for (const [state, key] of Object.entries(layer)) {
      const t = getStateTargets(state as keyof typeof layer);
      expect(t[key]).toBe(1);
      for (const other of keys) if (other !== key) expect(t[other]).toBe(0);
    }
    const idle = getStateTargets("IDLE");
    for (const k of keys) expect(idle[k]).toBe(0);
  });

  it("makes OFFLINE desaturated, dim and nearly still", () => {
    const off = getStateTargets("OFFLINE");
    const idle = getStateTargets("IDLE");
    expect(off.saturation).toBeLessThan(0.3);
    expect(off.brightness).toBeLessThan(idle.brightness * 0.5);
    expect(off.particleSpeed).toBeLessThan(0.1);
  });

  it("slows motion for reduced motion", () => {
    expect(motionScale(false)).toBe(1);
    expect(motionScale(true)).toBeLessThan(0.25);
  });

  it("describes the state for assistive tech", () => {
    expect(describeCoreState("WAITING_FOR_APPROVAL")).toContain("Awaiting approval");
    expect(describeCoreState("WAITING_FOR_APPROVAL")).toContain(CORE_VISUALS.WAITING_FOR_APPROVAL.description);
  });
});

describe("driver", () => {
  it("converts sRGB hex to linear", () => {
    expect(hexToLinear("#ffffff")).toEqual([1, 1, 1]);
    expect(hexToLinear("#000000")).toEqual([0, 0, 0]);
    const [r] = hexToLinear("#808080");
    expect(r).toBeCloseTo(0.2158, 3);
  });

  it("damps toward the new state over ~0.65s rather than snapping", () => {
    const d = createDriveState("IDLE");
    stepDrive(d, { state: "WAITING_FOR_APPROVAL", level: 0, reducedMotion: false }, 1 / 60);
    expect(d.gate).toBeGreaterThan(0);
    expect(d.gate).toBeLessThan(0.15);
    for (let i = 0; i < 40; i++) stepDrive(d, { state: "WAITING_FOR_APPROVAL", level: 0, reducedMotion: false }, 1 / 60);
    expect(d.gate).toBeGreaterThan(0.9);
    const amber = hexToLinear(CORE_VISUALS.WAITING_FOR_APPROVAL.primary);
    expect(d.primary[0]).toBeCloseTo(amber[0], 1);
  });

  it("integrates clocks so speed changes never jump", () => {
    const d = createDriveState("IDLE");
    stepDrive(d, { state: "IDLE", level: 0, reducedMotion: false }, 1 / 60);
    const before = d.orbit;
    stepDrive(d, { state: "THINKING", level: 0, reducedMotion: false }, 1 / 60);
    expect(d.orbit - before).toBeLessThan(0.02);
    expect(d.orbit).toBeGreaterThan(before);
  });

  it("fires one shockwave on entering SUCCESS, then settles", () => {
    const d = createDriveState("EXECUTING");
    stepDrive(d, { state: "SUCCESS", level: 0, reducedMotion: false }, 1 / 60);
    expect(d.shock).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < Math.ceil((SHOCKWAVE_SECONDS + 0.2) * 60); i++)
      stepDrive(d, { state: "SUCCESS", level: 0, reducedMotion: false }, 1 / 60);
    expect(d.shock).toBe(-1);
  });

  it("skips the shockwave and glitches under reduced motion", () => {
    const d = createDriveState("EXECUTING");
    stepDrive(d, { state: "SUCCESS", level: 0, reducedMotion: true }, 1 / 60);
    expect(d.shock).toBe(-1);
    const e = createDriveState("ERROR");
    for (let i = 0; i < 200; i++) {
      stepDrive(e, { state: "ERROR", level: 0, reducedMotion: true, random: () => 0 }, 1 / 60);
      expect(e.glitch).toBe(0);
    }
  });

  it("produces glitch bursts in ERROR", () => {
    const e = createDriveState("ERROR");
    stepDrive(e, { state: "ERROR", level: 0, reducedMotion: false, random: () => 0 }, 1 / 60);
    expect(e.glitch).toBeGreaterThan(0);
  });

  it("smooths the audio level with a fast attack and clamps input", () => {
    const d = createDriveState("LISTENING");
    stepDrive(d, { state: "LISTENING", level: 5, reducedMotion: false }, 0.05);
    expect(d.level).toBeGreaterThan(0.6);
    expect(d.level).toBeLessThanOrEqual(1);
    stepDrive(d, { state: "LISTENING", level: Number.NaN, reducedMotion: false }, 0.05);
    expect(Number.isFinite(d.level)).toBe(true);
  });

  it("breathes around 1", () => {
    const d = createDriveState("WAITING_FOR_APPROVAL");
    d.breathPhase = Math.PI / 2;
    expect(breathScale(d)).toBeCloseTo(1 + d.breathDepth);
  });
});

describe("camera", () => {
  it("fits the composition for landscape and portrait", () => {
    const wide = fitDistance(16 / 9);
    const tall = fitDistance(390 / 844);
    expect(tall).toBeGreaterThan(wide);
    const tanHalf = Math.tan((CAMERA_FOV * Math.PI) / 360);
    // portrait: width-bound
    expect(FRAME_HALF_WIDTH / (tall * tanHalf * (390 / 844))).toBeLessThanOrEqual(1.0001);
    expect(fitDistance(Number.NaN)).toBeGreaterThan(0);
    const { min, max } = zoomLimits(10);
    expect(min).toBeLessThan(10);
    expect(max).toBeGreaterThan(10);
  });

  it("maps keys to camera actions", () => {
    expect(keyToCameraAction("ArrowLeft")).toEqual({ type: "orbit", azimuth: -0.2, polar: 0 });
    expect(keyToCameraAction("ArrowUp")?.type).toBe("orbit");
    const zin = keyToCameraAction("+");
    const zout = keyToCameraAction("-");
    expect(zin?.type === "zoom" && zin.factor < 1).toBe(true);
    expect(zout?.type === "zoom" && zout.factor > 1).toBe(true);
    expect(keyToCameraAction("Home")).toEqual({ type: "reset" });
    expect(keyToCameraAction("a")).toBeNull();
  });
});

describe("satellite nodes", () => {
  it("defines six unique nodes", () => {
    expect(CORE_NODES).toHaveLength(6);
    expect(new Set(CORE_NODES.map((n) => n.id)).size).toBe(6);
    expect(nodeIndex("security")).toBe(5);
  });

  it("places satellites on the orbit radius, evenly spaced", () => {
    const out: [number, number, number] = [0, 0, 0];
    const pts = CORE_NODES.map((_, i) => [...satellitePosition(i, 6, 0.3, out)]);
    for (const p of pts) expect(Math.hypot(p[0]!, p[1]!, p[2]!)).toBeCloseTo(SATELLITE_ORBIT.radius, 5);
    const d01 = Math.hypot(pts[0]![0]! - pts[1]![0]!, pts[0]![1]! - pts[1]![1]!, pts[0]![2]! - pts[1]![2]!);
    const d23 = Math.hypot(pts[2]![0]! - pts[3]![0]!, pts[2]![1]! - pts[3]![1]!, pts[2]![2]! - pts[3]![2]!);
    expect(d01).toBeCloseTo(d23, 5);
  });
});
