import type { RefObject } from "react";
import type { CoreState } from "@jarvis/protocol";
import type { GraphicsQuality, RenderMode } from "@/lib/core-visuals";

/** The six satellite systems orbiting the core. */
export type CoreNodeId = "mission" | "intelligence" | "memory" | "automation" | "integrations" | "security";

export interface AICoreProps {
  state: CoreState;
  /**
   * Live audio level 0..1 read every frame (mic input level when LISTENING,
   * playback amplitude when SPEAKING). The caller mutates .current; it must
   * never cause React re-renders.
   */
  levelRef: RefObject<number>;
  quality: GraphicsQuality;
  /** "2d" forces the fallback. */
  mode: RenderMode;
  reducedMotion: boolean;
  /** false => suspend rendering entirely (frameloop "never"). */
  active: boolean;
  onNodeSelect?: (node: CoreNodeId) => void;
  /** Small FPS / draw-call overlay. */
  showStats?: boolean;
  className?: string;
}

/** Published once per second to `window.__JARVIS_CORE_STATS__`. */
export interface CoreStats {
  fps: number;
  calls: number;
  triangles: number;
  dpr: number;
  quality: GraphicsQuality;
}

declare global {
  interface Window {
    /** Live render statistics of the WebGL core, for automated performance tests. */
    __JARVIS_CORE_STATS__?: CoreStats;
    /** Test hook: when true the core never steps its quality tier down automatically. */
    __JARVIS_CORE_DISABLE_ADAPTIVE__?: boolean;
  }
}
