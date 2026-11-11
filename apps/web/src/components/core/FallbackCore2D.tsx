"use client";

import { useEffect, useId, useRef, type CSSProperties } from "react";
import type { CoreState } from "@jarvis/protocol";
import { CORE_VISUALS } from "@/lib/core-visuals";
import styles from "./FallbackCore2D.module.css";

export interface FallbackCore2DProps {
  state: CoreState;
  levelRef: React.RefObject<number>;
  reducedMotion: boolean;
  className?: string;
}

const TICKS = Array.from({ length: 72 }, (_, i) => i);
const SEGMENTS = Array.from({ length: 24 }, (_, i) => i);
const BLADES = Array.from({ length: 8 }, (_, i) => i);
const BARS = Array.from({ length: 48 }, (_, i) => i);

function polar(r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  // rounded so server and client render identical attribute strings
  return [Math.round(r * Math.cos(a) * 1000) / 1000, Math.round(r * Math.sin(a) * 1000) / 1000];
}

function arcPath(r: number, from: number, to: number): string {
  const [x0, y0] = polar(r, from);
  const [x1, y1] = polar(r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Lightweight SVG/CSS rendition of the core for when WebGL is unavailable,
 * while the 3D scene loads, or when 2D mode is chosen. State colour and
 * energy come from CORE_VISUALS; the audio level reaches CSS through a cheap
 * rAF loop that sets a custom property (no React re-render per frame).
 */
export function FallbackCore2D({ state, levelRef, reducedMotion, className }: FallbackCore2DProps) {
  const root = useRef<HTMLDivElement>(null);
  const v = CORE_VISUALS[state];
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const nucleusId = `jc2d-n-${uid}`;
  const haloId = `jc2d-h-${uid}`;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let raf = 0;
    let smooth = 0;
    let last = -1;
    const tick = () => {
      const raw = levelRef.current ?? 0;
      const target = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
      smooth += (target - smooth) * (target > smooth ? 0.45 : 0.12);
      if (Math.abs(smooth - last) > 0.004) {
        last = smooth;
        el.style.setProperty("--lvl", smooth.toFixed(3));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);

  const style = {
    "--c1": v.primary,
    "--c2": v.secondary,
    "--spin": String(Math.max(0.05, v.spin)),
    "--energy": String(v.energy),
  } as CSSProperties;

  return (
    <div
      ref={root}
      className={[styles.root, className].filter(Boolean).join(" ")}
      data-state={state}
      data-reduced={reducedMotion ? "true" : undefined}
      style={style}
      aria-hidden="true"
    >
      <svg viewBox="-100 -100 200 200" className={styles.svg} preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id={nucleusId}>
            <stop offset="0%" className={styles.stopHot} />
            <stop offset="38%" className={styles.stopMid} />
            <stop offset="72%" className={styles.stopEdge} />
            <stop offset="100%" className={styles.stopOut} />
          </radialGradient>
          <radialGradient id={haloId}>
            <stop offset="0%" className={styles.haloIn} />
            <stop offset="100%" className={styles.stopOut} />
          </radialGradient>
        </defs>

        <circle r="96" fill={`url(#${haloId})`} className={styles.halo} />

        <g className={`${styles.spin} ${styles.ringOuter}`}>
          <circle r="86" className={styles.hair} />
          {SEGMENTS.map((i) => (
            <path key={i} d={arcPath(90, i * 15 + 1.5, i * 15 + 12)} className={styles.segment} style={{ "--i": i } as CSSProperties} />
          ))}
        </g>

        <g className={`${styles.spin} ${styles.ringTicks}`}>
          {TICKS.map((i) => {
            const major = i % 6 === 0;
            const [x0, y0] = polar(major ? 64 : 67, i * 5);
            const [x1, y1] = polar(70, i * 5);
            return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className={major ? styles.tickMajor : styles.tick} />;
          })}
        </g>

        <g className={`${styles.spin} ${styles.ringDash}`}>
          <circle r="54" className={styles.dash} />
        </g>

        <g className={`${styles.spin} ${styles.ringCursor}`}>
          <circle r="46" className={styles.hair} />
          <path d={arcPath(46, 10, 48)} className={styles.cursor} />
          <path d={arcPath(46, 190, 210)} className={styles.cursor} />
        </g>

        <g className={styles.bars}>
          {BARS.map((i) => {
            const [x0, y0] = polar(34, i * 7.5);
            const [x1, y1] = polar(44, i * 7.5);
            return (
              <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className={styles.bar} style={{ "--i": i % 6 } as CSSProperties} />
            );
          })}
        </g>

        <g className={styles.ripples}>
          <circle r="30" className={styles.ripple} />
          <circle r="30" className={styles.ripple} style={{ animationDelay: "-0.8s" }} />
          <circle r="30" className={styles.ripple} style={{ animationDelay: "-1.6s" }} />
        </g>

        <g className={styles.gate}>
          {BLADES.map((i) => (
            <g key={i} transform={`rotate(${i * 45})`}>
              <path d={arcPath(37, 3, 42)} className={styles.blade} />
            </g>
          ))}
        </g>

        <circle key={state === "SUCCESS" ? "shock-on" : "shock-off"} r="30" className={styles.shock} />

        <g className={styles.nucleus}>
          <circle r="27" fill={`url(#${nucleusId})`} />
          <circle r="13" className={styles.core} />
        </g>
      </svg>
    </div>
  );
}
