"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookMarked, Globe, Link as LinkIcon, Network, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { MemoryItem } from "@jarvis/protocol";
import { Button, Chip, EmptyState, LoadingRows, PageHeader, Panel } from "@/components/ui";
import { del, get } from "@/lib/api";
import { sendChat } from "@/lib/chat";
import { dateTime } from "@/lib/format";
import { useSettings } from "@/lib/hooks";

interface Finding { id: string; title: string; summary: string; sources: { title: string; url: string | null }[]; run_id: string | null; created_at: string }

const KIND_COLOR: Record<string, string> = { preference: "#2ee6ff", fact: "#8b7bff", project: "#3dffa8", note: "#c4f1ff" };

/** Radial knowledge map: memories clustered by kind around the core. Pure SVG, no layout engine. */
function KnowledgeMap({ memories }: { memories: MemoryItem[] }) {
  const nodes = useMemo(() => {
    const kinds = Object.keys(KIND_COLOR);
    return memories.slice(0, 60).map((m, i) => {
      const k = Math.max(0, kinds.indexOf(m.kind));
      const sector = (k / kinds.length) * Math.PI * 2;
      const within = memories.filter((x) => x.kind === m.kind).indexOf(m);
      const angle = sector + ((within % 9) - 4) * 0.13 + 0.4;
      const r = 70 + (within % 3) * 34 + (i % 2) * 8;
      return { m, x: 200 + Math.cos(angle) * r, y: 170 + Math.sin(angle) * r * 0.82, color: KIND_COLOR[m.kind] ?? "#6b8199" };
    });
  }, [memories]);
  if (!memories.length) return <EmptyState icon={Network} title="No knowledge yet">Approved memories appear here, clustered by type.</EmptyState>;
  return (
    <svg viewBox="0 0 400 340" className="h-auto w-full" role="img" aria-label={`Knowledge map of ${memories.length} memories`}>
      <defs>
        <radialGradient id="km-core"><stop offset="0" stopColor="#2ee6ff" stopOpacity="0.9" /><stop offset="1" stopColor="#2ee6ff" stopOpacity="0" /></radialGradient>
      </defs>
      {[60, 100, 140].map((r) => <ellipse key={r} cx="200" cy="170" rx={r} ry={r * 0.82} fill="none" stroke="rgb(120 200 255 / 0.12)" strokeDasharray="2 5" />)}
      {nodes.map((n) => <line key={`l${n.m.id}`} x1="200" y1="170" x2={n.x} y2={n.y} stroke={n.color} strokeOpacity="0.14" />)}
      <circle cx="200" cy="170" r="26" fill="url(#km-core)" />
      <circle cx="200" cy="170" r="6" fill="#e6f4ff" />
      {nodes.map((n) => (
        <g key={n.m.id}>
          <title>{`${n.m.kind}: ${n.m.content}`}</title>
          <circle cx={n.x} cy={n.y} r={3 + n.m.confidence * 3} fill={n.color} fillOpacity={n.m.status === "active" ? 0.9 : 0.35} />
          <circle cx={n.x} cy={n.y} r={9} fill="none" stroke={n.color} strokeOpacity="0.25" />
        </g>
      ))}
      {Object.entries(KIND_COLOR).map(([k, c], i) => (
        <g key={k} transform={`translate(${12 + i * 96} 326)`}>
          <circle r="3.5" cx="4" cy="-3" fill={c} />
          <text x="12" y="0" fill="#a8bfd6" fontSize="10" fontFamily="var(--font-mono)">{k}</text>
        </g>
      ))}
    </svg>
  );
}

export default function Intelligence() {
  const qc = useQueryClient();
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const { data: findings, isLoading } = useQuery({ queryKey: ["findings"], queryFn: () => get<Finding[]>("/api/findings") });
  const { data: memories = [] } = useQuery({ queryKey: ["memories", "active"], queryFn: () => get<MemoryItem[]>("/api/memories?status=active") });
  const { data: settings } = useSettings();

  async function research() {
    if (!topic.trim()) return;
    await sendChat(
      `Research this topic using your web tools: "${topic.trim()}". Cite the sources you actually read, then save the key result with findings_save including those sources.`,
    );
    setTopic("");
    router.push("/command/");
  }

  return (
    <>
      <PageHeader title="Intelligence" description="Research with cited evidence, saved findings and a map of what JARVIS knows." />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex flex-col gap-4">
          <Panel title="Research" icon={Search}>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void research(); }}>
              <input className="field" placeholder="What should JARVIS investigate?" value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Research topic" />
              <Button type="submit" variant="primary" icon={Search} disabled={!topic.trim()}>Investigate</Button>
            </form>
            <p className="mt-2 text-[11px] text-ink-4">
              Web content is treated as untrusted data: after JARVIS reads a page, any side-effecting action in that task requires your approval.
            </p>
          </Panel>
          <Panel title="Saved findings" icon={BookMarked}>
            {isLoading ? <LoadingRows /> : !findings?.length ? (
              <EmptyState icon={BookMarked} title="No findings saved yet">Research results that JARVIS saves with findings_save appear here with their sources.</EmptyState>
            ) : (
              <ul className="space-y-3">
                {findings.map((f) => (
                  <li key={f.id} className="group rounded-xl border border-line bg-surface/40 p-4">
                    <div className="flex items-start gap-2">
                      <h3 className="font-display text-[15px] text-ink">{f.title}</h3>
                      <span className="ml-auto font-mono text-[10px] text-ink-4">{dateTime(f.created_at)}</span>
                      <button type="button" aria-label={`Delete ${f.title}`} className="text-ink-4 opacity-0 group-hover:opacity-100 hover:text-danger focus:opacity-100" onClick={async () => { await del(`/api/findings/${f.id}`); await qc.invalidateQueries({ queryKey: ["findings"] }); }}>
                        <Trash2 className="size-3.5" aria-hidden />
                      </button>
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed whitespace-pre-line text-ink-2">{f.summary}</p>
                    {f.sources.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {f.sources.map((s, i) => s.url ? (
                          <a key={i} href={s.url} target="_blank" rel="noreferrer noopener" className="chip hover:border-cyan/50 hover:text-cyan"><LinkIcon className="size-3" aria-hidden />{s.title}</a>
                        ) : <Chip key={i}>{s.title}</Chip>)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
        <div className="flex flex-col gap-4">
          <Panel title="Knowledge map" icon={Network}><KnowledgeMap memories={memories} /></Panel>
          <Panel title="Web allow-list" icon={Globe}>
            <p className="mb-2 text-xs text-ink-3">Pages on these domains can be read without approval. Everything else asks first.</p>
            <div className="flex flex-wrap gap-1.5">
              {settings?.values.web_allowlist.map((d) => <Chip key={d} tone="cyan">{d}</Chip>)}
            </div>
            <p className="mt-2 text-[11px] text-ink-4">Edit in Settings → Privacy &amp; web.</p>
          </Panel>
        </div>
      </div>
    </>
  );
}
