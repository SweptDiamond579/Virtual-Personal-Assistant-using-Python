"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop, Link2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { refreshAuth } from "@/components/providers";
import { Button, Chip, ErrorNote, FieldLabel } from "@/components/ui";
import { del, get, post } from "@/lib/api";
import { desktopInfo, inDesktopApp, type DesktopInfo } from "@/lib/desktop-bridge";
import { useJarvis } from "@/lib/store";

export function DesktopPairing() {
  const qc = useQueryClient();
  const session = useJarvis((s) => s.auth.session);
  const [code, setCode] = useState<string | null>(null);
  const [entered, setEntered] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const desktop = inDesktopApp();
  const { data: devices } = useQuery({
    queryKey: ["devices"],
    queryFn: () => get<{ id: string; name: string; online: boolean; paired_at: string }[]>("/api/devices"),
  });
  useEffect(() => {
    if (desktop) void desktopInfo().then(setInfo).catch(() => undefined);
  }, [desktop]);

  return (
    <div className="space-y-3 text-xs">
      {devices?.map((d) => (
        <div key={d.id} className="flex items-center gap-2">
          <Laptop className="size-3.5 text-ink-3" aria-hidden />
          <span className="text-ink-2">{d.name}</span>
          <Chip tone={d.online ? "success" : "muted"}>{d.online ? "online" : "offline"}</Chip>
          <Button variant="ghost" className="ml-auto h-7 text-xs text-danger" icon={Trash2} onClick={async () => { await del(`/api/devices/${d.id}`); await qc.invalidateQueries({ queryKey: ["devices"] }); }}>
            Unpair
          </Button>
        </div>
      ))}
      {desktop ? (
        session?.client_kind === "desktop" ? (
          <div>
            <p className="text-success">This desktop app is paired.</p>
            {info && (
              <p className="mt-1 text-ink-3">
                Local policy: {info.policy.apps.length} allowed app(s), {info.policy.roots.length} authorised folder(s)
                {info.policy.roots.map((r) => ` · ${r.label}${r.writable ? " (writable)" : ""}`).join("")}. Edit the policy file on this computer to change it.
              </p>
            )}
          </div>
        ) : (
          <form
            className="space-y-2"
            onSubmit={async (e) => {
              e.preventDefault();
              setError(null);
              try {
                await post("/api/devices/pair", { code: entered, name: info ? `${info.os} desktop` : "Desktop" });
                await refreshAuth();
                await qc.invalidateQueries({ queryKey: ["devices"] });
              } catch (err) {
                setError(err);
              }
            }}
          >
            <FieldLabel htmlFor="pair-code">Pairing code (generate it from any signed-in JARVIS session)</FieldLabel>
            <div className="flex gap-2">
              <input id="pair-code" className="field font-mono uppercase" value={entered} onChange={(e) => setEntered(e.target.value)} />
              <Button type="submit" variant="primary" icon={Link2} disabled={entered.length < 6}>Pair this desktop</Button>
            </div>
            <ErrorNote error={error} />
          </form>
        )
      ) : (
        <div>
          <p className="text-ink-3">
            Install the JARVIS desktop app, sign in, and enter a pairing code there. Desktop actions are re-checked by the desktop&apos;s own local policy;
            high-risk ones can only be approved on the desktop itself.
          </p>
          {code ? (
            <p className="mt-2">Code: <span className="font-mono text-base tracking-[0.3em] text-ice">{code}</span> <span className="text-ink-4">(valid 10 minutes)</span></p>
          ) : (
            <Button className="mt-2 h-8 text-xs" icon={Link2} onClick={async () => setCode((await post<{ code: string }>("/api/devices/pairing")).code)}>
              Generate pairing code
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
