"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileClock, KeyRound, LogOut, OctagonX, ShieldAlert, ShieldCheck, SlidersHorizontal, Smartphone } from "lucide-react";
import { useState } from "react";
import type { Approval } from "@jarvis/protocol";
import { ApprovalCard } from "@/components/approvals";
import { Button, Chip, EmptyState, ErrorNote, LoadingRows, PageHeader, Panel, Stat, clsx, riskTone, statusTone } from "@/components/ui";
import { get, post, put } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { usePendingApprovals, useJarvis } from "@/lib/store";

interface ToolInfo {
  name: string;
  title: string;
  description: string;
  category: string;
  risk: string;
  side_effects: boolean;
  default_policy: string;
  requires: string[];
  override: string | null;
  approval_client_kind: string | null;
}

function EmergencyStop() {
  const active = useJarvis((s) => s.system?.emergency_stop ?? false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className={clsx("holo-panel overflow-hidden p-5", active && "border-danger/60")}>
      <div className="flex flex-wrap items-center gap-4">
        <div className={clsx("grid size-14 place-items-center rounded-full border-2", active ? "border-danger bg-danger/20 text-danger" : "border-danger/50 text-danger/80")}>
          <OctagonX className="size-7" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-lg text-ink">Emergency stop</h2>
          <p className="text-sm text-ink-3">
            {active
              ? "Engaged — all side-effecting tools are blocked, scheduled jobs are deferred, and paired desktops refuse actions."
              : "Immediately cancels every running task and blocks all agent actions until released."}
          </p>
          {result && <p className="mt-1 text-xs text-ink-2">{result}</p>}
        </div>
        <Button
          variant={active ? "default" : "danger"}
          loading={busy}
          className="h-11 px-5 text-sm"
          data-testid="emergency-stop"
          onClick={async () => {
            setBusy(true);
            try {
              const r = await post<{ active: boolean; cancelled_runs: number }>("/api/security/emergency-stop", { active: !active });
              setResult(r.active ? `Stopped. ${r.cancelled_runs} running task(s) cancelled.` : "Released.");
            } finally {
              setBusy(false);
            }
          }}
        >
          {active ? "Release" : "Engage stop"}
        </Button>
      </div>
    </div>
  );
}

function ToolPermissions() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["tools"], queryFn: () => get<ToolInfo[]>("/api/tools") });
  const [error, setError] = useState<unknown>(null);
  async function setPolicy(tool: ToolInfo, value: string) {
    setError(null);
    const policies: Record<string, string> = {};
    for (const t of data ?? []) if (t.override) policies[t.name] = t.override;
    policies[tool.name] = value;
    try {
      await put("/api/settings/tool-policies", { policies });
      await qc.invalidateQueries({ queryKey: ["tools"] });
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Panel title="Tool permissions" icon={SlidersHorizontal} bodyClassName="p-0">
      <ErrorNote error={error} />
      {isLoading ? (
        <div className="p-4"><LoadingRows rows={6} /></div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-line text-ink-4">
                <th className="px-4 py-2 font-normal">Tool</th>
                <th className="px-2 py-2 font-normal">Risk</th>
                <th className="px-2 py-2 font-normal">Default</th>
                <th className="px-4 py-2 font-normal">Your policy</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((t) => (
                <tr key={t.name} className="border-b border-line/50 align-top">
                  <td className="px-4 py-2.5">
                    <div className="text-ink">{t.title}</div>
                    <div className="font-mono text-[10px] text-ink-4">
                      {t.name}
                      {t.requires.length > 0 && ` · needs ${t.requires.join(", ")}`}
                      {t.approval_client_kind && ` · approve on ${t.approval_client_kind}`}
                    </div>
                  </td>
                  <td className="px-2 py-2.5"><Chip tone={riskTone(t.risk)}>{t.risk.replace("_", " ")}</Chip></td>
                  <td className="px-2 py-2.5"><Chip tone={statusTone(t.default_policy)}>{t.default_policy}</Chip></td>
                  <td className="px-4 py-2.5">
                    <select
                      aria-label={`Policy for ${t.title}`}
                      className="field h-8 w-28 text-xs"
                      value={t.override ?? "default"}
                      onChange={(e) => void setPolicy(t, e.target.value)}
                    >
                      <option value="default">Default</option>
                      <option value="ask">Always ask</option>
                      <option value="auto" disabled={["high", "critical"].includes(t.risk)}>Auto</option>
                      <option value="deny">Deny</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export default function SecurityCentre() {
  const qc = useQueryClient();
  const pending = usePendingApprovals();
  const { data: overview } = useQuery({
    queryKey: ["security-overview"],
    queryFn: () => get<{ denied_or_failed_7d: number; pending_approvals: number; active_sessions: number; failed_logins_7d: number; posture: { secret_key_configured: boolean; secure_cookies: boolean; environment: string; allowed_origins: string[] } }>("/api/security/overview"),
  });
  const { data: sessions } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => get<{ id: string; client_kind: string; user_agent: string; ip: string; last_seen_at: string; current: boolean }[]>("/api/auth/sessions"),
  });
  const { data: history } = useQuery({ queryKey: ["approvals", "history"], queryFn: () => get<Approval[]>("/api/approvals") });
  const [auditFilter, setAuditFilter] = useState("");
  const { data: audit, isLoading: auditLoading } = useQuery({
    queryKey: ["audit", auditFilter],
    queryFn: () => get<{ id: number; ts: string; actor: string; action: string; target: string; outcome: string; details: Record<string, unknown> }[]>(`/api/audit?limit=200${auditFilter ? `&action=${auditFilter}` : ""}`),
    refetchInterval: 15000,
  });

  return (
    <>
      <PageHeader title="Security Centre" description="Approvals, permissions, sessions, audit trail and emergency controls." />
      <div className="space-y-4">
        <EmergencyStop />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <div className="holo-panel p-4"><Stat label="Pending approvals" value={pending.length} tone={pending.length ? "amber" : undefined} /></div>
          <div className="holo-panel p-4"><Stat label="Active sessions" value={overview?.active_sessions ?? "—"} /></div>
          <div className="holo-panel p-4"><Stat label="Denied / failed (7d)" value={overview?.denied_or_failed_7d ?? "—"} /></div>
          <div className="holo-panel p-4"><Stat label="Failed logins (7d)" value={overview?.failed_logins_7d ?? "—"} tone={overview?.failed_logins_7d ? "danger" : undefined} /></div>
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Approval queue" icon={ShieldAlert}>
            {pending.length === 0 ? (
              <EmptyState icon={ShieldCheck} title="Nothing awaiting approval" />
            ) : (
              <div className="space-y-3">{pending.map((a) => <ApprovalCard key={a.id} approval={a} />)}</div>
            )}
            <div className="data-label mt-5 mb-2">Recent decisions</div>
            <ul className="space-y-1.5">
              {history?.filter((a) => a.status !== "pending").slice(0, 8).map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-xs">
                  <Chip tone={statusTone(a.status)}>{a.status}</Chip>
                  <span className="truncate text-ink-2">{a.tool_title}</span>
                  <span className="ml-auto font-mono text-[10px] text-ink-4">{timeAgo(a.decided_at ?? a.requested_at)}</span>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel title="Active sessions" icon={Smartphone}>
            <ul className="space-y-2">
              {sessions?.map((s) => (
                <li key={s.id} className="flex items-center gap-3 rounded-lg border border-line bg-void/30 px-3 py-2 text-xs">
                  <Chip tone={s.client_kind === "desktop" ? "violet" : "cyan"}>{s.client_kind}</Chip>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-ink-2">{s.user_agent || "unknown client"}</div>
                    <div className="font-mono text-[10px] text-ink-4">{s.ip} · seen {timeAgo(s.last_seen_at)}</div>
                  </div>
                  {s.current ? (
                    <Chip tone="success">this device</Chip>
                  ) : (
                    <Button variant="ghost" icon={LogOut} className="h-7 text-xs" onClick={async () => { await post(`/api/auth/sessions/${s.id}/revoke`); await qc.invalidateQueries({ queryKey: ["sessions"] }); }}>
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {overview && (
              <>
                <div className="data-label mt-5 mb-2">Posture</div>
                <ul className="space-y-1.5 text-xs">
                  {[
                    ["Encryption key configured", overview.posture.secret_key_configured],
                    ["Secure (HTTPS-only) cookies", overview.posture.secure_cookies],
                  ].map(([label, ok]) => (
                    <li key={String(label)} className="flex items-center gap-2">
                      <KeyRound className={clsx("size-3.5", ok ? "text-success" : "text-amber")} aria-hidden />
                      <span className="text-ink-2">{label}</span>
                      <Chip tone={ok ? "success" : "amber"} className="ml-auto">{ok ? "yes" : "no"}</Chip>
                    </li>
                  ))}
                  <li className="text-ink-3">Environment: <span className="font-mono">{overview.posture.environment}</span></li>
                </ul>
              </>
            )}
          </Panel>
        </div>
        <ToolPermissions />
        <Panel
          title="Audit log"
          icon={FileClock}
          bodyClassName="p-0"
          actions={
            <select className="field h-7 w-36 text-xs" value={auditFilter} onChange={(e) => setAuditFilter(e.target.value)} aria-label="Filter audit log">
              <option value="">All events</option>
              <option value="auth">Authentication</option>
              <option value="tool">Tool actions</option>
              <option value="approval">Approvals</option>
              <option value="memory">Memory</option>
              <option value="integration">Integrations</option>
              <option value="security">Security</option>
              <option value="device">Devices</option>
            </select>
          }
        >
          {auditLoading ? (
            <div className="p-4"><LoadingRows rows={5} /></div>
          ) : (
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-midnight">
                  <tr className="border-b border-line text-ink-4">
                    <th className="px-4 py-2 font-normal">Time</th>
                    <th className="px-2 py-2 font-normal">Action</th>
                    <th className="px-2 py-2 font-normal">Target</th>
                    <th className="px-2 py-2 font-normal">Actor</th>
                    <th className="px-4 py-2 font-normal">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {audit?.map((a) => (
                    <tr key={a.id} className="border-b border-line/40" title={JSON.stringify(a.details)}>
                      <td className="px-4 py-1.5 font-mono whitespace-nowrap text-ink-3">{dateTime(a.ts)}</td>
                      <td className="px-2 py-1.5 font-mono text-ice">{a.action}</td>
                      <td className="max-w-48 truncate px-2 py-1.5 text-ink-2">{a.target}</td>
                      <td className="px-2 py-1.5 font-mono text-[10px] text-ink-4">{a.actor}</td>
                      <td className="px-4 py-1.5"><Chip tone={a.outcome === "ok" ? "success" : statusTone(a.outcome)}>{a.outcome}</Chip></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
