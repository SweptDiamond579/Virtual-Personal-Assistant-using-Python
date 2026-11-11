"use client";

import type { QueryClient } from "@tanstack/react-query";
import type { ServerEvent } from "@jarvis/protocol";
import { post } from "./api";
import { useJarvis } from "./store";

/** Which cached queries each event invalidates. */
const INVALIDATES: Partial<Record<ServerEvent["type"], string[][]>> = {
  "run.updated": [["runs"], ["usage"]],
  "run.started": [["runs"]],
  "assistant.completed": [["conversations"]],
  "approval.resolved": [["approvals"]],
  "approval.requested": [["approvals"]],
  "memory.proposed": [["memories"]],
  "job.updated": [["jobs"]],
  "notification.created": [["notifications"]],
  "tool.finished": [["notes"], ["findings"], ["drafts"], ["jobs"]],
};

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();

export function onServerEvent(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function wsUrl(ticket: string): string {
  const explicit = process.env.NEXT_PUBLIC_JARVIS_WS_ORIGIN;
  const { protocol, hostname, port, host } = window.location;
  const scheme = protocol === "https:" ? "wss:" : "ws:";
  // `next dev` (port 3000) does not proxy WebSocket upgrades; connect to the API directly.
  const origin = explicit ?? (port === "3000" ? `${scheme}//${hostname}:8000` : `${scheme}//${host}`);
  return `${origin}/api/ws?ticket=${encodeURIComponent(ticket)}`;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private queryClient: QueryClient) {}

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    useJarvis.getState().setConnection("closed");
  }

  private async connect() {
    if (this.stopped) return;
    const store = useJarvis.getState();
    store.setConnection("connecting");
    let ticket: string;
    try {
      ticket = (await post<{ ticket: string }>("/api/realtime/ticket")).ticket;
    } catch {
      this.scheduleReconnect();
      return;
    }
    const ws = new WebSocket(wsUrl(ticket));
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      useJarvis.getState().setConnection("open");
      // Resync anything we may have missed while disconnected.
      void this.queryClient.invalidateQueries();
      this.pingTimer = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 25000);
    };
    ws.onmessage = (msg) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(msg.data as string) as ServerEvent;
      } catch {
        return;
      }
      if (!event || typeof event !== "object" || !("type" in event)) return;
      useJarvis.getState().applyEvent(event);
      for (const key of INVALIDATES[event.type] ?? []) void this.queryClient.invalidateQueries({ queryKey: key });
      for (const fn of listeners) fn(event);
    };
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.ws === ws) this.ws = null;
      useJarvis.getState().setConnection("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.min(15000, 500 * 2 ** this.attempt++) + Math.random() * 300;
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }
}
