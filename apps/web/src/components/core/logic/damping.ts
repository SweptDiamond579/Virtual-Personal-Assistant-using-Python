/**
 * Frame-rate independent damping helpers. Every state transition in the core
 * goes through these so changes ease in over ~0.65s instead of snapping,
 * whatever the frame rate.
 */

/** Default state transition time (seconds) to settle within 95% of target. */
export const TRANSITION_SECONDS = 0.65;

/** Exponential decay rate that settles `settle` (0..1) of the way in `seconds`. */
export function lambdaFor(seconds: number, settle = 0.95): number {
  if (seconds <= 0) return Number.POSITIVE_INFINITY;
  return -Math.log(1 - settle) / seconds;
}

/** Fraction of the remaining distance covered in `dt` at decay rate `lambda`. */
export function dampFactor(lambda: number, dt: number): number {
  if (!Number.isFinite(lambda)) return 1;
  return 1 - Math.exp(-lambda * Math.max(0, dt));
}

/** Exponentially damp `current` toward `target`. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * dampFactor(lambda, dt);
}

/** Damping with a separate rate for rising (attack) and falling (release) values. */
export function dampAsymmetric(
  current: number,
  target: number,
  attack: number,
  release: number,
  dt: number,
): number {
  return damp(current, target, target > current ? attack : release, dt);
}

/** Clamp a frame delta so a resumed tab never produces a huge jump. */
export function clampDelta(dt: number, max = 0.1): number {
  if (!Number.isFinite(dt) || dt < 0) return 0;
  return Math.min(dt, max);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * "Mechanical" stepped rotation: holds still, then eases quickly to the next
 * detent. `t` is a monotonically increasing clock; returns radians.
 *
 * @param interval seconds between steps
 * @param step     radians per step
 * @param moveFraction portion of each interval spent moving (0..1)
 */
export function steppedAngle(t: number, interval: number, step: number, moveFraction = 0.28): number {
  if (interval <= 0) return 0;
  const p = t / interval;
  const whole = Math.floor(p);
  const frac = p - whole;
  const start = 1 - moveFraction;
  const m = frac <= start ? 0 : (frac - start) / moveFraction;
  // ease-in-out cubic with a tiny overshoot-free settle
  const eased = m < 0.5 ? 4 * m * m * m : 1 - Math.pow(-2 * m + 2, 3) / 2;
  return (whole + eased) * step;
}
