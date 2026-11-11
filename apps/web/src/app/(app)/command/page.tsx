"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, Gauge, MessagesSquare, Radar, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import type { RunSummary } from "@jarvis/protocol";
import { AICore, type CoreNodeId } from "@/components/core";
import { ConversationConsole } from "@/components/command/Console";
import { Chip, Panel, StatusDot, clsx, statusTone } from "@/components/ui";
import { get } from "@/lib/api";
import { sendChat } from "@/lib/chat";
import { CORE_VISUALS } from "@/lib/core-visuals";
import { timeAgo, usd } from "@/lib/format";
import { useCoreState, useInterfacePrefs, useMediaQuery, usePageVisible, useVoicePrefs } from "@/lib/hooks";
import { onServerEvent } from "@/lib/realtime";
import { useActiveRuns, useJarvis, useShallowJarvis } from "@/lib/store";
import { levelRef, voice } from "@/lib/voice";

const QUICK = [
  "Give me a quick status briefing",
  "What do you remember about my preferences?",
  "Summarise my recent notes",
  "Remind me in 30 minutes to take a break",
];

const SERVICE_LABELS: Record<string, string> = {
  database: "Database", ai: "AI model", scheduler: "Scheduler", speech_to_text: "Speech input", text_to_speech: "Speech output",
  browser: "Browser", github: "GitHub", email: "Email", desktop: "Desktop",
};

function ServicesPanel() {
  const system = useJarvis((s) => s.system);
  return (
    <Panel title="System status" icon={Radar} delay={0.05} bodyClassName="px-4 py-3">
      {!system ? (
        <p className="text-xs text-ink-3">Waiting for telemetry…</p>
      ) : (
        <ul className="space-y-2">
          {system.services.map((svc) => (
            <li key={svc.name} className="flex items-center gap-2.5 text-xs">
              <StatusDot tone={statusTone(svc.status)} pulse={svc.status === "down"} label={svc.status} />
              <span className="w-24 shrink-0 text-ink-2">{SERVICE_LABELS[svc.name] ?? svc.name}</span>
              <span className="min-w-0 flex-1 truncate text-ink-3" title={svc.detail}>{svc.detail}</span>
              {svc.latency_ms != null && <span className="font-mono text-[10px] text-ink-4">{svc.latency_ms}ms</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function UsagePanel() {
  const { data } = useQuery({
    queryKey: ["usage"],
    queryFn: () => get<{ today_usd: number; daily_budget_usd: number; series: { day: string; cost_usd: number }[] }>("/api/usage"),
    refetchInterval: 60_000,
  });
  const pct = data ? Math.min(100, (data.today_usd / Math.max(0.0001, data.daily_budget_usd)) * 100) : 0;
  return (
    <Panel title="AI usage today" icon={Gauge} delay={0.1} bodyClassName="px-4 py-3">
      <div className="flex items-baseline justify-between">
        <span className="font-display text-2xl tabular-nums text-ink">{usd(data?.today_usd ?? 0, 3)}</span>
        <span className="text-xs text-ink-3">of {usd(data?.daily_budget_usd ?? 0, 2)} budget</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Daily budget used">
        <div className={clsx("h-full rounded-full transition-[width] duration-700", pct > 85 ? "bg-danger" : "bg-cyan")} style={{ width: `${pct}%` }} />
      </div>
    </Panel>
  );
}

function ActiveTasksPanel() {
  const active = useActiveRuns();
  const recent = useShallowJarvis((s) =>
    Object.values(s.runs)
      .filter((r) => !["queued", "running", "waiting_approval"].includes(r.status))
      .sort((a, b) => (b.finished_at ?? b.created_at).localeCompare(a.finished_at ?? a.created_at))
      .slice(0, 4),
  );
  const row = (r: RunSummary) => (
    <li key={r.id} className="flex items-center gap-2 text-xs">
      <StatusDot tone={statusTone(r.status)} pulse={r.status === "running"} />
      <span className="min-w-0 flex-1 truncate text-ink-2">{r.title || r.kind}</span>
      <Chip tone={statusTone(r.status)}>{r.status.replace("_", " ")}</Chip>
      <span className="w-14 text-right font-mono text-[10px] text-ink-4">{timeAgo(r.finished_at ?? r.created_at)}</span>
    </li>
  );
  return (
    <Panel title="Mission activity" icon={Activity} delay={0.15} bodyClassName="px-4 py-3">
      <ul className="space-y-2">
        {active.map(row)}
        {active.length === 0 && <li className="text-xs text-ink-3">No active tasks.</li>}
        {recent.length > 0 && <li className="data-label pt-1">Recent</li>}
        {recent.map(row)}
      </ul>
    </Panel>
  );
}

export default function CommandCentre() {
  const state = useCoreState();
  const prefs = useInterfacePrefs();
  const voicePrefs = useVoicePrefs();
  const visible = usePageVisible();
  const router = useRouter();
  const wide = useMediaQuery("(min-width: 1280px)");
  const mobile = useMediaQuery("(max-width: 767px)");
  const voiceRuns = useRef(new Set<string>());

  // Speak replies to voice requests (Settings → Voice → auto-speak).
  useEffect(
    () =>
      onServerEvent((e) => {
        if (e.type !== "assistant.completed") return;
        const runId = e.data.message.run_id ?? "";
        const fromVoice = voiceRuns.current.delete(runId);
        if (fromVoice && voicePrefs.autoSpeak && voicePrefs.tts !== "off") {
          void voice.speak(e.data.message.content, voicePrefs).catch(() => undefined);
        }
      }),
    [voicePrefs],
  );

  const nodeRoutes: Record<CoreNodeId, string> = {
    mission: "/mission/",
    intelligence: "/intelligence/",
    memory: "/memory/",
    automation: "/automation/",
    integrations: "/integrations/",
    security: "/security/",
  };
  const quality = mobile && prefs.quality !== "low" ? "medium" : prefs.quality;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_380px] xl:grid-cols-[300px_minmax(0,1fr)_400px]">
      {wide && (
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          <ServicesPanel />
          <UsagePanel />
          <ActiveTasksPanel />
        </div>
      )}

      <section aria-label="AI core" className="relative flex min-h-[46vh] flex-col md:min-h-0">
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-[18px] border border-line bg-[radial-gradient(70%_60%_at_50%_45%,rgb(14_29_52/0.9),rgb(1_3_9/0.6)_70%)]">
          <AICore
            state={state}
            levelRef={levelRef}
            quality={quality}
            mode={prefs.renderMode}
            reducedMotion={prefs.reducedMotion}
            active={visible}
            showStats={prefs.showStats}
            onNodeSelect={(n) => router.push(nodeRoutes[n])}
            className="absolute inset-0"
          />
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-4">
            <div>
              <div className="data-label">Core state</div>
              <div className="mt-1 font-display text-lg tracking-wide" style={{ color: CORE_VISUALS[state].primary }} data-testid="core-state">
                {CORE_VISUALS[state].label}
              </div>
              <div className="max-w-[16rem] text-xs text-ink-3">{CORE_VISUALS[state].description}</div>
            </div>
          </div>
        </div>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] md:flex-wrap md:overflow-visible" aria-label="Quick commands">
          {QUICK.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => void sendChat(q).catch(() => undefined)}
              className="chip h-7 shrink-0 cursor-pointer gap-1.5 border-line-2 px-3 text-[10px] text-ink-2 transition-colors hover:border-cyan/50 hover:text-ink"
            >
              <Sparkles className="size-3 text-cyan" aria-hidden />
              {q}
            </button>
          ))}
        </div>
      </section>

      <Panel title="Conversation" icon={MessagesSquare} className="min-h-[60vh] md:min-h-0" bodyClassName="p-0 min-h-0 flex flex-col">
        <ConversationConsole onVoiceRun={(id) => voiceRuns.current.add(id)} />
      </Panel>

      {!wide && (
        <div className="grid gap-4 md:col-span-2 md:grid-cols-3">
          <ServicesPanel />
          <UsagePanel />
          <ActiveTasksPanel />
        </div>
      )}
    </div>
  );
}
