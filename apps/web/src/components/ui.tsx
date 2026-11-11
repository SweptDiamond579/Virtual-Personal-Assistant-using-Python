"use client";

import clsx from "clsx";
import { Loader2, type LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { Switch as RSwitch } from "radix-ui";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export { clsx };

export function Panel({
  title,
  icon: Icon,
  actions,
  children,
  className,
  bodyClassName,
  delay = 0,
  id,
}: {
  title?: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  delay?: number;
  id?: string;
}) {
  return (
    <motion.section
      id={id}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.16, 1, 0.3, 1] }}
      className={clsx("holo-panel flex min-h-0 flex-col", className)}
    >
      {title !== undefined && (
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          {Icon && <Icon className="size-3.5 text-cyan" aria-hidden />}
          <h2 className="panel-title shrink-0">{title}</h2>
          <div className="ml-auto flex min-w-0 items-center gap-1.5 overflow-x-auto">{actions}</div>
        </header>
      )}
      <div className={clsx("min-h-0 flex-1", bodyClassName ?? "p-4")}>{children}</div>
    </motion.section>
  );
}

type Tone = "cyan" | "ice" | "violet" | "amber" | "danger" | "success" | "muted";

const TONES: Record<Tone, string> = {
  cyan: "border-cyan/40 text-cyan",
  ice: "border-ice/30 text-ice",
  violet: "border-violet/40 text-violet",
  amber: "border-amber/45 text-amber",
  danger: "border-danger/50 text-danger",
  success: "border-success/40 text-success",
  muted: "border-line-2 text-ink-3",
};

export function Chip({ tone = "muted", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span className={clsx("chip", TONES[tone], className)} title={title}>
      {children}
    </span>
  );
}

export function riskTone(risk: string): Tone {
  return ({ read_only: "muted", low: "cyan", medium: "violet", high: "amber", critical: "danger" } as Record<string, Tone>)[risk] ?? "muted";
}

export function statusTone(status: string): Tone {
  if (["ok", "succeeded", "connected", "active", "approved", "sent", "auto"].includes(status)) return "success";
  if (["running", "queued", "public_mode", "proposed", "draft"].includes(status)) return "cyan";
  if (["waiting_approval", "pending", "degraded", "ask", "planned"].includes(status)) return "amber";
  if (["failed", "down", "denied", "error", "deny", "expired"].includes(status)) return "danger";
  return "muted";
}

export function StatusDot({ tone = "muted", pulse = false, label }: { tone?: Tone; pulse?: boolean; label?: string }) {
  const color = {
    cyan: "bg-cyan",
    ice: "bg-ice",
    violet: "bg-violet",
    amber: "bg-amber",
    danger: "bg-danger",
    success: "bg-success",
    muted: "bg-ink-4",
  }[tone];
  return (
    <span className="relative inline-flex size-2 shrink-0" role={label ? "img" : undefined} aria-label={label}>
      {pulse && <span className={clsx("absolute inset-0 animate-ping rounded-full opacity-60", color)} />}
      <span className={clsx("relative inline-flex size-2 rounded-full", color)} />
    </span>
  );
}

export function Button({
  variant = "default",
  loading,
  icon: Icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "ghost";
  loading?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={clsx(
        "btn",
        variant === "primary" && "btn-primary",
        variant === "danger" && "btn-danger",
        variant === "ghost" && "btn-ghost",
        className,
      )}
    >
      {loading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : Icon ? <Icon className="size-3.5" aria-hidden /> : null}
      {children}
    </button>
  );
}

export function EmptyState({ icon: Icon, title, children }: { icon?: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-8 text-center">
      {Icon && (
        <div className="grid size-10 place-items-center rounded-full border border-line-2 text-ink-3">
          <Icon className="size-4" aria-hidden />
        </div>
      )}
      <p className="text-sm text-ink-2">{title}</p>
      {children && <div className="max-w-sm text-xs leading-relaxed text-ink-3">{children}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        "relative overflow-hidden rounded-md bg-surface-2/70",
        "after:absolute after:inset-0 after:-translate-x-full after:animate-[shimmer_1.6s_infinite] after:bg-gradient-to-r after:from-transparent after:via-white/5 after:to-transparent",
        className,
      )}
    />
  );
}

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9" />
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-[#ffd0d8]">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-2">
      <span>
        <span className="block text-sm text-ink">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-ink-3">{description}</span>}
      </span>
      <RSwitch.Root
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full border border-line-2 bg-abyss transition-colors data-[state=checked]:border-cyan/60 data-[state=checked]:bg-cyan/25 disabled:opacity-40"
      >
        <RSwitch.Thumb className="block size-3.5 translate-x-0.5 rounded-full bg-ink-3 transition-transform data-[state=checked]:translate-x-[18px] data-[state=checked]:bg-cyan" />
      </RSwitch.Root>
    </label>
  );
}

export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="data-label mb-1.5 block">
      {children}
    </label>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="min-w-0">
      <div className="data-label">{label}</div>
      <div className={clsx("mt-1 font-display text-2xl font-medium tabular-nums", tone ? TONES[tone].split(" ")[1] : "text-ink")}>
        {value}
      </div>
      {sub && <div className="mt-0.5 truncate text-xs text-ink-3">{sub}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-xl font-medium tracking-tight text-ink sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function JsonBlock({ value, max = 1200 }: { value: unknown; max?: number }) {
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text && text.length > max) text = text.slice(0, max) + "\n…";
  return (
    <pre className="max-h-64 overflow-auto rounded-lg border border-line bg-void/70 p-3 font-mono text-[11px] leading-relaxed text-ink-2">
      {text}
    </pre>
  );
}
