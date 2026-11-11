"use client";

import { BellOff, CheckCheck } from "lucide-react";
import Link from "next/link";
import { Popover } from "radix-ui";
import type { ReactNode } from "react";
import { post } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useJarvis } from "@/lib/store";
import { Button, EmptyState, StatusDot, statusTone, clsx } from "@/components/ui";

const LEVEL_TONE = { info: "cyan", success: "success", warning: "amber", error: "danger", approval: "amber" } as const;

export function NotificationCentre({ children }: { children: ReactNode }) {
  const notifications = useJarvis((s) => s.notifications);
  const markAllRead = useJarvis((s) => s.markAllRead);
  return (
    <Popover.Root>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="holo-panel z-50 w-[min(400px,calc(100vw-16px))] p-0 data-[state=open]:animate-in"
        >
          <div className="flex items-center border-b border-line px-4 py-2.5">
            <h2 className="panel-title">Notifications</h2>
            <Button
              variant="ghost"
              icon={CheckCheck}
              className="ml-auto h-7 text-xs"
              onClick={async () => {
                markAllRead();
                await post("/api/notifications/read-all").catch(() => undefined);
              }}
            >
              Mark all read
            </Button>
          </div>
          <ul className="max-h-[60vh] overflow-y-auto">
            {notifications.length === 0 && (
              <li>
                <EmptyState icon={BellOff} title="Nothing yet">Task results, reminders and approvals appear here.</EmptyState>
              </li>
            )}
            {notifications.map((n) => {
              const body = (
                <div className={clsx("flex gap-3 border-b border-line/60 px-4 py-3", !n.read_at && "bg-cyan/[0.03]")}>
                  <div className="pt-1.5">
                    <StatusDot tone={LEVEL_TONE[n.level] ?? statusTone(n.level)} pulse={!n.read_at && n.level === "approval"} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className={clsx("truncate text-sm", n.read_at ? "text-ink-2" : "text-ink")}>{n.title}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-4">{timeAgo(n.created_at)}</span>
                    </div>
                    {n.body && <p className="mt-0.5 line-clamp-3 text-xs whitespace-pre-line text-ink-3">{n.body}</p>}
                  </div>
                </div>
              );
              return (
                <li key={n.id}>
                  {n.link ? (
                    <Popover.Close asChild>
                      <Link href={n.link.replace(/^\/([a-z]+)(\?|$)/, "/$1/$2")} className="block hover:bg-surface/50">{body}</Link>
                    </Popover.Close>
                  ) : (
                    body
                  )}
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
