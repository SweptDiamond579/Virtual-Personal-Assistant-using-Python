"use client";

/* eslint-disable react-hooks/immutability -- R3F idiom: three.js objects, uniforms and the DOM bridge are mutated
   imperatively inside frame callbacks/effects by design (no per-frame React state). */
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { GraphicsQuality } from "@/lib/core-visuals";
import type { CoreBridge } from "../bridge";

function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

/**
 * Measures FPS over 1s windows and the renderer's draw calls / triangles for
 * a whole frame (all composer passes included), publishes them to
 * `window.__JARVIS_CORE_STATS__` and writes the optional overlay text
 * directly — never through React state.
 */
export function StatsProbe({ bridge, quality }: { bridge: React.RefObject<CoreBridge>; quality: GraphicsQuality }) {
  const gl = useThree((s) => s.gl);
  const acc = useRef({ frames: 0, start: 0, ready: false });

  useEffect(() => {
    gl.info.autoReset = false;
    return () => {
      gl.info.autoReset = true;
    };
  }, [gl]);

  useFrame((state) => {
    const info = gl.info;
    // totals of the previous frame (autoReset is off so composer passes accumulate)
    const calls = info.render.calls;
    const triangles = info.render.triangles;
    info.reset();

    const a = acc.current;
    const now = performance.now();
    if (!a.ready) {
      a.ready = true;
      a.start = now;
      bridge.current.onReady?.();
      return;
    }
    a.frames++;
    const elapsed = now - a.start;
    if (elapsed < 1000) return;
    const fps = (a.frames * 1000) / elapsed;
    const dpr = state.viewport.dpr;
    window.__JARVIS_CORE_STATS__ = { fps: Math.round(fps * 10) / 10, calls, triangles, dpr, quality };
    const el = bridge.current.statsEl;
    if (el) {
      el.textContent = `${fps.toFixed(0)} FPS · ${calls} calls · ${formatCount(triangles)} tris · DPR ${dpr.toFixed(2)} · ${quality.toUpperCase()}`;
    }
    a.frames = 0;
    a.start = now;
  }, -1000);

  return null;
}
