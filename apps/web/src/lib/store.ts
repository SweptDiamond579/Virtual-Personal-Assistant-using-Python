"use client";

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type {
  Approval,
  ChatMessage,
  ClientKind,
  NotificationItem,
  RunStep,
  RunSummary,
  ServerEvent,
  SystemStatus,
} from "@jarvis/protocol";
import { ACTIVE_RUN_STATUSES } from "./core-machine";

export interface SessionUser {
  id: string;
  username: string;
  display_name: string;
}

export interface SessionInfo {
  id: string;
  client_kind: ClientKind;
  csrf_token: string;
  device_id: string | null;
}

export type AuthStatus = "loading" | "setup" | "anonymous" | "authenticated" | "error";

export interface Toast {
  id: string;
  level: "info" | "success" | "warning" | "error" | "approval";
  title: string;
  body?: string;
  link?: string | null;
}

interface StreamBuffer {
  runId: string;
  conversationId: string | null;
  text: string;
}

export interface JarvisState {
  auth: { status: AuthStatus; user: SessionUser | null; session: SessionInfo | null };
  connection: "connecting" | "open" | "closed";
  system: SystemStatus | null;
  runs: Record<string, RunSummary>;
  steps: Record<string, RunStep[]>;
  runningTools: Record<string, RunStep>;
  approvals: Record<string, Approval>;
  notifications: NotificationItem[];
  conversationId: string | null;
  messages: ChatMessage[];
  streams: Record<string, StreamBuffer>;
  lastOutcome: { status: RunSummary["status"]; at: number } | null;
  micActive: boolean;
  speaking: boolean;
  toasts: Toast[];
  memoryUsed: string[];

  setAuth: (a: Partial<JarvisState["auth"]>) => void;
  setConnection: (c: JarvisState["connection"]) => void;
  setSystem: (s: SystemStatus) => void;
  setConversation: (id: string | null, messages: ChatMessage[]) => void;
  setApprovals: (list: Approval[]) => void;
  setNotifications: (list: NotificationItem[]) => void;
  markAllRead: () => void;
  setRuns: (list: RunSummary[]) => void;
  setSteps: (runId: string, steps: RunStep[]) => void;
  setMicActive: (v: boolean) => void;
  setSpeaking: (v: boolean) => void;
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;
  applyEvent: (e: ServerEvent) => void;
}

let toastSeq = 0;

export const useJarvis = create<JarvisState>((set, get) => ({
  auth: { status: "loading", user: null, session: null },
  connection: "closed",
  system: null,
  runs: {},
  steps: {},
  runningTools: {},
  approvals: {},
  notifications: [],
  conversationId: null,
  messages: [],
  streams: {},
  lastOutcome: null,
  micActive: false,
  speaking: false,
  toasts: [],
  memoryUsed: [],

  setAuth: (a) => set((s) => ({ auth: { ...s.auth, ...a } })),
  setConnection: (connection) => set({ connection }),
  setSystem: (system) => set({ system }),
  setConversation: (conversationId, messages) => set({ conversationId, messages }),
  setApprovals: (list) => set({ approvals: Object.fromEntries(list.map((a) => [a.id, a])) }),
  setNotifications: (notifications) => set({ notifications }),
  markAllRead: () =>
    set((s) => ({
      notifications: s.notifications.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() })),
    })),
  // Realtime events are authoritative: a REST snapshot never overwrites a run we already track.
  setRuns: (list) =>
    set((s) => ({ runs: { ...Object.fromEntries(list.map((r) => [r.id, r])), ...s.runs } })),
  setSteps: (runId, steps) => set((s) => ({ steps: { ...s.steps, [runId]: steps } })),
  setMicActive: (micActive) => set({ micActive }),
  setSpeaking: (speaking) => set({ speaking }),
  pushToast: (t) => {
    const id = `t${++toastSeq}`;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    setTimeout(() => get().dismissToast(id), t.level === "approval" ? 12000 : 6000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  applyEvent: (e) => {
    switch (e.type) {
      case "run.started":
      case "run.updated": {
        const run = e.data.run;
        set((s) => {
          const prev = s.runs[run.id];
          const finished = !ACTIVE_RUN_STATUSES.has(run.status) && (!prev || ACTIVE_RUN_STATUSES.has(prev.status));
          return {
            runs: { ...s.runs, [run.id]: run },
            lastOutcome: finished ? { status: run.status, at: Date.now() } : s.lastOutcome,
            runningTools: finished
              ? Object.fromEntries(Object.entries(s.runningTools).filter(([, st]) => st.run_id !== run.id))
              : s.runningTools,
          };
        });
        return;
      }
      case "message.created": {
        const m = e.data.message;
        set((s) =>
          s.conversationId === m.conversation_id && !s.messages.some((x) => x.id === m.id)
            ? { messages: [...s.messages, m] }
            : {},
        );
        return;
      }
      case "assistant.delta": {
        const runId = e.run_id ?? e.data.message_id;
        set((s) => {
          const cur = s.streams[runId] ?? { runId, conversationId: e.conversation_id, text: "" };
          return { streams: { ...s.streams, [runId]: { ...cur, text: cur.text + e.data.text } } };
        });
        return;
      }
      case "assistant.completed": {
        const m = e.data.message;
        set((s) => {
          const streams = { ...s.streams };
          if (m.run_id) delete streams[m.run_id];
          const messages =
            s.conversationId === m.conversation_id && !s.messages.some((x) => x.id === m.id)
              ? [...s.messages, m]
              : s.messages;
          return { streams, messages };
        });
        return;
      }
      case "tool.started": {
        const st = e.data.step;
        set((s) => ({
          runningTools: { ...s.runningTools, [st.id]: st },
          steps: { ...s.steps, [st.run_id]: [...(s.steps[st.run_id] ?? []).filter((x) => x.id !== st.id), st] },
        }));
        return;
      }
      case "tool.finished": {
        const st = e.data.step;
        set((s) => {
          const runningTools = { ...s.runningTools };
          delete runningTools[st.id];
          const list = s.steps[st.run_id] ?? [];
          const has = list.some((x) => x.id === st.id);
          return {
            runningTools,
            steps: { ...s.steps, [st.run_id]: has ? list.map((x) => (x.id === st.id ? st : x)) : [...list, st] },
          };
        });
        return;
      }
      case "approval.requested":
      case "approval.resolved": {
        const a = e.data.approval;
        set((s) => ({ approvals: { ...s.approvals, [a.id]: a } }));
        if (e.type === "approval.requested") {
          get().pushToast({ level: "approval", title: `Approval needed · ${a.tool_title}`, body: a.reason, link: `/security?approval=${a.id}` });
        }
        return;
      }
      case "notification.created": {
        const n = e.data.notification;
        set((s) => ({ notifications: [n, ...s.notifications].slice(0, 100) }));
        if (n.level !== "approval") get().pushToast({ level: n.level, title: n.title, body: n.body, link: n.link });
        if (typeof document !== "undefined" && document.visibilityState === "hidden" && "Notification" in window) {
          if (Notification.permission === "granted") new Notification(n.title, { body: n.body, tag: n.id });
        }
        return;
      }
      case "memory.used":
        set({ memoryUsed: e.data.memory_ids });
        return;
      case "memory.proposed":
        get().pushToast({ level: "info", title: "Memory proposed", body: e.data.memory.content, link: "/memory" });
        return;
      case "system.status":
        set({ system: e.data.status });
        return;
      default:
        return;
    }
  },
}));

export const selectPendingApprovals = (s: JarvisState) =>
  Object.values(s.approvals)
    .filter((a) => a.status === "pending")
    .sort((a, b) => a.requested_at.localeCompare(b.requested_at));

export const selectActiveRuns = (s: JarvisState) =>
  Object.values(s.runs).filter((r) => ACTIVE_RUN_STATUSES.has(r.status));

/** Stable (shallow-compared) hooks for derived lists — required with zustand v5 selectors that build arrays. */
export const usePendingApprovals = () => useJarvis(useShallow(selectPendingApprovals));
export const useActiveRuns = () => useJarvis(useShallow(selectActiveRuns));
export const useShallowJarvis = <T,>(selector: (s: JarvisState) => T) => useJarvis(useShallow(selector));
