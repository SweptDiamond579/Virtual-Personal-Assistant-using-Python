"use client";

import { Command } from "cmdk";
import { CornerDownLeft, OctagonX, Sparkles, Sun, Terminal, Zap } from "lucide-react";
import { Dialog } from "radix-ui";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { post } from "@/lib/api";
import { parseDirectCommand, runDirectCommand, sendChat, SLASH_HELP } from "@/lib/chat";
import { useJarvis } from "@/lib/store";
import { WORKSPACES } from "@/lib/workspaces";

const useBar = create<{ open: boolean; setOpen: (v: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export const openCommandBar = () => useBar.getState().setOpen(true);

const itemCls =
  "flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink-2 data-[selected=true]:bg-cyan/10 data-[selected=true]:text-ink";

export function CommandBar() {
  const { open, setOpen } = useBar();
  const [query, setQuery] = useState("");
  const router = useRouter();
  const emergency = useJarvis((s) => s.system?.emergency_stop ?? false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useBar.getState().open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const direct = parseDirectCommand(query);
  const toast = useJarvis.getState().pushToast;

  async function run(fn: () => Promise<unknown>, okMsg?: string) {
    close();
    try {
      await fn();
      if (okMsg) toast({ level: "info", title: okMsg });
    } catch (e) {
      toast({ level: "error", title: "Command failed", body: e instanceof Error ? e.message : String(e) });
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(v) => (v ? setOpen(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-void/70 backdrop-blur-sm data-[state=open]:animate-in" />
        <Dialog.Content
          aria-describedby={undefined}
          className="holo-panel fixed top-[12vh] left-1/2 z-50 w-[min(640px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden p-0"
        >
          <Dialog.Title className="sr-only">Command bar</Dialog.Title>
          <Command label="Command bar" shouldFilter={!query.startsWith("/")} loop>
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Terminal className="size-4 text-cyan" aria-hidden />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Ask JARVIS, jump to a workspace, or type / for direct commands"
                className="h-13 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-4"
              />
              <kbd className="font-mono text-[10px] text-ink-4">ESC</kbd>
            </div>
            <Command.List className="max-h-[56vh] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-sm text-ink-3">No matches.</Command.Empty>
              {query.trim() && !query.startsWith("/") && (
                <Command.Group heading="Ask" className="text-[10px] text-ink-4 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.2em]">
                  <Command.Item
                    value={`ask ${query}`}
                    className={itemCls}
                    onSelect={() =>
                      run(async () => {
                        router.push("/command/");
                        await sendChat(query.trim());
                      })
                    }
                  >
                    <Sparkles className="size-4 text-cyan" aria-hidden />
                    <span className="truncate">Ask JARVIS: “{query.trim()}”</span>
                    <CornerDownLeft className="ml-auto size-3.5 text-ink-4" aria-hidden />
                  </Command.Item>
                </Command.Group>
              )}
              {query.startsWith("/") && (
                <Command.Group heading="Direct command — runs the tool without an AI model" className="text-[10px] text-ink-4 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5">
                  {direct ? (
                    <Command.Item value={`direct ${query}`} className={itemCls} onSelect={() => run(() => runDirectCommand(direct), `Running: ${direct.label}`)}>
                      <Zap className="size-4 text-cyan" aria-hidden />
                      {direct.label}
                      <span className="ml-auto font-mono text-[10px] text-ink-4">{direct.tool}</span>
                    </Command.Item>
                  ) : (
                    SLASH_HELP.map(([syntax, desc]) => (
                      <Command.Item key={syntax} value={syntax} className={itemCls} onSelect={() => setQuery(syntax.split(" ")[0] + " ")}>
                        <span className="font-mono text-xs text-ice">{syntax}</span>
                        <span className="ml-auto text-xs text-ink-3">{desc}</span>
                      </Command.Item>
                    ))
                  )}
                </Command.Group>
              )}
              {!query.startsWith("/") && (
                <>
                  <Command.Group heading="Workspaces" className="text-[10px] text-ink-4 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.2em]">
                    {WORKSPACES.map((w) => (
                      <Command.Item key={w.id} value={`go ${w.label} ${w.description}`} className={itemCls} onSelect={() => { close(); router.push(w.href); }}>
                        <w.icon className="size-4 text-ink-3" aria-hidden />
                        {w.label}
                        <span className="ml-auto truncate text-xs text-ink-4">{w.description}</span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                  <Command.Group heading="Actions" className="text-[10px] text-ink-4 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.2em]">
                    <Command.Item value="run daily briefing" className={itemCls}
                      onSelect={() => run(() => post("/api/workflow-templates/daily_briefing/instantiate", { params: {}, run_now: true }), "Daily briefing started")}>
                      <Sun className="size-4 text-ink-3" aria-hidden /> Run daily briefing workflow
                    </Command.Item>
                    <Command.Item value="emergency stop all agents" className={itemCls}
                      onSelect={() => run(() => post("/api/security/emergency-stop", { active: !emergency }), emergency ? "Emergency stop released" : "Emergency stop engaged")}>
                      <OctagonX className="size-4 text-danger" aria-hidden /> {emergency ? "Release emergency stop" : "Emergency stop — halt all agent actions"}
                    </Command.Item>
                  </Command.Group>
                </>
              )}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
