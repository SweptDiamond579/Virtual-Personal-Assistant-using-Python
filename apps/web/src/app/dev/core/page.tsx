"use client";

import { useEffect, useRef, useState } from "react";
import { CORE_STATES, type CoreState } from "@jarvis/protocol";
import { AICore, CoreMiniIndicator, type CoreNodeId } from "@/components/core";
import { CORE_VISUALS, type GraphicsQuality, type RenderMode } from "@/lib/core-visuals";

/**
 * Dev review harness for the AI core (static-export friendly: no params, no
 * server data). Query string presets for automation:
 *   ?state=THINKING&quality=high&mode=2d&stats=1&rm=1&ui=0&voice=1&level=0.5&adaptive=0
 */

const QUALITIES: GraphicsQuality[] = ["low", "medium", "high", "ultra"];

function isState(v: string | null): v is CoreState {
  return !!v && (CORE_STATES as readonly string[]).includes(v);
}
function isQuality(v: string | null): v is GraphicsQuality {
  return !!v && (QUALITIES as string[]).includes(v);
}

export default function CoreDevPage() {
  const [state, setState] = useState<CoreState>("IDLE");
  const [quality, setQuality] = useState<GraphicsQuality>("high");
  const [mode, setMode] = useState<RenderMode>("3d");
  const [reducedMotion, setReducedMotion] = useState(false);
  const [showStats, setShowStats] = useState(true);
  const [active, setActive] = useState(true);
  const [voice, setVoice] = useState(false);
  const [showUi, setShowUi] = useState(true);
  const [lastNode, setLastNode] = useState<CoreNodeId | null>(null);
  const levelRef = useRef(0);
  const manualLevel = useRef(0);
  const meter = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLInputElement>(null);

  // Apply query-string presets once on the client.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const s = q.get("state");
    const ql = q.get("quality");
    const lvl = Number.parseFloat(q.get("level") ?? "");
    if (q.get("adaptive") === "0") window.__JARVIS_CORE_DISABLE_ADAPTIVE__ = true;
    if (Number.isFinite(lvl)) {
      manualLevel.current = lvl;
      if (slider.current) slider.current.value = String(lvl);
    }
    /* eslint-disable react-hooks/set-state-in-effect -- one-time sync from the URL */
    if (isState(s)) setState(s);
    if (isQuality(ql)) setQuality(ql);
    if (q.get("mode") === "2d") setMode("2d");
    if (q.get("rm") === "1") setReducedMotion(true);
    if (q.get("stats") === "0") setShowStats(false);
    if (q.get("voice") === "1") setVoice(true);
    if (q.get("ui") === "0") setShowUi(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  // Level driver: manual slider or a synthetic voice envelope. Writes the ref only.
  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const loop = (now: number) => {
      let target = manualLevel.current;
      if (voice) {
        const t = now / 1000;
        const word = Math.sin(t * 1.7) + Math.sin(t * 0.63 + 1) > -0.5 ? 1 : 0.04;
        const syllable = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 4.2 + Math.sin(t * 3) * 2);
        target = Math.max(target, word * (0.25 + syllable * 0.75) * (0.7 + Math.random() * 0.3));
      }
      smooth += (target - smooth) * (target > smooth ? 0.5 : 0.18);
      levelRef.current = smooth;
      if (meter.current) meter.current.style.transform = `scaleX(${smooth.toFixed(3)})`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [voice]);

  // 1–9 select states; S toggles stats; H hides the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.getAttribute("tabindex") === "0")) return;
      const n = Number.parseInt(e.key, 10);
      const next = CORE_STATES[n - 1];
      if (n >= 1 && next) setState(next);
      else if (e.key === "h") setShowUi((v) => !v);
      else if (e.key === "s") setShowStats((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const v = CORE_VISUALS[state];

  return (
    <main className="fixed inset-0 bg-void text-ink">
      <AICore
        className="absolute inset-0"
        state={state}
        levelRef={levelRef}
        quality={quality}
        mode={mode}
        reducedMotion={reducedMotion}
        active={active}
        showStats={showStats}
        onNodeSelect={setLastNode}
      />

      <header className="pointer-events-none absolute top-3 right-4 flex items-center gap-2 text-right">
        <CoreMiniIndicator state={state} size={18} />
        <div>
          <div className="panel-title">{v.label}</div>
          <div className="data-label hidden sm:block">{v.description}</div>
        </div>
      </header>

      {showUi ? (
        <section
          aria-label="Core review controls"
          className="holo-panel absolute inset-x-2 bottom-2 flex max-h-[42dvh] flex-col gap-3 overflow-y-auto p-3 sm:inset-x-auto sm:bottom-4 sm:left-1/2 sm:w-[min(980px,calc(100%-2rem))] sm:-translate-x-1/2"
        >
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Core state">
            {CORE_STATES.map((s, i) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={s === state}
                onClick={() => setState(s)}
                className={`btn h-8 gap-1.5 px-2.5 text-[0.7rem] ${s === state ? "btn-primary" : "btn-ghost"}`}
                data-state-button={s}
              >
                <CoreMiniIndicator state={s} size={14} />
                <span className="font-mono text-ink-3">{i + 1}</span>
                {CORE_VISUALS[s].label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
            <label className="flex items-center gap-2">
              <span className="data-label">Quality</span>
              <select
                className="field h-8 w-auto py-0 text-xs"
                value={quality}
                onChange={(e) => setQuality(e.target.value as GraphicsQuality)}
              >
                {QUALITIES.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </label>
            <Toggle label="2D" checked={mode === "2d"} onChange={(c) => setMode(c ? "2d" : "3d")} />
            <Toggle label="Reduced motion" checked={reducedMotion} onChange={setReducedMotion} />
            <Toggle label="Stats" checked={showStats} onChange={setShowStats} />
            <Toggle label="Active" checked={active} onChange={setActive} />
            <Toggle label="Simulate voice" checked={voice} onChange={setVoice} />
            <label className="flex min-w-[200px] flex-1 items-center gap-2">
              <span className="data-label">Level</span>
              <input
                ref={slider}
                type="range"
                min={0}
                max={1}
                step={0.01}
                defaultValue={0}
                onInput={(e) => {
                  manualLevel.current = Number.parseFloat((e.target as HTMLInputElement).value);
                }}
                className="flex-1 accent-cyan"
                aria-label="Audio level"
              />
              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
                <div ref={meter} className="h-full w-full origin-left scale-x-0 bg-cyan" />
              </div>
            </label>
            <span className="data-label" aria-live="polite">
              Node: <span className="text-ink-2">{lastNode ?? "—"}</span>
            </span>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 select-none">
      <input type="checkbox" className="accent-cyan" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="data-label text-ink-2">{label}</span>
    </label>
  );
}
