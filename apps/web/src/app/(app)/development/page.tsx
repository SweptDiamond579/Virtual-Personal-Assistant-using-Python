"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleDot, CircleX, GitPullRequest, FolderGit2, Lightbulb, LineChart, Plus, X } from "lucide-react";
import { useState } from "react";
import { Button, Chip, EmptyState, ErrorNote, LoadingRows, PageHeader, Panel, Stat, clsx } from "@/components/ui";
import { get } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useSettings, useUpdateSetting } from "@/lib/hooks";

interface Overview {
  mode: string;
  repo: string;
  description: string | null;
  default_branch: string;
  stars: number;
  language: string | null;
  html_url: string;
  pushed_at: string;
  pull_requests: { number: number; title: string; author: string; url: string; draft: boolean; updated_at: string }[];
  issues: { number: number; title: string; url: string; updated_at: string }[];
  workflow_runs: { id: number; name: string | null; status: string | null; conclusion: string | null; branch: string | null; url: string; created_at: string }[];
}

interface Insights {
  tools: { tool: string; calls: number; succeeded: number; denied: number; success_rate: number | null; avg_ms: number }[];
  runs: { kind: string; status: string; count: number }[];
  feedback: { positive: number; negative: number };
  recent_failures: { tool: string; error: string | null; at: string }[];
  suggestions: string[];
}

function RunIcon({ conclusion, status }: { conclusion: string | null; status: string | null }) {
  if (status !== "completed") return <CircleDot className="size-3.5 animate-pulse text-amber" aria-label="in progress" />;
  if (conclusion === "success") return <CircleCheck className="size-3.5 text-success" aria-label="success" />;
  if (conclusion === "failure") return <CircleX className="size-3.5 text-danger" aria-label="failure" />;
  return <CircleDot className="size-3.5 text-ink-4" aria-label={conclusion ?? "unknown"} />;
}

function RepoCard({ repo, onRemove }: { repo: string; onRemove: () => void }) {
  const [owner, name] = repo.split("/");
  const { data, isLoading, error } = useQuery({
    queryKey: ["repo", repo],
    queryFn: () => get<Overview>(`/api/dev/repos/${owner}/${name}`),
    staleTime: 120_000,
  });
  return (
    <Panel
      title={repo}
      icon={FolderGit2}
      actions={
        <>
          {data && <Chip tone={data.mode === "authenticated" ? "success" : "cyan"}>{data.mode}</Chip>}
          <button type="button" onClick={onRemove} className="text-ink-4 hover:text-ink" aria-label={`Stop watching ${repo}`}>
            <X className="size-3.5" aria-hidden />
          </button>
        </>
      }
    >
      {isLoading ? <LoadingRows rows={4} /> : error ? <ErrorNote error={error} /> : data && (
        <div className="space-y-4">
          {data.description && <p className="text-xs text-ink-3">{data.description}</p>}
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Open PRs" value={data.pull_requests.length} />
            <Stat label="Open issues" value={data.issues.length} />
            <Stat label="Failing runs" value={data.workflow_runs.filter((r) => r.conclusion === "failure").length} tone={data.workflow_runs.some((r) => r.conclusion === "failure") ? "danger" : undefined} />
          </div>
          <div>
            <div className="data-label mb-1.5">Pull requests</div>
            {data.pull_requests.length === 0 ? <p className="text-xs text-ink-4">None open.</p> : (
              <ul className="space-y-1">
                {data.pull_requests.map((p) => (
                  <li key={p.number} className="flex items-center gap-2 text-xs">
                    <GitPullRequest className={clsx("size-3.5", p.draft ? "text-ink-4" : "text-success")} aria-hidden />
                    <a href={p.url} target="_blank" rel="noreferrer noopener" className="truncate text-ink-2 hover:text-cyan">#{p.number} {p.title}</a>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-4">{p.author} · {timeAgo(p.updated_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="data-label mb-1.5">CI runs</div>
            {data.workflow_runs.length === 0 ? <p className="text-xs text-ink-4">No GitHub Actions runs.</p> : (
              <ul className="space-y-1">
                {data.workflow_runs.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-xs">
                    <RunIcon conclusion={r.conclusion} status={r.status} />
                    <a href={r.url} target="_blank" rel="noreferrer noopener" className="truncate text-ink-2 hover:text-cyan">{r.name}</a>
                    <span className="font-mono text-[10px] text-ink-4">{r.branch}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-4">{timeAgo(r.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}

function SelfAnalysis() {
  const { data, isLoading } = useQuery({ queryKey: ["insights"], queryFn: () => get<Insights>("/api/insights?days=14"), refetchInterval: 60_000 });
  return (
    <Panel title="Self-analysis (14 days)" icon={LineChart}>
      {isLoading || !data ? <LoadingRows rows={4} /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Tool calls" value={data.tools.reduce((n, t) => n + t.calls, 0)} />
            <Stat label="👍 feedback" value={data.feedback.positive} tone="success" />
            <Stat label="👎 feedback" value={data.feedback.negative} tone={data.feedback.negative ? "danger" : undefined} />
          </div>
          {data.suggestions.length > 0 && (
            <ul className="space-y-1.5">
              {data.suggestions.map((s) => (
                <li key={s} className="flex gap-2 rounded-lg border border-amber/30 bg-amber/5 p-2 text-xs text-ink-2">
                  <Lightbulb className="size-3.5 shrink-0 text-amber" aria-hidden /> {s}
                </li>
              ))}
            </ul>
          )}
          <table className="w-full text-left text-xs">
            <thead><tr className="text-ink-4"><th className="py-1 font-normal">Tool</th><th className="font-normal">Calls</th><th className="font-normal">Success</th><th className="font-normal">Avg</th></tr></thead>
            <tbody>
              {data.tools.map((t) => (
                <tr key={t.tool} className="border-t border-line/50">
                  <td className="py-1.5 font-mono text-ice">{t.tool}</td>
                  <td className="tabular-nums text-ink-2">{t.calls}</td>
                  <td>
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-16 overflow-hidden rounded-full bg-surface-2">
                        <div className={clsx("h-full", (t.success_rate ?? 0) > 0.8 ? "bg-success" : (t.success_rate ?? 0) > 0.5 ? "bg-amber" : "bg-danger")} style={{ width: `${(t.success_rate ?? 0) * 100}%` }} />
                      </div>
                      <span className="tabular-nums text-ink-3">{t.success_rate == null ? "—" : `${Math.round(t.success_rate * 100)}%`}</span>
                    </div>
                  </td>
                  <td className="font-mono text-ink-3">{t.avg_ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.tools.length === 0 && <EmptyState title="No tool activity yet" />}
          {data.recent_failures.length > 0 && (
            <div>
              <div className="data-label mb-1.5">Recent failures</div>
              <ul className="space-y-1 text-xs">
                {data.recent_failures.map((f, i) => (
                  <li key={i} className="truncate"><span className="font-mono text-danger">{f.tool}</span> <span className="text-ink-3">{f.error}</span></li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-ink-4">
            Metrics are computed from real execution traces and your feedback. JARVIS proposes improvements here; it never changes its own permissions or deploys code changes.
          </p>
        </div>
      )}
    </Panel>
  );
}

export default function Development() {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const update = useUpdateSetting();
  const watched = settings?.values.watched_repos ?? [];
  const [input, setInput] = useState("");
  const [error, setError] = useState<unknown>(null);
  async function save(list: string[]) {
    setError(null);
    try {
      await update("watched_repos", list);
      await qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      setError(e);
    }
  }
  return (
    <>
      <PageHeader
        title="Development"
        description="Watched repositories, pull requests and CI results — plus JARVIS's analysis of its own tool performance."
        actions={
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (/^[\w.-]+\/[\w.-]+$/.test(input)) { void save([...new Set([...watched, input])]); setInput(""); } }}>
            <input className="field h-9 w-56 font-mono text-xs" placeholder="owner/repository" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Repository to watch" />
            <Button type="submit" icon={Plus} variant="primary">Watch</Button>
          </form>
        }
      />
      <ErrorNote error={error} />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="grid content-start gap-4 lg:grid-cols-2">
          {watched.length === 0 && (
            <div className="lg:col-span-2">
              <Panel title="Repositories" icon={FolderGit2}>
                <EmptyState icon={FolderGit2} title="No watched repositories">Add one above. Public repositories work without a token.</EmptyState>
              </Panel>
            </div>
          )}
          {watched.map((r) => (
            <RepoCard key={r} repo={r} onRemove={() => void save(watched.filter((x) => x !== r))} />
          ))}
        </div>
        <SelfAnalysis />
      </div>
    </>
  );
}
