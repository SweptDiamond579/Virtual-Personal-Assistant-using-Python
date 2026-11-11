import type { CameraKeyAction } from "./logic/camera";
import type { CoreNodeId } from "./types";

export interface CameraApi {
  apply(action: CameraKeyAction): void;
}

/**
 * Mutable bridge between the DOM wrapper and the WebGL scene. The scene writes
 * DOM (labels, stats text) directly every frame through it, so neither side
 * ever needs a React re-render for per-frame data.
 */
export interface CoreBridge {
  container: HTMLDivElement | null;
  labels: (HTMLElement | null)[];
  statsEl: HTMLElement | null;
  /** Node focused via the accessible DOM button list (highlights its satellite). */
  focusNode: CoreNodeId | null;
  camera: CameraApi | null;
  /** Called by the scene once the first frame has rendered. */
  onReady: (() => void) | null;
}

export function createBridge(): CoreBridge {
  return { container: null, labels: [], statsEl: null, focusNode: null, camera: null, onReady: null };
}
