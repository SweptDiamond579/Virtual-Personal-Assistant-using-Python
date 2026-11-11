"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, CalendarDays, Mail, NotebookPen, Plus, Send, Sun, Trash2 } from "lucide-react";
import { useState } from "react";
import type { JobSummary } from "@jarvis/protocol";
import { Button, Chip, EmptyState, ErrorNote, LoadingRows, PageHeader, Panel, statusTone } from "@/components/ui";
import { del, get, post } from "@/lib/api";
import { runDirectCommand } from "@/lib/chat";
import { dateTime, timeAgo } from "@/lib/format";
import { useJarvis } from "@/lib/store";

interface Note { id: string; title: string; body: string; tags: string[]; created_by: string; updated_at: string }
interface Draft { id: string; to: string; subject: string; body: string; status: string; error: string | null; created_at: string }

function Notes() {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery({ queryKey: ["notes", q], queryFn: () => get<Note[]>(`/api/notes?q=${encodeURIComponent(q)}`) });
  return (
    <Panel title="Notes" icon={NotebookPen}>
      <form
        className="mb-4 space-y-2"
        onSubmit={async (e) => {
          e.preventDefault();
          await post("/api/notes", { title, body });
          setTitle("");
          setBody("");
          await qc.invalidateQueries({ queryKey: ["notes"] });
        }}
      >
        <input className="field" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Note title" required />
        <textarea className="field min-h-16 py-2" placeholder="Body" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Note body" />
        <Button type="submit" icon={Plus} variant="primary" disabled={!title.trim()}>Add note</Button>
      </form>
      <input className="field mb-3" placeholder="Search notes…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search notes" />
      {isLoading ? <LoadingRows /> : !data?.length ? (
        <EmptyState icon={NotebookPen} title="No notes">Ask JARVIS “note: groceries | milk, eggs”.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {data.map((n) => (
            <li key={n.id} className="group rounded-lg border border-line bg-surface/40 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink">{n.title}</span>
                {n.created_by === "jarvis" && <Chip tone="cyan">by JARVIS</Chip>}
                <span className="ml-auto font-mono text-[10px] text-ink-4">{timeAgo(n.updated_at)}</span>
                <button type="button" aria-label={`Delete ${n.title}`} className="text-ink-4 opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100" onClick={async () => { await del(`/api/notes/${n.id}`); await qc.invalidateQueries({ queryKey: ["notes"] }); }}>
                  <Trash2 className="size-3.5" aria-hidden />
                </button>
              </div>
              {n.body && <p className="mt-1 line-clamp-4 text-xs whitespace-pre-line text-ink-3">{n.body}</p>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Reminders() {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [error, setError] = useState<unknown>(null);
  const { data } = useQuery({ queryKey: ["jobs"], queryFn: () => get<JobSummary[]>("/api/jobs") });
  const reminders = (data ?? []).filter((j) => j.kind === "reminder");
  return (
    <Panel title="Reminders" icon={AlarmClock}>
      <form
        className="mb-4 flex flex-wrap gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await runDirectCommand({ tool: "reminder_create", args: { text, in_minutes: minutes }, label: "" });
            setText("");
            setTimeout(() => void qc.invalidateQueries({ queryKey: ["jobs"] }), 500);
          } catch (err) {
            setError(err);
          }
        }}
      >
        <input className="field min-w-40 flex-1" placeholder="Remind me to…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Reminder text" required />
        <label className="flex items-center gap-1.5 text-xs text-ink-3">
          in
          <input type="number" min={1} max={10080} className="field w-20" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} aria-label="Minutes from now" />
          min
        </label>
        <Button type="submit" icon={Plus} variant="primary">Set</Button>
      </form>
      <ErrorNote error={error} />
      {reminders.length === 0 ? (
        <EmptyState icon={AlarmClock} title="No reminders" />
      ) : (
        <ul className="space-y-1.5">
          {reminders.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-xs">
              <Chip tone={r.enabled ? "cyan" : statusTone(r.last_status ?? "")}>{r.enabled ? "scheduled" : r.last_status ?? "done"}</Chip>
              <span className="min-w-0 flex-1 truncate text-ink-2">{r.name.replace(/^Reminder: /, "")}</span>
              <span className="font-mono text-[10px] text-ink-4">{r.enabled ? dateTime(r.next_run_at) : timeAgo(r.last_run_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Drafts() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["drafts"], queryFn: () => get<Draft[]>("/api/drafts") });
  const smtp = useJarvis((s) => s.system?.services.find((x) => x.name === "email"));
  return (
    <Panel title="Email drafts" icon={Mail} actions={smtp && <Chip tone={statusTone(smtp.status)}>{smtp.status === "ok" ? "SMTP ready" : "SMTP not configured"}</Chip>}>
      {isLoading ? <LoadingRows /> : !data?.length ? (
        <EmptyState icon={Mail} title="No drafts">Ask JARVIS to “draft an email to…”. Sending always requires your approval.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {data.map((d) => (
            <li key={d.id} className="rounded-lg border border-line bg-surface/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm text-ink">{d.subject}</span>
                <Chip tone={statusTone(d.status)}>{d.status}</Chip>
                <span className="ml-auto text-xs text-ink-3">to {d.to}</span>
              </div>
              <p className="mt-1 line-clamp-3 text-xs whitespace-pre-line text-ink-3">{d.body}</p>
              {d.error && <p className="mt-1 text-xs text-danger">{d.error}</p>}
              <div className="mt-2 flex gap-2">
                {d.status !== "sent" && (
                  <Button className="h-7 text-xs" icon={Send} disabled={smtp?.status !== "ok"} onClick={() => runDirectCommand({ tool: "email_send", args: { draft_id: d.id }, label: "" })}>
                    Send (needs approval)
                  </Button>
                )}
                <Button variant="ghost" className="h-7 text-xs" icon={Trash2} onClick={async () => { await del(`/api/drafts/${d.id}`); await qc.invalidateQueries({ queryKey: ["drafts"] }); }}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function PersonalAssistant() {
  const [briefing, setBriefing] = useState<"idle" | "running" | "started">("idle");
  return (
    <>
      <PageHeader
        title="Personal Assistant"
        description="Notes, reminders, briefings and email — handled by JARVIS, approved by you."
        actions={
          <Button
            variant="primary"
            icon={Sun}
            loading={briefing === "running"}
            onClick={async () => {
              setBriefing("running");
              await post("/api/workflow-templates/daily_briefing/instantiate", { params: {}, run_now: true });
              setBriefing("started");
            }}
          >
            {briefing === "started" ? "Briefing started — saved to Notes" : "Run daily briefing"}
          </Button>
        }
      />
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
        <Notes />
        <div className="flex flex-col gap-4">
          <Reminders />
          <Panel title="Calendar" icon={CalendarDays}>
            <EmptyState icon={CalendarDays} title="Calendar connector not yet implemented">
              Google and Microsoft calendar access requires OAuth client credentials and is on the roadmap. Reminders above are fully functional.
            </EmptyState>
          </Panel>
        </div>
        <Drafts />
      </div>
    </>
  );
}
