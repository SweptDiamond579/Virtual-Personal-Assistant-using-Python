"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, History, Play, Plus, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { useState } from "react";
import type { JobSummary } from "@jarvis/protocol";
import { Button, Chip, EmptyState, ErrorNote, FieldLabel, LoadingRows, PageHeader, Panel, Toggle, clsx, statusTone } from "@/components/ui";
import { del, get, patch, post } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";

interface Template { key: string; name: string; description: string; params: string[] }
interface WorkflowItem { id: string; name: string; description: string; definition: { steps: { id: string; tool: string }[] }; updated_at: string }
interface JobRun { id: string; status: string; attempt: number; started_at: string; finished_at: string | null; error: string | null; run_id: string | null }

function JobHistory({ jobId }: { jobId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["jobs", jobId, "runs"], queryFn: () => get<JobRun[]>(`/api/jobs/${jobId}/runs`) });
  if (isLoading) return <LoadingRows rows={2} />;
  if (!data?.length) return <p className="text-xs text-ink-3">Not run yet.</p>;
  return (
    <ul className="space-y-1">
      {data.map((r) => (
        <li key={r.id} className="flex items-center gap-2 text-[11px]">
          <Chip tone={statusTone(r.status)}>{r.status}</Chip>
          <span className="font-mono text-ink-3">{dateTime(r.started_at)}</span>
          {r.attempt > 1 && <span className="text-ink-4">attempt {r.attempt}</span>}
          {r.error && <span className="truncate text-danger">{r.error}</span>}
        </li>
      ))}
    </ul>
  );
}

function Jobs() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["jobs"], queryFn: () => get<JobSummary[]>("/api/jobs") });
  const [open, setOpen] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["jobs"] });
  return (
    <Panel title="Scheduled jobs" icon={CalendarClock}>
      {isLoading ? <LoadingRows rows={4} /> : !data?.length ? (
        <EmptyState icon={CalendarClock} title="No scheduled jobs">Create one on the right, or schedule a workflow template.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {data.map((j) => (
            <li key={j.id} className="rounded-lg border border-line bg-surface/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink">{j.name}</span>
                <Chip tone="violet">{j.kind.replace("_", " ")}</Chip>
                {j.schedule ? <Chip tone="cyan" title="cron, UTC">{j.schedule}</Chip> : <Chip>one-off</Chip>}
                {j.last_status && <Chip tone={statusTone(j.last_status)}>{j.last_status}</Chip>}
                <div className="ml-auto flex items-center gap-1">
                  <Button variant="ghost" className="h-7 text-xs" icon={Play} onClick={async () => { await post(`/api/jobs/${j.id}/run-now`); setTimeout(() => void refresh(), 800); }}>Run now</Button>
                  <Button variant="ghost" className="h-7 text-xs" icon={History} onClick={() => setOpen(open === j.id ? null : j.id)}>History</Button>
                  <Button variant="ghost" className="h-7 text-xs text-danger" icon={Trash2} aria-label={`Delete ${j.name}`} onClick={async () => { await del(`/api/jobs/${j.id}`); await refresh(); }} />
                </div>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-ink-3">
                <span>Next: <span className="font-mono">{j.enabled ? dateTime(j.next_run_at) : "—"}</span></span>
                <span>Last: <span className="font-mono">{timeAgo(j.last_run_at)}</span></span>
                <label className="ml-auto flex items-center gap-2">
                  <span>Enabled</span>
                  <input type="checkbox" checked={j.enabled} onChange={async (e) => { await patch(`/api/jobs/${j.id}`, { enabled: e.target.checked }); await refresh(); }} className="accent-[var(--color-cyan)]" />
                </label>
              </div>
              {open === j.id && <div className="mt-3 border-t border-line pt-3"><JobHistory jobId={j.id} /></div>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function NewJob() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"reminder" | "agent_task" | "health_check">("reminder");
  const [name, setName] = useState("");
  const [recurring, setRecurring] = useState(false);
  const [cron, setCron] = useState("0 8 * * 1-5");
  const [at, setAt] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<unknown>(null);
  async function create() {
    setError(null);
    const payload = kind === "reminder" ? { text } : kind === "agent_task" ? { prompt: text } : { notify_always: true };
    try {
      await post("/api/jobs", {
        name: name || (kind === "reminder" ? `Reminder: ${text}` : kind === "agent_task" ? text.slice(0, 60) : "Health check"),
        kind,
        schedule: recurring ? cron : null,
        run_at: recurring ? null : at ? new Date(at).toISOString() : null,
        payload,
        max_runtime_s: kind === "agent_task" ? 300 : 60,
        max_retries: kind === "agent_task" ? 0 : 1,
      });
      setText("");
      setName("");
      await qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Panel title="New job" icon={Plus}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-1 rounded-lg border border-line p-1" role="radiogroup" aria-label="Job type">
          {(["reminder", "agent_task", "health_check"] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              className={clsx("rounded-md py-1.5 text-[11px]", kind === k ? "bg-cyan/15 text-cyan" : "text-ink-3 hover:text-ink")}>
              {k === "agent_task" ? "Agent task" : k === "health_check" ? "Health check" : "Reminder"}
            </button>
          ))}
        </div>
        <div>
          <FieldLabel htmlFor="job-name">Name (optional)</FieldLabel>
          <input id="job-name" className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {kind !== "health_check" && (
          <div>
            <FieldLabel htmlFor="job-text">{kind === "reminder" ? "Reminder text" : "Instruction for JARVIS"}</FieldLabel>
            <textarea id="job-text" className="field min-h-16 py-2" value={text} onChange={(e) => setText(e.target.value)}
              placeholder={kind === "agent_task" ? "e.g. Summarise open PRs in my watched repos and save a note" : "e.g. Stand-up meeting"} />
            {kind === "agent_task" && <p className="mt-1 text-[11px] text-ink-4">Runs unattended under the same permissions; anything needing approval waits for you. Max 5 minutes.</p>}
          </div>
        )}
        <Toggle checked={recurring} onChange={setRecurring} label="Recurring" description="Cron schedule in UTC (minimum every 5 minutes)." />
        {recurring ? (
          <div>
            <FieldLabel htmlFor="job-cron">Cron expression (UTC)</FieldLabel>
            <input id="job-cron" className="field font-mono" value={cron} onChange={(e) => setCron(e.target.value)} />
          </div>
        ) : (
          <div>
            <FieldLabel htmlFor="job-at">Run at</FieldLabel>
            <input id="job-at" type="datetime-local" className="field" value={at} onChange={(e) => setAt(e.target.value)} />
          </div>
        )}
        <ErrorNote error={error} />
        <Button variant="primary" icon={Plus} className="w-full" onClick={create} disabled={(kind !== "health_check" && !text.trim()) || (!recurring && !at)}>
          Schedule
        </Button>
      </div>
    </Panel>
  );
}

function Workflows() {
  const qc = useQueryClient();
  const { data: templates } = useQuery({ queryKey: ["templates"], queryFn: () => get<Template[]>("/api/workflow-templates") });
  const { data: workflows, isLoading } = useQuery({ queryKey: ["workflows"], queryFn: () => get<WorkflowItem[]>("/api/workflows") });
  const [params, setParams] = useState<Record<string, string>>({});
  const [schedule, setSchedule] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [started, setStarted] = useState<string | null>(null);
  return (
    <Panel title="Workflows" icon={WorkflowIcon}>
      <div className="data-label mb-2">Templates</div>
      <div className="mb-5 grid gap-3 md:grid-cols-2">
        {templates?.map((t) => (
          <div key={t.key} className="rounded-lg border border-line bg-surface/40 p-3">
            <div className="text-sm text-ink">{t.name}</div>
            <p className="mt-0.5 text-xs text-ink-3">{t.description}</p>
            {t.params.map((p) => (
              <input key={p} className="field mt-2 h-8 text-xs" placeholder={p === "repo" ? (t.key === "daily_briefing" ? "owner/repo (optional)" : "owner/repo (required)") : p}
                value={params[`${t.key}.${p}`] ?? ""} onChange={(e) => setParams({ ...params, [`${t.key}.${p}`]: e.target.value })} aria-label={`${t.name} ${p}`} />
            ))}
            <input className="field mt-2 h-8 font-mono text-xs" placeholder="cron (optional), e.g. 30 7 * * *" value={schedule[t.key] ?? ""}
              onChange={(e) => setSchedule({ ...schedule, [t.key]: e.target.value })} aria-label={`${t.name} schedule`} />
            <Button className="mt-2 h-8 w-full text-xs" icon={Play} onClick={async () => {
              setError(null);
              try {
                const p = Object.fromEntries(t.params.map((k) => [k, params[`${t.key}.${k}`] ?? ""]));
                await post(`/api/workflow-templates/${t.key}/instantiate`, { params: p, schedule: schedule[t.key] || null, run_now: !schedule[t.key] });
                setStarted(t.key);
                await qc.invalidateQueries({ queryKey: ["workflows"] });
                await qc.invalidateQueries({ queryKey: ["jobs"] });
              } catch (e) {
                setError(e);
              }
            }}>
              {schedule[t.key] ? "Save & schedule" : started === t.key ? "Started — see Mission Control" : "Create & run now"}
            </Button>
          </div>
        ))}
      </div>
      <ErrorNote error={error} />
      <div className="data-label mb-2">Saved workflows</div>
      {isLoading ? <LoadingRows /> : !workflows?.length ? <p className="text-xs text-ink-3">None yet.</p> : (
        <ul className="space-y-2">
          {workflows.map((w) => (
            <li key={w.id} className="flex items-center gap-3 rounded-lg border border-line bg-surface/40 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-ink">{w.name}</div>
                <div className="truncate font-mono text-[10px] text-ink-4">{w.definition.steps.map((s) => s.tool).join(" → ")}</div>
              </div>
              <Button variant="ghost" className="h-7 text-xs" icon={Play} onClick={() => post(`/api/workflows/${w.id}/run`)}>Run</Button>
              <Button variant="ghost" className="h-7 text-xs text-danger" icon={Trash2} aria-label={`Delete ${w.name}`} onClick={async () => { await del(`/api/workflows/${w.id}`); await qc.invalidateQueries({ queryKey: ["workflows"] }); }} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function AutomationCentre() {
  return (
    <>
      <PageHeader title="Automation Centre" description="Database-backed schedules and bounded multi-step workflows. Every step goes through the same permission and approval gates." />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-4">
          <Jobs />
          <Workflows />
        </div>
        <NewJob />
      </div>
    </>
  );
}
