"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Approval, NotificationItem, RunSummary, SystemStatus } from "@jarvis/protocol";
import { get, setCsrfToken } from "@/lib/api";
import { startDesktopBridge } from "@/lib/desktop-bridge";
import { RealtimeClient } from "@/lib/realtime";
import { useJarvis, type SessionInfo, type SessionUser } from "@/lib/store";

interface AuthState {
  setup_required: boolean;
  authenticated: boolean;
  user: SessionUser | null;
  session: SessionInfo | null;
  totp_enabled?: boolean;
}

export async function refreshAuth(): Promise<AuthState | null> {
  const setAuth = useJarvis.getState().setAuth;
  try {
    const state = await get<AuthState>("/api/auth/state");
    setCsrfToken(state.session?.csrf_token ?? null);
    setAuth({
      status: state.authenticated ? "authenticated" : state.setup_required ? "setup" : "anonymous",
      user: state.user,
      session: state.session,
      totpEnabled: state.totp_enabled ?? false,
    });
    return state;
  } catch {
    setAuth({ status: "error" });
    return null;
  }
}

async function loadInitialData() {
  const s = useJarvis.getState();
  const [approvals, notifications, status, runs] = await Promise.allSettled([
    get<Approval[]>("/api/approvals?status=pending"),
    get<NotificationItem[]>("/api/notifications"),
    get<SystemStatus>("/api/system/status"),
    get<RunSummary[]>("/api/runs?limit=30"),
  ]);
  if (approvals.status === "fulfilled") s.setApprovals(approvals.value);
  if (notifications.status === "fulfilled") s.setNotifications(notifications.value);
  if (status.status === "fulfilled") s.setSystem(status.value);
  if (runs.status === "fulfilled") s.setRuns(runs.value);
}

function SessionRuntime({ client }: { client: QueryClient }) {
  const status = useJarvis((s) => s.auth.status);
  const realtime = useRef<RealtimeClient | null>(null);

  useEffect(() => {
    void refreshAuth();
    const onUnauthorized = () => void refreshAuth();
    window.addEventListener("jarvis:unauthorized", onUnauthorized);
    return () => window.removeEventListener("jarvis:unauthorized", onUnauthorized);
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    void loadInitialData();
    const rt = new RealtimeClient(client);
    realtime.current = rt;
    rt.start();
    const stopBridge = startDesktopBridge();
    // Keep service health fresh even when no event arrives.
    const poll = setInterval(() => {
      void get<SystemStatus>("/api/system/status").then((s) => useJarvis.getState().setSystem(s)).catch(() => undefined);
    }, 30000);
    return () => {
      clearInterval(poll);
      stopBridge();
      rt.stop();
    };
  }, [status, client]);

  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);
  return null;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const status = useJarvis((s) => s.auth.status);
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (status === "anonymous" || status === "setup") router.replace(`/login/?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);
  if (status !== "authenticated") {
    return (
      <div className="grid min-h-dvh place-items-center bg-void">
        <div className="flex flex-col items-center gap-3 text-ink-3">
          <div className="size-10 animate-spin rounded-full border border-cyan/20 border-t-cyan" aria-hidden />
          <span className="data-label">{status === "error" ? "JARVIS server unreachable — retrying" : "Initialising"}</span>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 } },
      }),
  );
  useEffect(() => {
    const id = setInterval(() => {
      if (useJarvis.getState().auth.status === "error") void refreshAuth();
    }, 5000);
    return () => clearInterval(id);
  }, []);
  return (
    <QueryClientProvider client={client}>
      <SessionRuntime client={client} />
      {children}
    </QueryClientProvider>
  );
}
