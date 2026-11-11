"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Bell, Command as CommandIcon, Mic, OctagonX, Wifi, WifiOff } from "lucide-react";
import { CoreMiniIndicator } from "@/components/core";
import { ApprovalDock } from "@/components/approvals";
import { clsx } from "@/components/ui";
import { CORE_VISUALS } from "@/lib/core-visuals";
import { useCoreState } from "@/lib/hooks";
import { useJarvis } from "@/lib/store";
import { WORKSPACES, workspaceFor } from "@/lib/workspaces";
import { CommandBar, openCommandBar } from "./CommandBar";
import { NotificationCentre } from "./NotificationCentre";
import { Toaster } from "./Toaster";

function NavRail() {
  const pathname = usePathname();
  const active = workspaceFor(pathname)?.id;
  return (
    <nav aria-label="Workspaces" className="hidden w-[76px] shrink-0 flex-col items-center gap-1 border-r border-line bg-abyss/60 py-3 md:flex xl:w-[212px] xl:items-stretch xl:px-3">
      <Link href="/command/" className="mb-4 flex items-center gap-2.5 px-1 xl:px-2" aria-label="JARVIS home">
        <CoreMiniIndicator state={useCoreState()} size={34} />
        <span className="hidden font-display text-sm font-semibold tracking-[0.28em] text-ink xl:inline">JARVIS</span>
      </Link>
      {WORKSPACES.map((w) => {
        const on = w.id === active;
        return (
          <Link
            key={w.id}
            href={w.href}
            aria-current={on ? "page" : undefined}
            title={w.label}
            className={clsx(
              "group relative flex h-10 items-center justify-center gap-3 rounded-[10px] px-0 text-ink-3 transition-colors xl:justify-start xl:px-3",
              on ? "text-ink" : "hover:bg-surface/60 hover:text-ink-2",
            )}
          >
            {on && (
              <motion.span
                layoutId="nav-active"
                className="absolute inset-0 rounded-[10px] border border-cyan/30 bg-gradient-to-r from-cyan/15 to-cyan/[0.03]"
                transition={{ type: "spring", stiffness: 420, damping: 36 }}
              />
            )}
            {on && <span className="absolute top-2 bottom-2 left-0 w-[2px] rounded-full bg-cyan shadow-[0_0_10px] shadow-cyan" />}
            <w.icon className={clsx("relative size-[18px]", on && "text-cyan")} aria-hidden />
            <span className="relative hidden text-[13px] xl:inline">{w.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function MobileNav() {
  const pathname = usePathname();
  const active = workspaceFor(pathname)?.id;
  const primary = WORKSPACES.filter((w) => ["command", "mission", "assistant", "memory", "security"].includes(w.id));
  return (
    <nav aria-label="Workspaces" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-abyss/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
      <div className="flex">
        {primary.map((w) => (
          <Link key={w.id} href={w.href} aria-current={w.id === active ? "page" : undefined}
            className={clsx("flex flex-1 flex-col items-center gap-1 py-2 text-[10px]", w.id === active ? "text-cyan" : "text-ink-3")}>
            <w.icon className="size-5" aria-hidden />
            {w.short}
          </Link>
        ))}
        <button type="button" onClick={openCommandBar} className="flex flex-1 flex-col items-center gap-1 py-2 text-[10px] text-ink-3">
          <CommandIcon className="size-5" aria-hidden />
          More
        </button>
      </div>
    </nav>
  );
}

function TopBar() {
  const pathname = usePathname();
  const ws = workspaceFor(pathname);
  const core = useCoreState();
  const connection = useJarvis((s) => s.connection);
  const system = useJarvis((s) => s.system);
  const micActive = useJarvis((s) => s.micActive);
  const unread = useJarvis((s) => s.notifications.filter((n) => !n.read_at).length);
  const scripted = system?.ai.provider === "scripted";
  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-void/75 px-3 backdrop-blur-xl sm:px-5">
      <div className="md:hidden">
        <CoreMiniIndicator state={core} size={28} />
      </div>
      <div className="min-w-0">
        <div className="truncate font-display text-[15px] font-medium text-ink">{ws?.label ?? "JARVIS"}</div>
        <div className="flex items-center gap-1.5 text-[11px] text-ink-3" aria-live="polite">
          <span style={{ color: CORE_VISUALS[core].primary }}>{CORE_VISUALS[core].label}</span>
          <span className="hidden sm:inline">· {ws?.description}</span>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        {micActive && (
          <span className="chip border-danger/60 bg-danger/15 text-[#ffd0d8]" role="status">
            <Mic className="size-3 animate-pulse" aria-hidden /> Mic live
          </span>
        )}
        {system?.emergency_stop && (
          <Link href="/security/" className="chip border-danger/60 bg-danger/15 text-[#ffd0d8]">
            <OctagonX className="size-3" aria-hidden /> Stopped
          </Link>
        )}
        {scripted && (
          <span className="chip hidden border-amber/50 text-amber sm:inline-flex" title="No AI model is connected; responses come from the deterministic scripted test provider.">
            Scripted test provider
          </span>
        )}
        {system && !system.ai.configured && (
          <Link href="/settings/" className="chip hidden border-amber/50 text-amber sm:inline-flex">AI not configured</Link>
        )}
        <span className={clsx("chip hidden sm:inline-flex", connection === "open" ? "text-success border-success/30" : "text-danger border-danger/40")}>
          {connection === "open" ? <Wifi className="size-3" aria-hidden /> : <WifiOff className="size-3" aria-hidden />}
          {connection === "open" ? "Live" : connection === "connecting" ? "Connecting" : "Offline"}
        </span>
        <button type="button" onClick={openCommandBar} className="btn btn-ghost hidden h-8 px-2.5 text-xs text-ink-3 sm:inline-flex" aria-label="Open command bar">
          <CommandIcon className="size-3.5" aria-hidden /> <kbd className="font-mono text-[10px]">Ctrl K</kbd>
        </button>
        <NotificationCentre>
          <button type="button" className="btn btn-ghost relative h-8 w-8 px-0" aria-label={`Notifications (${unread} unread)`}>
            <Bell className="size-4" aria-hidden />
            {unread > 0 && (
              <span className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-cyan px-1 font-mono text-[9px] font-semibold text-void">
                {unread > 99 ? "99+" : unread}
              </span>
            )}
          </button>
        </NotificationCentre>
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  return (
    <div className="flex h-dvh overflow-hidden bg-void text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-cyan focus:px-3 focus:py-1 focus:text-void">
        Skip to content
      </a>
      <NavRail />
      <div className="relative flex min-w-0 flex-1 flex-col">
        <div className="tech-grid pointer-events-none absolute inset-0 opacity-60" aria-hidden />
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[420px]"
          style={{ background: "radial-gradient(50% 100% at 50% 0%, rgb(46 230 255 / 0.06), transparent 80%)" }}
          aria-hidden
        />
        <TopBar />
        <AnimatePresence mode="wait" initial={false}>
          <motion.main
            id="main"
            key={workspaceFor(pathname)?.id ?? pathname}
            initial={reduce ? false : { opacity: 0, y: 8, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={reduce ? undefined : { opacity: 0, y: -6, filter: "blur(4px)" }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="relative min-h-0 flex-1 overflow-y-auto px-3 pt-4 pb-24 sm:px-5 md:pb-6"
          >
            {children}
          </motion.main>
        </AnimatePresence>
      </div>
      <MobileNav />
      <CommandBar />
      <ApprovalDock />
      <Toaster />
    </div>
  );
}
