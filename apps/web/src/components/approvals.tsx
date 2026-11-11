"use client";

import { Check, Clock, Monitor, ShieldAlert, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { Approval } from "@jarvis/protocol";
import { post } from "@/lib/api";
import { usePendingApprovals, useJarvis } from "@/lib/store";
import { Button, Chip, ErrorNote, JsonBlock, riskTone } from "./ui";

function useCountdown(iso: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function ApprovalCard({ approval, compact = false }: { approval: Approval; compact?: boolean }) {
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const kind = useJarvis((s) => s.auth.session?.client_kind);
  const remaining = useCountdown(approval.expires_at);
  const blocked = approval.requires_client_kind !== null && approval.requires_client_kind !== kind;

  async function decide(approve: boolean) {
    setBusy(approve ? "approve" : "deny");
    setError(null);
    try {
      const updated = await post<Approval>(`/api/approvals/${approval.id}/decision`, { approve });
      useJarvis.getState().applyEvent({
        type: "approval.resolved",
        seq: 0,
        ts: new Date().toISOString(),
        run_id: updated.run_id,
        conversation_id: null,
        data: { approval: updated },
      });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="rounded-xl border border-amber/40 bg-gradient-to-b from-amber/[0.07] to-transparent p-3.5"
      data-testid="approval-card"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-ink">{approval.tool_title}</span>
            <Chip tone={riskTone(approval.risk)}>{approval.risk.replace("_", " ")}</Chip>
            <span className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] text-ink-3">
              <Clock className="size-3" aria-hidden /> {remaining}
            </span>
          </div>
          <p className="mt-1 text-xs text-ink-2">{approval.reason}</p>
        </div>
      </div>
      {!compact && <div className="mt-2.5"><JsonBlock value={approval.arguments} max={600} /></div>}
      {blocked && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber">
          <Monitor className="size-3.5" aria-hidden /> Approve this from your paired {approval.requires_client_kind} app. You can deny it here.
        </p>
      )}
      <ErrorNote error={error} />
      <div className="mt-3 flex gap-2">
        <Button variant="primary" icon={Check} loading={busy === "approve"} disabled={blocked || busy !== null} onClick={() => decide(true)} className="flex-1">
          Approve
        </Button>
        <Button variant="danger" icon={X} loading={busy === "deny"} disabled={busy !== null} onClick={() => decide(false)} className="flex-1">
          Deny
        </Button>
      </div>
    </div>
  );
}

/** Floating stack of pending approvals, visible from every workspace. */
export function ApprovalDock() {
  const pathname = usePathname();
  const all = usePendingApprovals();
  const conversationId = useJarvis((s) => s.conversationId);
  const runs = useJarvis((s) => s.runs);
  // Mission Control and Security list approvals themselves; the Command Centre shows
  // approvals of the open conversation inline. Only surface the rest here.
  const hideAll = /^\/(mission|security)/.test(pathname);
  const pending = hideAll
    ? []
    : all.filter((a) => !(pathname.startsWith("/command") && a.run_id && runs[a.run_id]?.conversation_id === conversationId));
  return (
    <div className="pointer-events-none fixed right-3 bottom-20 z-40 flex w-[min(380px,calc(100vw-24px))] flex-col gap-2 md:bottom-4">
      <AnimatePresence>
        {pending.slice(0, 2).map((a) => (
          <motion.div
            key={a.id}
            layout
            initial={{ opacity: 0, x: 40, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.97 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-auto rounded-xl bg-midnight/95 shadow-[0_20px_60px_-20px_rgb(255_181_71/0.35)] backdrop-blur-xl"
          >
            <ApprovalCard approval={a} />
          </motion.div>
        ))}
      </AnimatePresence>
      {pending.length > 2 && (
        <div className="pointer-events-auto text-right text-xs text-amber">+{pending.length - 2} more in Security Centre</div>
      )}
    </div>
  );
}
