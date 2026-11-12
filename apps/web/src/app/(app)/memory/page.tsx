"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Brain, Check, EyeOff, Pencil, Plus, Search, Trash2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { MemoryItem } from "@jarvis/protocol";
import { Button, Chip, EmptyState, ErrorNote, FieldLabel, LoadingRows, PageHeader, Panel, Toggle, clsx, statusTone } from "@/components/ui";
import { del, get, patch, post } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";

const KINDS = ["preference", "fact", "project", "note"] as const;

function MemoryCard({ m, all }: { m: MemoryItem & { score?: number }; all: MemoryItem[] }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(m.content);
  const [error, setError] = useState<unknown>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["memories"] });
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e);
    }
  };
  const conflicts = all.filter((x) => m.conflicts_with.includes(x.id) && x.status === "active");
  return (
    <article className={clsx("rounded-xl border p-3.5", m.status === "proposed" ? "border-cyan/30 bg-cyan/[0.04]" : "border-line bg-surface/40")} data-testid="memory-card">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone="violet">{m.kind}</Chip>
        <Chip tone={statusTone(m.status)}>{m.status}</Chip>
        {!m.share_with_model && (
          <Chip tone="amber" title="Never included in model prompts">
            <EyeOff className="size-3" aria-hidden /> private
          </Chip>
        )}
        {m.score != null && <span className="font-mono text-[10px] text-ink-4">score {m.score.toFixed(2)}</span>}
        <span className="ml-auto font-mono text-[10px] text-ink-4" title={dateTime(m.created_at)}>
          {m.source} · {timeAgo(m.created_at)}
        </span>
      </div>
      {editing ? (
        <div className="mt-2 space-y-2">
          <textarea className="field min-h-20 py-2" value={content} onChange={(e) => setContent(e.target.value)} aria-label="Memory content" />
          <div className="flex gap-2">
            <Button variant="primary" onClick={() => act(async () => { await patch(`/api/memories/${m.id}`, { content }); setEditing(false); })}>Save</Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-sm leading-relaxed text-ink">{m.content}</p>
      )}
      {conflicts.length > 0 && (
        <div className="mt-2 rounded-lg border border-amber/35 bg-amber/5 p-2 text-xs text-amber">
          <TriangleAlert className="mr-1 inline size-3.5" aria-hidden />
          May contradict: {conflicts.map((c) => `“${c.content}”`).join(", ")}
        </div>
      )}
      {m.last_used_at && <p className="mt-1.5 text-[11px] text-ink-4">Last used in a prompt {timeAgo(m.last_used_at)}</p>}
      <ErrorNote error={error} />
      <div className="mt-3 flex flex-wrap gap-1.5">
        {m.status === "proposed" && (
          <>
            <Button variant="primary" icon={Check} className="h-7 text-xs" onClick={() => act(() => post(`/api/memories/${m.id}/approve`, { supersede: false }))}>
              Approve
            </Button>
            {conflicts.length > 0 && (
              <Button icon={Check} className="h-7 text-xs" onClick={() => act(() => post(`/api/memories/${m.id}/approve`, { supersede: true }))}>
                Approve & replace old
              </Button>
            )}
          </>
        )}
        <Button variant="ghost" icon={Pencil} className="h-7 text-xs" onClick={() => setEditing(true)}>Edit</Button>
        <Button variant="ghost" icon={EyeOff} className="h-7 text-xs" onClick={() => act(() => patch(`/api/memories/${m.id}`, { share_with_model: !m.share_with_model }))}>
          {m.share_with_model ? "Make private" : "Share with model"}
        </Button>
        {m.status !== "archived" && (
          <Button variant="ghost" icon={Archive} className="h-7 text-xs" onClick={() => act(() => post(`/api/memories/${m.id}/archive`))}>
            {m.status === "proposed" ? "Reject" : "Archive"}
          </Button>
        )}
        <Button variant="ghost" icon={Trash2} className="h-7 text-xs text-danger" onClick={() => act(() => del(`/api/memories/${m.id}`))}>
          Delete
        </Button>
      </div>
    </article>
  );
}

function EmbeddingPanel() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["memories", "embeddings"],
    queryFn: () => get<{ active: string; stale: number; counts: Record<string, number> }>("/api/memories/embeddings/status"),
  });
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const semantic = data.active !== "hashing-v1";
  return (
    <Panel title="Retrieval engine" icon={Brain}>
      <p className="text-xs text-ink-3">
        Embedder: <span className="font-mono text-ice">{data.active}</span>{" "}
        <Chip tone={semantic ? "success" : "amber"}>{semantic ? "semantic" : "lexical"}</Chip>
      </p>
      {!semantic && (
        <p className="mt-2 text-[11px] text-ink-4">
          Local word-hashing finds memories that share words with your question. Set JARVIS_EMBEDDINGS_PROVIDER=openai_compatible on the server for meaning-based search.
        </p>
      )}
      {data.stale > 0 && (
        <Button className="mt-3 w-full" loading={busy} onClick={async () => {
          setBusy(true);
          try {
            await post("/api/memories/embeddings/reembed");
            await qc.invalidateQueries({ queryKey: ["memories"] });
          } finally {
            setBusy(false);
          }
        }}>
          Re-embed {data.stale} memor{data.stale === 1 ? "y" : "ies"}
        </Button>
      )}
    </Panel>
  );
}

export default function MemoryCentre() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "proposed" | "active" | "archived">("");
  const [content, setContent] = useState("");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("preference");
  const [shared, setShared] = useState(true);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["memories", q, status],
    queryFn: () => get<(MemoryItem & { score?: number })[]>(`/api/memories?q=${encodeURIComponent(q)}${status ? `&status=${status}` : ""}`),
  });
  const { data: all = [] } = useQuery({ queryKey: ["memories", "all"], queryFn: () => get<MemoryItem[]>("/api/memories") });
  const proposed = all.filter((m) => m.status === "proposed").length;
  const counts = KINDS.map((k) => [k, all.filter((m) => m.kind === k && m.status === "active").length] as const);

  async function create() {
    setError(null);
    try {
      await post("/api/memories", { content, kind, share_with_model: shared });
      setContent("");
      await qc.invalidateQueries({ queryKey: ["memories"] });
    } catch (e) {
      setError(e);
    }
  }

  return (
    <>
      <PageHeader
        title="Memory Centre"
        description="Everything JARVIS remembers about you — inspect, edit, approve, make private or delete. Proposed memories are never used until you approve them."
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Panel
          title="Memories"
          icon={Brain}
          actions={proposed > 0 ? <Chip tone="cyan">{proposed} awaiting review</Chip> : undefined}
        >
          <div className="mb-4 flex flex-wrap gap-2">
            <div className="relative min-w-48 flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-4" aria-hidden />
              <input className="field pl-9" placeholder="Search memories…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search memories" />
            </div>
            <select className="field w-auto" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status filter">
              <option value="">All statuses</option>
              <option value="proposed">Proposed</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          </div>
          {isLoading ? (
            <LoadingRows rows={4} />
          ) : !data?.length ? (
            <EmptyState icon={Brain} title={q ? "No matching memories" : "No memories yet"}>
              Tell JARVIS “remember that…” in a conversation, or add one here.
            </EmptyState>
          ) : (
            <div className="grid gap-3 xl:grid-cols-2">
              {data.map((m) => (
                <MemoryCard key={m.id} m={m} all={all} />
              ))}
            </div>
          )}
        </Panel>
        <div className="flex flex-col gap-4">
          <Panel title="Add memory" icon={Plus}>
            <div className="space-y-3">
              <div>
                <FieldLabel htmlFor="mem-content">Content</FieldLabel>
                <textarea id="mem-content" className="field min-h-20 py-2" value={content} onChange={(e) => setContent(e.target.value)} placeholder="e.g. I prefer metric units" />
              </div>
              <div>
                <FieldLabel htmlFor="mem-kind">Kind</FieldLabel>
                <select id="mem-kind" className="field" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                  {KINDS.map((k) => <option key={k}>{k}</option>)}
                </select>
              </div>
              <Toggle checked={shared} onChange={setShared} label="Share with the AI model" description="Off = stored, searchable here, never sent to a model." />
              <ErrorNote error={error} />
              <Button variant="primary" icon={Plus} disabled={!content.trim()} onClick={create} className="w-full">Save memory</Button>
            </div>
          </Panel>
          <Panel title="Composition" icon={Brain}>
            <div className="space-y-2">
              {counts.map(([k, n]) => (
                <div key={k} className="flex items-center gap-3 text-xs">
                  <span className="w-20 capitalize text-ink-2">{k}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
                    <div className="h-full rounded-full bg-violet" style={{ width: `${Math.min(100, (n / Math.max(1, all.length)) * 100)}%` }} />
                  </div>
                  <span className="w-6 text-right font-mono text-ink-3">{n}</span>
                </div>
              ))}
            </div>
          </Panel>
          <EmbeddingPanel />
          <Panel title="Delete everything" icon={Trash2}>
            <p className="mb-2 text-xs text-ink-3">Permanently deletes all memories. Type <span className="font-mono text-danger">DELETE ALL</span> to confirm.</p>
            <input className="field mb-2" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-label="Confirmation phrase" />
            <Button
              variant="danger"
              icon={Trash2}
              disabled={confirm !== "DELETE ALL"}
              className="w-full"
              onClick={async () => {
                await del(`/api/memories?confirm=${encodeURIComponent(confirm)}`);
                setConfirm("");
                await qc.invalidateQueries({ queryKey: ["memories"] });
              }}
            >
              Delete all memories
            </Button>
          </Panel>
        </div>
      </div>
    </>
  );
}
