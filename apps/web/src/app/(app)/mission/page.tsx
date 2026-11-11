"use client";

import { useQuery } from "@tanstack/react-query";
import { Activity, CircleStop, GitBranch, ListTree, ShieldAlert } from "lucide-react";
import { motion } from "motion/react";
import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { RunStep, RunSummary } from "@jarvis/protocol";
import { ApprovalCard } from "@/components/approvals";
import { Button, Chip, EmptyState, JsonBlock, LoadingRows, PageHeader, Panel, StatusDot, clsx, statusTone } from "@/components/ui";
import { get, post } from "@/lib/api";
import { clockTime, duration, timeAgo, usd } from "@/lib/format";
import { usePendingApprovals, useJarvis } from "@/lib/store";

const FILTERS = ["all", "active", "succeeded", "failed", "cancelled"] as const;

function RunRow({ run, selected, onSelect }: { run: RunSummary; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={clsx(
        "flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
        selected ? "border-cyan/40 bg-cyan/[0.07]" : "border-transparent hover:border-line hover:bg-surface/40",
      )}
    >
      <StatusDot tone={statusTone(run.status)} pulse={run.status === "running" || run.status === "waiting_approval"} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink">{run.title || run.kind}</div>
        <div className="flex gap-2 text-[11px] text-ink-3">
          <span className="uppercase">{run.kind}</span>
          {run.model && <span className="truncate font-mono">{run.model}</span>}
          {run.usage.cost_usd > 0 && <span className="font-mono">{usd(run.usage.cost_usd)}</span>}
        </div>
      </div>
      <div className="text-right">
        <Chip tone={statusTone(run.status)}>{run.status.replace("_", " ")}</Chip>
        <div className="mt-1 font-mono text-[10px] text-ink-4">{timeAgo(run.created_at)}</div>
      </div>
    </button>
  );
}

function StepNode({ step, last }: { step: RunStep; last: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="relative pl-7">
      {!last && <span className="absolute top-5 bottom-0 left-[7px] w-px bg-gradient-to-b from-line-3 to-line" aria-hidden />}
      <span
        className={clsx(
          "absolute top-1.5 left-0 grid size-[15px] place-items-center rounded-full border",
          step.status === "running" ? "border-cyan bg-cyan/20" : step.status === "succeeded" ? "border-success/60 bg-success/15" : step.status === "denied" || step.status === "failed" ? "border-danger/60 bg-danger/15" : "border-line-2 bg-surface",
        )}
        aria-hidden
      >
        {step.status === "running" && <span className="size-1.5 animate-ping rounded-full bg-cyan" />}
      </span>
      <button type="button" onClick={() => setOpen(!open)} className="w-full pb-4 text-left" aria-expanded={open}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="data-label">{step.kind.replace("_", " ")}</span>
          <span className="font-mono text-xs text-ice">{step.name}</span>
          <Chip tone={statusTone(step.status)}>{step.status}</Chip>
          <span className="ml-auto font-mono text-[10px] text-ink-4">
            {clockTime(step.started_at)} · {duration(step.duration_ms)}
          </span>
        </div>
        {step.summary && <p className="mt-1 text-xs text-ink-2">{step.summary}</p>}
        {step.error && step.error !== step.summary && <p className="mt-1 text-xs text-danger">{step.error}</p>}
      </button>
      {open && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="mb-4 grid gap-2 lg:grid-cols-2">
          <div>
            <div className="data-label mb-1">Input</div>
            <JsonBlock value={step.input} />
          </div>
          <div>
            <div className="data-label mb-1">Output</div>
            <JsonBlock value={step.output} />
          </div>
        </motion.div>
      )}
    </li>
  );
}

function RunDetail({ runId }: { runId: string }) {
  const liveSteps = useJarvis((s) => s.steps[runId]);
  const liveRun = useJarvis((s) => s.runs[runId]);
  const { data, isLoading } = useQuery({
    queryKey: ["run", runId, liveRun?.status, liveSteps?.length],
    queryFn: () => get<{ run: RunSummary; steps: RunStep[]; tainted: boolean; origin: string }>(`/api/runs/${runId}`),
  });
  if (isLoading || !data) return <LoadingRows rows={4} />;
  const run = liveRun ?? data.run;
  const active = ["queued", "running", "waiting_approval"].includes(run.status);
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-display text-lg text-ink">{run.title || run.kind}</h3>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Chip tone={statusTone(run.status)}>{run.status.replace("_", " ")}</Chip>
            <Chip>{run.kind}</Chip>
            <Chip>origin: {data.origin}</Chip>
            {data.tainted && <Chip tone="amber" title="Untrusted external content entered this run's context; side-effecting tools required approval.">untrusted content</Chip>}
            {run.model && <Chip tone="violet">{run.model}</Chip>}
          </div>
        </div>
        {active && (
          <Button variant="danger" icon={CircleStop} onClick={() => post(`/api/runs/${run.id}/cancel`)}>
            Cancel
          </Button>
        )}
      </div>
      <dl className="mb-5 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        {[
          ["Input tokens", run.usage.input_tokens.toLocaleString()],
          ["Output tokens", run.usage.output_tokens.toLocaleString()],
          ["Cache reads", run.usage.cache_read_tokens.toLocaleString()],
          ["Cost", usd(run.usage.cost_usd)],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-line bg-void/40 px-3 py-2">
            <dt className="data-label">{k}</dt>
            <dd className="mt-0.5 font-mono text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {run.error && <p className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-[#ffd0d8]">{run.error}</p>}
      <div className="data-label mb-2">Execution trace</div>
      {data.steps.length === 0 ? (
        <p className="text-xs text-ink-3">No steps recorded.</p>
      ) : (
        <ol>
          {(liveSteps && liveSteps.length > data.steps.length ? liveSteps : data.steps).map((s, i, arr) => (
            <StepNode key={s.id} step={s} last={i === arr.length - 1} />
          ))}
        </ol>
      )}
    </div>
  );
}

function MissionControl() {
  const params = useSearchParams();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [chosen, setSelected] = useState<string | null>(params.get("run"));
  const liveRuns = useJarvis((s) => s.runs);
  const pending = usePendingApprovals();
  const { data, isLoading } = useQuery({
    queryKey: ["runs", filter],
    queryFn: () => get<RunSummary[]>(`/api/runs?limit=100${filter !== "all" ? `&status=${filter}` : ""}`),
  });
  const runs = useMemo(() => (data ?? []).map((r) => liveRuns[r.id] ?? r), [data, liveRuns]);
  const selected = chosen ?? runs[0]?.id ?? null;

  return (
    <>
      <PageHeader title="Mission Control" description="Every task JARVIS performs — live status, execution traces, approvals and cost." />
      <div className="grid gap-4 lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          {pending.length > 0 && (
            <Panel title={`Awaiting approval (${pending.length})`} icon={ShieldAlert}>
              <div className="space-y-3">
                {pending.map((a) => (
                  <ApprovalCard key={a.id} approval={a} />
                ))}
              </div>
            </Panel>
          )}
          <Panel
            title="Tasks"
            icon={Activity}
            bodyClassName="p-2"
            actions={
              <div className="flex gap-0.5" role="tablist" aria-label="Filter tasks">
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={filter === f}
                    onClick={() => setFilter(f)}
                    className={clsx("rounded-md px-2 py-0.5 text-[10px] uppercase tracking-wider", filter === f ? "bg-cyan/15 text-cyan" : "text-ink-3 hover:text-ink")}
                  >
                    {f}
                  </button>
                ))}
              </div>
            }
          >
            {isLoading ? (
              <LoadingRows rows={6} />
            ) : runs.length === 0 ? (
              <EmptyState icon={GitBranch} title="No tasks yet">Start a conversation or run a workflow.</EmptyState>
            ) : (
              <div className="space-y-1">
                {runs.map((r) => (
                  <RunRow key={r.id} run={r} selected={selected === r.id} onSelect={() => setSelected(r.id)} />
                ))}
              </div>
            )}
          </Panel>
        </div>
        <Panel title="Task detail" icon={ListTree} className="lg:sticky lg:top-0 lg:self-start">
          {selected ? <RunDetail runId={selected} /> : <EmptyState icon={ListTree} title="Select a task to inspect its trace" />}
        </Panel>
      </div>
    </>
  );
}

export default function MissionPage() {
  return (
    <Suspense fallback={<LoadingRows rows={6} />}>
      <MissionControl />
    </Suspense>
  );
}
