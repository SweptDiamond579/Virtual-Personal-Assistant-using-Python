"use client";

import type { CSSProperties } from "react";
import type { CoreState } from "@jarvis/protocol";
import { CORE_VISUALS } from "@/lib/core-visuals";
import styles from "./CoreMiniIndicator.module.css";

export interface CoreMiniIndicatorProps {
  state: CoreState;
  size?: number;
  className?: string;
}

/**
 * Tiny pure-SVG state glyph for top bars: a segmented ring around a nucleus
 * dot. Colour from CORE_VISUALS; per-state CSS animation; static under
 * prefers-reduced-motion. No WebGL.
 */
export function CoreMiniIndicator({ state, size = 20, className }: CoreMiniIndicatorProps) {
  const v = CORE_VISUALS[state];
  const style = { "--c1": v.primary, "--c2": v.secondary, width: size, height: size } as CSSProperties;
  return (
    <span
      className={[styles.root, className].filter(Boolean).join(" ")}
      data-state={state}
      style={style}
      role="img"
      aria-label={`Core: ${v.label}`}
      title={v.label}
    >
      <svg viewBox="-12 -12 24 24" width={size} height={size} aria-hidden="true">
        <circle r="10" className={styles.track} />
        <g className={styles.ring}>
          <circle r="10" className={styles.arc} pathLength={100} />
        </g>
        <circle r="6.6" className={styles.gate} pathLength={100} />
        <circle r="4" className={styles.halo} />
        <circle r="2.6" className={styles.dot} />
        <line x1="-7" y1="7" x2="7" y2="-7" className={styles.slash} />
      </svg>
    </span>
  );
}
