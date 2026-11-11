"use client";

import { useQuery } from "@tanstack/react-query";
import { CircleStop, History, Loader2, MessageSquarePlus, Send, ThumbsDown, ThumbsUp, Wrench } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ChatMessage, RunStep } from "@jarvis/protocol";
import { get, post } from "@/lib/api";
import { openConversation, parseDirectCommand, runDirectCommand, sendChat } from "@/lib/chat";
import { duration } from "@/lib/format";
import { useJarvis } from "@/lib/store";
import { ApprovalCard } from "@/components/approvals";
import { Button, Chip, EmptyState, StatusDot, clsx, statusTone } from "@/components/ui";
import { VoiceButton } from "./VoiceDock";

function RichText({ text }: { text: string }) {
  // Minimal, safe formatting: paragraphs, `code`, **bold** — rendered as React nodes, never HTML.
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("`") && p.endsWith("`") ? (
          <code key={i} className="rounded bg-void/70 px-1 py-0.5 font-mono text-[12px] text-ice">{p.slice(1, -1)}</code>
        ) : p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-semibold text-ink">{p.slice(2, -2)}</strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function ToolActivity({ steps }: { steps: RunStep[] }) {
  const tools = steps.filter((s) => s.kind === "tool_call");
  if (!tools.length) return null;
  return (
    <div className="my-2 flex flex-col gap-1.5">
      {tools.map((s) => (
        <motion.div
          key={s.id}
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          className="flex items-center gap-2 rounded-lg border border-line bg-void/40 px-2.5 py-1.5 text-xs"
        >
          {s.status === "running" ? <Loader2 className="size-3.5 animate-spin text-cyan" aria-hidden /> : <Wrench className="size-3.5 text-ink-3" aria-hidden />}
          <span className="font-mono text-ice">{s.name}</span>
          <span className="truncate text-ink-3">{s.status === "running" ? "running…" : s.summary}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {s.duration_ms != null && <span className="font-mono text-[10px] text-ink-4">{duration(s.duration_ms)}</span>}
            <Chip tone={statusTone(s.status)}>{s.status}</Chip>
          </span>
        </motion.div>
      ))}
    </div>
  );
}

function MessageBubble({ m, steps }: { m: ChatMessage; steps: RunStep[] }) {
  const [rated, setRated] = useState<number | null>(null);
  const user = m.role === "user";
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={clsx("group flex", user ? "justify-end" : "justify-start")}
    >
      <div className={clsx("max-w-[88%]", user ? "items-end" : "items-start")}>
        {!user && <ToolActivity steps={steps} />}
        <div
          className={clsx(
            "rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap",
            user
              ? "rounded-br-md border border-cyan/25 bg-gradient-to-br from-cyan/15 to-cyan/5 text-ink"
              : "rounded-bl-md border border-line bg-surface/60 text-ink-2",
          )}
        >
          <RichText text={m.content} />
        </div>
        {!user && m.run_id && (
          <div className="mt-1 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            {[1, -1].map((r) => (
              <button
                key={r}
                type="button"
                aria-label={r > 0 ? "Helpful" : "Not helpful"}
                aria-pressed={rated === r}
                onClick={async () => {
                  setRated(r);
                  await post("/api/feedback", { run_id: m.run_id, message_id: m.id, rating: r }).catch(() => undefined);
                }}
                className={clsx("rounded p-1 text-ink-4 hover:text-ink", rated === r && "text-cyan")}
              >
                {r > 0 ? <ThumbsUp className="size-3" aria-hidden /> : <ThumbsDown className="size-3" aria-hidden />}
              </button>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

export function ConversationConsole({ onVoiceRun }: { onVoiceRun?: (runId: string) => void }) {
  const conversationId = useJarvis((s) => s.conversationId);
  const messages = useJarvis((s) => s.messages);
  const streams = useJarvis((s) => s.streams);
  const stepsByRun = useJarvis((s) => s.steps);
  const runs = useJarvis((s) => s.runs);
  const approvals = useJarvis((s) => s.approvals);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [interim, setInterim] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const { data: conversations } = useQuery({
    queryKey: ["conversations"],
    queryFn: () => get<{ id: string; title: string; updated_at: string }[]>("/api/conversations"),
  });

  // Restore the most recent conversation on first load.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || conversationId || !conversations?.length) return;
    restored.current = true;
    void openConversation(conversations[0]!.id);
  }, [conversations, conversationId]);

  useEffect(() => {
    const onInterim = (e: Event) => setInterim((e as CustomEvent<string>).detail);
    window.addEventListener("jarvis:interim-transcript", onInterim);
    return () => window.removeEventListener("jarvis:interim-transcript", onInterim);
  }, []);

  const liveStreams = useMemo(
    () => Object.values(streams).filter((s) => s.conversationId === conversationId),
    [streams, conversationId],
  );
  const activeRun = useMemo(
    () =>
      Object.values(runs).find(
        (r) => r.conversation_id === conversationId && ["queued", "running", "waiting_approval"].includes(r.status),
      ),
    [runs, conversationId],
  );
  const inlineApprovals = Object.values(approvals).filter((a) => a.status === "pending" && a.run_id && runs[a.run_id]?.conversation_id === conversationId);

  const streamSignature = liveStreams.map((s) => s.text.length).join();
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, streamSignature, inlineApprovals.length]);

  async function submit(value = text, viaVoice = false) {
    const v = value.trim();
    if (!v || sending) return;
    setSending(true);
    try {
      const direct = v.startsWith("/") ? parseDirectCommand(v) : null;
      if (direct) {
        await runDirectCommand(direct);
        useJarvis.getState().pushToast({ level: "info", title: `Running ${direct.tool}`, body: "See Mission Control for the result.", link: "/mission/" });
      } else {
        const run = await sendChat(v);
        if (viaVoice) onVoiceRun?.(run.id);
      }
      setText("");
    } catch (e) {
      useJarvis.getState().pushToast({ level: "error", title: "Could not send", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <History className="size-3.5 text-ink-3" aria-hidden />
        <label htmlFor="conv" className="sr-only">Conversation</label>
        <select
          id="conv"
          value={conversationId ?? ""}
          onChange={(e) => void openConversation(e.target.value || null)}
          className="min-w-0 flex-1 truncate bg-transparent text-xs text-ink-2 outline-none"
        >
          <option value="" className="bg-midnight">New conversation</option>
          {conversations?.map((c) => (
            <option key={c.id} value={c.id} className="bg-midnight">{c.title}</option>
          ))}
        </select>
        <Button variant="ghost" icon={MessageSquarePlus} className="h-7 px-2 text-xs" onClick={() => void openConversation(null)}>
          New
        </Button>
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4" aria-live="polite" data-testid="chat-log">
        {messages.length === 0 && liveStreams.length === 0 && (
          <EmptyState title="How can I help?">
            Ask anything, or try <span className="font-mono text-ice">/time</span>, <span className="font-mono text-ice">/note Title | body</span>{" "}
            or <span className="font-mono text-ice">/remind 10m stand up</span> for direct commands.
          </EmptyState>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} steps={m.role === "assistant" && m.run_id ? stepsByRun[m.run_id] ?? [] : []} />
        ))}
        <AnimatePresence>
          {liveStreams.map((s) => (
            <motion.div key={s.runId} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex justify-start">
              <div className="max-w-[88%]">
                <ToolActivity steps={stepsByRun[s.runId] ?? []} />
                <div className="rounded-2xl rounded-bl-md border border-cyan/20 bg-surface/60 px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
                  <RichText text={s.text} />
                  <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-blink bg-cyan align-middle" aria-hidden />
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
        {activeRun && liveStreams.length === 0 && (
          <div className="flex items-center gap-2 px-1 text-xs text-ink-3">
            <StatusDot tone="violet" pulse /> {activeRun.status === "waiting_approval" ? "Waiting for your approval…" : "Thinking…"}
          </div>
        )}
        {inlineApprovals.map((a) => (
          <ApprovalCard key={a.id} approval={a} />
        ))}
      </div>

      <div className="border-t border-line p-3">
        {interim && <p className="mb-2 truncate text-xs text-ink-3 italic">“{interim}”</p>}
        <div className="flex items-end gap-2">
          <VoiceButton
            onTranscript={(t) => {
              setInterim("");
              if (t) void submit(t, true);
            }}
          />
          <label htmlFor="chat-input" className="sr-only">Message JARVIS</label>
          <textarea
            id="chat-input"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder="Message JARVIS…"
            className="field max-h-40 min-h-[2.6rem] flex-1 resize-none py-2.5 leading-snug"
          />
          {activeRun ? (
            <Button variant="danger" icon={CircleStop} aria-label="Cancel run" className="h-[2.6rem] px-3" onClick={() => post(`/api/runs/${activeRun.id}/cancel`)} />
          ) : (
            <Button variant="primary" icon={Send} aria-label="Send" className="h-[2.6rem] px-3" loading={sending} disabled={!text.trim()} onClick={() => void submit()} />
          )}
        </div>
      </div>
    </div>
  );
}
