"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CoreState } from "@jarvis/protocol";
import { get, put } from "./api";
import { deriveCoreState, nextTransitionIn } from "./core-machine";
import type { GraphicsQuality, RenderMode } from "./core-visuals";
import { selectActiveRuns, selectPendingApprovals, useJarvis } from "./store";
import type { VoicePrefs } from "./voice";

export interface SettingsResponse {
  values: {
    voice: { stt: "browser" | "server"; tts: "server" | "browser" | "off"; voice: string; rate: number; auto_speak: boolean; auto_stop?: boolean };
    interface: { quality: GraphicsQuality; render_mode: RenderMode; reduced_motion: boolean; show_stats: boolean };
    notifications: { desktop: boolean; sound: boolean };
    privacy: { conversation_retention_days: number; memory_auto_propose: boolean };
    budget: { daily_usd: number | null };
    web_allowlist: string[];
    watched_repos: string[];
    timezone: string;
    tool_policies: Record<string, string>;
  };
  server: {
    ai_provider: string;
    anthropic_model: string;
    anthropic_fast_model: string;
    effort: string;
    model_routing: string;
    stt_engine: string;
    tts_engine: string;
    max_steps_per_run: number;
    default_daily_budget_usd: number;
    env: string;
  };
}

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: () => get<SettingsResponse>("/api/settings"), staleTime: 60_000 });
}

export function useUpdateSetting() {
  const qc = useQueryClient();
  return async (key: string, value: unknown) => {
    await put(`/api/settings/${key}`, { value: value as never });
    await qc.invalidateQueries({ queryKey: ["settings"] });
  };
}

export function useVoicePrefs(): VoicePrefs & { autoSpeak: boolean } {
  const { data } = useSettings();
  const v = data?.values.voice;
  return {
    stt: v?.stt ?? "server",
    tts: v?.tts ?? "server",
    voice: v?.voice ?? "en-gb",
    rate: v?.rate ?? 1,
    autoSpeak: v?.auto_speak ?? true,
    autoStopOnSilence: v?.auto_stop ?? true,
  };
}

function subscribeReducedMotion(cb: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

export function useInterfacePrefs() {
  const { data } = useSettings();
  const systemReduced = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false,
  );
  const i = data?.values.interface;
  return {
    quality: (i?.quality ?? "high") as GraphicsQuality,
    renderMode: (i?.render_mode ?? "3d") as RenderMode,
    reducedMotion: (i?.reduced_motion ?? false) || systemReduced,
    showStats: i?.show_stats ?? false,
  };
}

function subscribeVisibility(cb: () => void) {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible", () => true);
}

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** The single source of truth for the AI core's visual state. */
export function useCoreState(): CoreState {
  const connected = useJarvis((s) => s.connection === "open");
  const micActive = useJarvis((s) => s.micActive);
  const speaking = useJarvis((s) => s.speaking);
  const pendingApprovals = useJarvis((s) => selectPendingApprovals(s).length);
  const runningTools = useJarvis((s) => Object.keys(s.runningTools).length);
  const activeRuns = useJarvis((s) => selectActiveRuns(s).length);
  const lastOutcome = useJarvis((s) => s.lastOutcome);
  const [now, setNow] = useState(() => Date.now());
  const inputs = useMemo(
    () => ({ connected, micActive, speaking, pendingApprovals, runningTools, activeRuns, lastOutcome, now }),
    [connected, micActive, speaking, pendingApprovals, runningTools, activeRuns, lastOutcome, now],
  );
  useEffect(() => {
    // Re-evaluate when a new outcome arrives, and again when its hold period expires.
    if (!lastOutcome) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const wait = nextTransitionIn({ ...inputs, now: Date.now() });
    const expiry = wait == null ? undefined : setTimeout(tick, wait + 20);
    return () => {
      clearTimeout(first);
      if (expiry) clearTimeout(expiry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-arm only when the outcome changes
  }, [lastOutcome]);
  return deriveCoreState(inputs);
}
