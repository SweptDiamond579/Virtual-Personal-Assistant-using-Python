"use client";

import { useQuery } from "@tanstack/react-query";
import { Bell, Bot, Globe, KeyRound, Laptop, LogOut, MonitorCog, ShieldCheck, Volume2 } from "lucide-react";
import { useState } from "react";
import { DesktopPairing } from "@/components/DesktopPairing";
import { TwoFactor } from "@/components/TwoFactor";
import { refreshAuth } from "@/components/providers";
import { Button, Chip, ErrorNote, FieldLabel, LoadingRows, PageHeader, Panel, Toggle, clsx } from "@/components/ui";
import { get, post } from "@/lib/api";
import { usd } from "@/lib/format";
import { useSettings, useUpdateSetting, useVoicePrefs } from "@/lib/hooks";
import { browserSttAvailable, voice } from "@/lib/voice";

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/50 py-2.5 last:border-0">
      <div>
        <div className="text-sm text-ink">{label}</div>
        {hint && <div className="text-xs text-ink-3">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="flex rounded-lg border border-line p-0.5" role="radiogroup" aria-label={label}>
      {options.map(([v, l]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}
          className={clsx("rounded-md px-2.5 py-1 text-xs", value === v ? "bg-cyan/15 text-cyan" : "text-ink-3 hover:text-ink")}>
          {l}
        </button>
      ))}
    </div>
  );
}

function UsageChart() {
  const { data } = useQuery({
    queryKey: ["usage"],
    queryFn: () => get<{ today_usd: number; daily_budget_usd: number; series: { day: string; cost_usd: number }[]; by_model: { model: string; calls: number; cost_usd: number }[] }>("/api/usage"),
  });
  const [today] = useState(() => Date.now());
  if (!data) return <LoadingRows rows={2} />;
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today - (6 - i) * 86400000).toISOString().slice(0, 10);
    return { day: d, cost: data.series.find((s) => s.day === d)?.cost_usd ?? 0 };
  });
  const max = Math.max(data.daily_budget_usd, ...days.map((d) => d.cost), 0.0001);
  return (
    <div>
      <div className="flex h-28 items-end gap-2" role="img" aria-label="AI spend over the last 7 days">
        {days.map((d) => (
          <div key={d.day} className="flex flex-1 flex-col items-center gap-1">
            <div className="w-full rounded-t bg-gradient-to-t from-cyan/30 to-cyan/80" style={{ height: `${Math.max(2, (d.cost / max) * 96)}px` }} title={`${d.day}: ${usd(d.cost)}`} />
            <span className="font-mono text-[9px] text-ink-4">{d.day.slice(5)}</span>
          </div>
        ))}
      </div>
      <ul className="mt-3 space-y-1 text-xs">
        {data.by_model.map((m) => (
          <li key={m.model} className="flex gap-2"><span className="font-mono text-ice">{m.model}</span><span className="text-ink-3">{m.calls} calls</span><span className="ml-auto font-mono text-ink-2">{usd(m.cost_usd)}</span></li>
        ))}
      </ul>
    </div>
  );
}

export default function SettingsPage() {
  const { data, isLoading } = useSettings();
  const update = useUpdateSetting();
  const voicePrefs = useVoicePrefs();
  if (isLoading || !data) return <LoadingRows rows={8} />;
  return <SettingsForms data={data} update={update} voicePrefs={voicePrefs} />;
}

function SettingsForms({
  data,
  update,
  voicePrefs,
}: {
  data: NonNullable<ReturnType<typeof useSettings>["data"]>;
  update: ReturnType<typeof useUpdateSetting>;
  voicePrefs: ReturnType<typeof useVoicePrefs>;
}) {
  // Forms start from the loaded settings; this component mounts only once data exists.
  const [budget, setBudget] = useState(() => String(data.values.budget.daily_usd ?? data.server.default_daily_budget_usd));
  const [allowlist, setAllowlist] = useState(() => data.values.web_allowlist.join("\n"));
  const [tz, setTz] = useState(() => data.values.timezone);
  const [pw, setPw] = useState({ current: "", next: "" });
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [perm, setPerm] = useState<string>(() => (typeof Notification !== "undefined" ? Notification.permission : "default"));

  const v = data.values;
  const s = data.server;
  const save = async (key: string, value: unknown, msg = "Saved") => {
    setError(null);
    try {
      await update(key, value);
      setNotice(msg);
      setTimeout(() => setNotice(null), 2500);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <PageHeader title="Settings" description="Models, voice, interface, privacy and account." actions={notice && <Chip tone="success">{notice}</Chip>} />
      <ErrorNote error={error} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="AI provider" icon={Bot}>
          <Row label="Provider" hint="Configured on the server (environment variables)."><Chip tone={s.ai_provider === "none" ? "amber" : s.ai_provider === "scripted" ? "amber" : "success"}>{s.ai_provider}</Chip></Row>
          <Row label="Primary model"><span className="font-mono text-xs text-ice">{s.anthropic_model}</span></Row>
          <Row label="Fast model" hint={s.model_routing === "auto" ? "Used automatically for short, simple requests." : "Routing disabled."}><span className="font-mono text-xs text-ice">{s.anthropic_fast_model}</span></Row>
          <Row label="Effort / step limit"><span className="font-mono text-xs text-ink-2">{s.effort} · {s.max_steps_per_run} steps per task</span></Row>
          <Row label="Daily budget (USD)" hint="Runs stop when today's estimated spend reaches this.">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void save("budget", { daily_usd: Number(budget) }); }}>
              <input className="field h-8 w-24" type="number" min={0} max={1000} step="0.5" value={budget} onChange={(e) => setBudget(e.target.value)} aria-label="Daily budget in USD" />
              <Button type="submit" className="h-8">Save</Button>
            </form>
          </Row>
          <div className="mt-3"><UsageChart /></div>
        </Panel>

        <Panel title="Voice" icon={Volume2}>
          <Row label="Speech recognition" hint={v.voice.stt === "browser" ? "Browser engine — in Chrome, audio is processed by Google." : `Server: ${s.stt_engine} (offline PocketSphinx is private but less accurate).`}>
            <Segmented label="Speech recognition" value={v.voice.stt} options={[["server", "Server"], ["browser", "Browser"]] as const}
              onChange={(x) => void save("voice", { ...v.voice, stt: x })} />
          </Row>
          {v.voice.stt === "browser" && !browserSttAvailable() && <p className="text-xs text-amber">This browser has no Web Speech API; server recognition will be used.</p>}
          <Row label="Spoken responses" hint={v.voice.tts === "browser" ? "Browser voices; the core's speaking animation is approximated from word timing." : "Server audio; the core reacts to real playback amplitude."}>
            <Segmented label="Spoken responses" value={v.voice.tts} options={[["server", "Server"], ["browser", "Browser"], ["off", "Off"]] as const}
              onChange={(x) => void save("voice", { ...v.voice, tts: x })} />
          </Row>
          <Toggle checked={v.voice.auto_speak} onChange={(x) => void save("voice", { ...v.voice, auto_speak: x })} label="Speak replies to voice requests" />
          <Toggle checked={v.voice.auto_stop ?? true} onChange={(x) => void save("voice", { ...v.voice, auto_stop: x })} label="Stop listening after silence" description="Ends hands-free capture ~1.2 s after you stop talking." />
          <Row label="Speaking rate">
            <input type="range" min={0.6} max={1.6} step={0.1} value={v.voice.rate} onChange={(e) => void save("voice", { ...v.voice, rate: Number(e.target.value) })} aria-label="Speaking rate" className="accent-[var(--color-cyan)]" />
          </Row>
          <Button icon={Volume2} className="mt-2" onClick={() => void voice.speak("Good evening. All systems are online and ready.", voicePrefs).catch((e) => setError(e))}>
            Test voice
          </Button>
          <p className="mt-3 text-[11px] text-ink-4">The microphone opens only while you hold push-to-talk (or during hands-free capture you start), shown by the red “Mic live” indicator. Audio is never stored.</p>
        </Panel>

        <Panel title="Interface" icon={MonitorCog}>
          <Row label="Graphics quality" hint="Adaptive quality also steps down automatically when the frame rate drops.">
            <Segmented label="Graphics quality" value={v.interface.quality} options={[["low", "Low"], ["medium", "Med"], ["high", "High"], ["ultra", "Ultra"]] as const}
              onChange={(x) => void save("interface", { ...v.interface, quality: x })} />
          </Row>
          <Row label="Core renderer">
            <Segmented label="Core renderer" value={v.interface.render_mode} options={[["3d", "3D"], ["2d", "2D"]] as const}
              onChange={(x) => void save("interface", { ...v.interface, render_mode: x })} />
          </Row>
          <Toggle checked={v.interface.reduced_motion} onChange={(x) => void save("interface", { ...v.interface, reduced_motion: x })} label="Reduced motion" description="Also enabled automatically by your OS accessibility setting." />
          <Toggle checked={v.interface.show_stats} onChange={(x) => void save("interface", { ...v.interface, show_stats: x })} label="Show performance stats" description="FPS, draw calls and resolution overlay on the core." />
        </Panel>

        <Panel title="Notifications" icon={Bell}>
          <Row label="Browser notifications" hint="Shown when JARVIS is in a background tab.">
            {perm === "granted" ? <Chip tone="success">enabled</Chip> : (
              <Button className="h-8" onClick={async () => setPerm(await Notification.requestPermission())} disabled={perm === "denied"}>
                {perm === "denied" ? "Blocked in browser" : "Enable"}
              </Button>
            )}
          </Row>
        </Panel>

        <Panel title="Privacy & web" icon={Globe}>
          <Row label="Timezone" hint="Used for times in prompts and briefings.">
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void save("timezone", tz); }}>
              <input className="field h-8 w-44" value={tz} onChange={(e) => setTz(e.target.value)} aria-label="Timezone" />
              <Button type="submit" className="h-8">Save</Button>
              <Button className="h-8" onClick={() => { const mine = Intl.DateTimeFormat().resolvedOptions().timeZone; setTz(mine); void save("timezone", mine); }}>Use mine</Button>
            </form>
          </Row>
          <FieldLabel htmlFor="allowlist">Web allow-list (one domain per line)</FieldLabel>
          <textarea id="allowlist" className="field min-h-28 py-2 font-mono text-xs" value={allowlist} onChange={(e) => setAllowlist(e.target.value)} />
          <Button className="mt-2" onClick={() => void save("web_allowlist", allowlist.split(/\s+/).filter(Boolean), "Allow-list saved")}>Save allow-list</Button>
        </Panel>

        <Panel title="Desktop companion" icon={Laptop}><DesktopPairing /></Panel>

        <Panel title="Two-factor authentication" icon={ShieldCheck}><TwoFactor /></Panel>

        <Panel title="Account" icon={KeyRound}>
          <form
            className="space-y-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                const r = await post<{ revoked_sessions: number }>("/api/auth/password", { current_password: pw.current, new_password: pw.next });
                setPw({ current: "", next: "" });
                setNotice(`Password changed; ${r.revoked_sessions} other session(s) signed out`);
              } catch (err) {
                setError(err);
              }
            }}
          >
            <FieldLabel htmlFor="pw-current">Current password</FieldLabel>
            <input id="pw-current" type="password" className="field" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            <FieldLabel htmlFor="pw-next">New password (min 12)</FieldLabel>
            <input id="pw-next" type="password" className="field" autoComplete="new-password" minLength={12} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            <div className="flex gap-2 pt-1">
              <Button type="submit" disabled={!pw.current || pw.next.length < 12}>Change password</Button>
              <Button variant="ghost" icon={LogOut} className="ml-auto" onClick={async () => { await post("/api/auth/logout"); await refreshAuth(); }}>Sign out</Button>
            </div>
          </form>
        </Panel>
      </div>
    </>
  );
}
