"use client";

import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { refreshAuth } from "@/components/providers";
import { Button, Chip, ErrorNote, FieldLabel } from "@/components/ui";
import { post } from "@/lib/api";
import { useJarvis } from "@/lib/store";

export function TwoFactor() {
  const enabled = useJarvis((s) => s.auth.totpEnabled);
  const [setup, setSetup] = useState<{ secret: string; qr_svg: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    }
  };

  if (recovery) {
    return (
      <div className="space-y-2 text-xs">
        <p className="text-success">Two-factor authentication is on. Save these recovery codes now — each works once and they will not be shown again.</p>
        <ul className="grid grid-cols-2 gap-1 font-mono text-ice">
          {recovery.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <Button onClick={() => setRecovery(null)}>I have saved them</Button>
      </div>
    );
  }

  if (enabled) {
    return (
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        await post("/api/auth/totp/disable", { password, code });
        setPassword(""); setCode("");
        await refreshAuth();
      }); }}>
        <p className="flex items-center gap-2 text-xs text-ink-2"><ShieldCheck className="size-4 text-success" aria-hidden /> Two-factor authentication is enabled.</p>
        <FieldLabel htmlFor="tf-pw">Password</FieldLabel>
        <input id="tf-pw" type="password" className="field" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        <FieldLabel htmlFor="tf-code">Authentication or recovery code</FieldLabel>
        <input id="tf-code" className="field font-mono" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
        <ErrorNote error={error} />
        <Button variant="danger" type="submit" disabled={!password || code.length < 6}>Disable two-factor</Button>
      </form>
    );
  }

  if (setup) {
    return (
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void run(async () => {
        const r = await post<{ recovery_codes: string[] }>("/api/auth/totp/enable", { code });
        setRecovery(r.recovery_codes); setSetup(null); setCode("");
        await refreshAuth();
      }); }}>
        <p className="text-xs text-ink-3">Scan with an authenticator app (1Password, Aegis, Google Authenticator…), then enter the current code.</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- generated QR code, data URI */}
        <img src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr_svg)}`} alt="Authenticator QR code" className="size-44 rounded-lg border border-line bg-void p-2" />
        <p className="text-[11px] text-ink-4">Manual key: <span className="font-mono text-ice break-all">{setup.secret}</span></p>
        <FieldLabel htmlFor="tf-enable">6-digit code</FieldLabel>
        <input id="tf-enable" className="field font-mono tracking-[0.3em]" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
        <ErrorNote error={error} />
        <Button variant="primary" type="submit" disabled={code.length !== 6}>Verify and enable</Button>
      </form>
    );
  }

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-2 text-xs text-ink-3">Two-factor authentication <Chip tone="amber">off</Chip></p>
      <ErrorNote error={error} />
      <Button icon={ShieldCheck} onClick={() => void run(async () => setSetup(await post("/api/auth/totp/setup")))}>Set up authenticator app</Button>
    </div>
  );
}
