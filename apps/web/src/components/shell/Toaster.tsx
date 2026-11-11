"use client";

import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useJarvis, useShallowJarvis } from "@/lib/store";
import { clsx } from "@/components/ui";

const BORDER = {
  info: "border-cyan/35",
  success: "border-success/40",
  warning: "border-amber/45",
  error: "border-danger/50",
  approval: "border-amber/55",
} as const;

export function Toaster() {
  const toasts = useShallowJarvis((s) => s.toasts.filter((t) => t.level !== "approval"));
  const dismiss = useJarvis((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed top-16 right-3 z-50 flex w-[min(360px,calc(100vw-24px))] flex-col gap-2" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: -10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 30 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className={clsx("pointer-events-auto rounded-xl border bg-midnight/95 p-3 shadow-2xl backdrop-blur-xl", BORDER[t.level])}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                {t.link ? (
                  <Link href={t.link.replace(/^\/([a-z]+)(\?|$)/, "/$1/$2")} className="text-sm text-ink hover:text-cyan">{t.title}</Link>
                ) : (
                  <div className="text-sm text-ink">{t.title}</div>
                )}
                {t.body && <p className="mt-0.5 line-clamp-3 text-xs whitespace-pre-line text-ink-3">{t.body}</p>}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} className="text-ink-4 hover:text-ink" aria-label="Dismiss">
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
