export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const s = Math.round((now - t) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const v =
    a < 45 ? `${a}s` : a < 2700 ? `${Math.round(a / 60)}m` : a < 64800 ? `${Math.round(a / 3600)}h` : `${Math.round(a / 86400)}d`;
  return future ? `in ${v}` : `${v} ago`;
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function usd(n: number | null | undefined, digits = 4): string {
  return `$${(n ?? 0).toFixed(digits)}`;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function compact(n: number): string {
  return Intl.NumberFormat("en", { notation: "compact" }).format(n);
}
