import type { GraphicsQuality } from "@/lib/core-visuals";

export interface QualityPreset {
  /** Device pixel ratio clamp passed to the canvas. */
  dpr: [number, number];
  /** Orbital/spiral band particles. */
  particles: number;
  /** Distant depth dust particles. */
  dust: number;
  neuralNodes: number;
  filaments: number;
  /** IcosahedronGeometry subdivision for the nucleus. */
  nucleusDetail: number;
  postprocessing: boolean;
  multisampling: number;
  bloomLevels: number;
  /** Segments used to tessellate flat rings. */
  ringSegments: number;
}

export const QUALITY_ORDER: readonly GraphicsQuality[] = ["low", "medium", "high", "ultra"];

export const QUALITY_PRESETS: Record<GraphicsQuality, QualityPreset> = {
  low: {
    dpr: [1, 1],
    particles: 1400,
    dust: 250,
    neuralNodes: 48,
    filaments: 8,
    nucleusDetail: 18,
    postprocessing: false,
    multisampling: 0,
    bloomLevels: 0,
    ringSegments: 128,
  },
  medium: {
    dpr: [1, 1.5],
    particles: 3600,
    dust: 500,
    neuralNodes: 72,
    filaments: 14,
    nucleusDetail: 28,
    postprocessing: true,
    multisampling: 0,
    bloomLevels: 5,
    ringSegments: 192,
  },
  high: {
    dpr: [1, 2],
    particles: 7000,
    dust: 800,
    neuralNodes: 96,
    filaments: 20,
    nucleusDetail: 40,
    postprocessing: true,
    multisampling: 4,
    bloomLevels: 6,
    ringSegments: 256,
  },
  ultra: {
    dpr: [1, 2],
    particles: 12000,
    dust: 1200,
    neuralNodes: 128,
    filaments: 28,
    nucleusDetail: 56,
    postprocessing: true,
    multisampling: 8,
    bloomLevels: 7,
    ringSegments: 320,
  },
};

export function qualityRank(q: GraphicsQuality): number {
  return QUALITY_ORDER.indexOf(q);
}

/** The lower of two tiers. */
export function minQuality(a: GraphicsQuality, b: GraphicsQuality): GraphicsQuality {
  return qualityRank(a) <= qualityRank(b) ? a : b;
}

/** One tier lower (stays at "low"). */
export function stepDown(q: GraphicsQuality): GraphicsQuality {
  return QUALITY_ORDER[Math.max(0, qualityRank(q) - 1)] ?? "low";
}

/** One tier higher, never above `max`. */
export function stepUp(q: GraphicsQuality, max: GraphicsQuality): GraphicsQuality {
  const next = QUALITY_ORDER[Math.min(QUALITY_ORDER.length - 1, qualityRank(q) + 1)] ?? q;
  return minQuality(next, max);
}
