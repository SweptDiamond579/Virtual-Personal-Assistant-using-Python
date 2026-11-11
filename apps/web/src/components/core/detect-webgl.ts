let cached: boolean | null = null;

/**
 * True when the browser can create a WebGL2 context (three r163+ requires
 * WebGL2). Cached after the first successful probe; always false on the server.
 */
export function detectWebGL(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  if (cached !== null) return cached;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false });
    cached = !!gl;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    cached = false;
  }
  return cached;
}

/** Test helper: forget the cached probe result. */
export function resetWebGLDetection() {
  cached = null;
}
