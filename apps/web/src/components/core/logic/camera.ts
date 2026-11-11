/** Camera framing and keyboard-orbit logic (pure, unit tested). */

export const CAMERA_FOV = 34;

/** Half extents (world units) of the composition that must stay in frame. */
export const FRAME_HALF_WIDTH = 3.75;
export const FRAME_HALF_HEIGHT = 3.25;

/** Polar angle clamp (radians from +Y): keeps the camera from going over the top or under. */
export const POLAR_MIN = 0.95;
export const POLAR_MAX = 2.0;

/**
 * Distance at which a box of half extents (halfW, halfH) centred on the origin
 * fits a perspective camera with vertical field of view `fovDeg` and `aspect`.
 */
export function fitDistance(
  aspect: number,
  fovDeg = CAMERA_FOV,
  halfW = FRAME_HALF_WIDTH,
  halfH = FRAME_HALF_HEIGHT,
): number {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const tanHalf = Math.tan((fovDeg * Math.PI) / 360);
  const byHeight = halfH / tanHalf;
  const byWidth = halfW / (tanHalf * safeAspect);
  return Math.max(byHeight, byWidth);
}

export function zoomLimits(base: number): { min: number; max: number } {
  return { min: base * 0.6, max: base * 1.45 };
}

export type CameraKeyAction =
  | { type: "orbit"; azimuth: number; polar: number }
  | { type: "zoom"; factor: number }
  | { type: "reset" };

const ORBIT_STEP = 0.2;
const ZOOM_STEP = 0.88;

/** Map a KeyboardEvent.key to a camera action, or null if the key is not handled. */
export function keyToCameraAction(key: string): CameraKeyAction | null {
  switch (key) {
    case "ArrowLeft":
      return { type: "orbit", azimuth: -ORBIT_STEP, polar: 0 };
    case "ArrowRight":
      return { type: "orbit", azimuth: ORBIT_STEP, polar: 0 };
    case "ArrowUp":
      return { type: "orbit", azimuth: 0, polar: -ORBIT_STEP };
    case "ArrowDown":
      return { type: "orbit", azimuth: 0, polar: ORBIT_STEP };
    case "+":
    case "=":
    case "Add":
      return { type: "zoom", factor: ZOOM_STEP };
    case "-":
    case "_":
    case "Subtract":
      return { type: "zoom", factor: 1 / ZOOM_STEP };
    case "0":
    case "Home":
      return { type: "reset" };
    default:
      return null;
  }
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
