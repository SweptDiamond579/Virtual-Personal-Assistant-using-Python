"use client";

import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { CoreMiniIndicator } from "@/components/core";
import { refreshAuth } from "@/components/providers";
import { Button, ErrorNote, FieldLabel } from "@/components/ui";
import { post } from "@/lib/api";
import { useJarvis } from "@/lib/store";

function nextTarget(): string {
  if (typeof window === "undefined") return "/command/";
  const n = new URLSearchParams(window.location.search).get("next");
  return n && n.startsWith("/") && !n.startsWith("//") && !n.startsWith("/login") ? n : "/command/";
}

export default function LoginPage() {
  const status = useJarvis((s) => s.auth.status);
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [otp, setOtp] = useState("");
  const [needOtp, setNeedOtp] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const setup = status === "setup";
  const isMobile = typeof navigator !== "undefined" && /Mobi|Android|iPhone/i.test(navigator.userAgent);

  useEffect(() => {
    if (status === "authenticated") router.replace(nextTarget());
  }, [status, router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (setup) {
        await post("/api/auth/setup", { setup_token: setupToken, username, password, display_name: displayName });
      } else {
        await post("/api/auth/login", {
          username,
          password,
          client_kind: isMobile ? "mobile" : "web",
          ...(needOtp ? { otp } : {}),
        });
      }
      await refreshAuth();
    } catch (err) {
      if (err instanceof Error && err.message === "totp_required") {
        setNeedOtp(true);
        setError(null);
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="tech-grid relative grid min-h-dvh place-items-center overflow-hidden bg-void px-4">
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(60% 50% at 50% 35%, rgb(46 230 255 / 0.10), transparent 70%)" }}
        aria-hidden
      />
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="holo-panel relative w-full max-w-sm p-7"
      >
        <div className="mb-6 flex items-center gap-3">
          <CoreMiniIndicator state={status === "error" ? "OFFLINE" : "IDLE"} size={40} />
          <div>
            <div className="font-display text-lg font-semibold tracking-[0.18em]">JARVIS OS</div>
            <div className="data-label">{setup ? "First-run setup" : "Secure sign-in"}</div>
          </div>
        </div>
        {status === "error" && <ErrorNote error="Cannot reach the JARVIS server. Is the API running?" />}
        <form onSubmit={submit} className="space-y-4">
          {setup && (
            <>
              <p className="rounded-lg border border-cyan/25 bg-cyan/5 p-3 text-xs leading-relaxed text-ink-2">
                <ShieldCheck className="mr-1 inline size-3.5 text-cyan" aria-hidden />
                Create the owner account. You need the one-time <code className="font-mono text-ice">JARVIS_SETUP_TOKEN</code>{" "}
                configured on the server.
              </p>
              <div>
                <FieldLabel htmlFor="token">Setup token</FieldLabel>
                <input id="token" className="field font-mono" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} autoComplete="off" required />
              </div>
              <div>
                <FieldLabel htmlFor="display">Your name</FieldLabel>
                <input id="display" className="field" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
            </>
          )}
          <div>
            <FieldLabel htmlFor="user">Username</FieldLabel>
            <input id="user" className="field" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
          </div>
          <div>
            <FieldLabel htmlFor="pass">Password {setup && <span className="normal-case tracking-normal">(min 12 characters)</span>}</FieldLabel>
            <input
              id="pass"
              type="password"
              className="field"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={setup ? "new-password" : "current-password"}
              minLength={setup ? 12 : 1}
              required
            />
          </div>
          {needOtp && (
            <div>
              <FieldLabel htmlFor="otp">Authentication code</FieldLabel>
              <input
                id="otp"
                className="field font-mono tracking-[0.3em]"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                autoComplete="one-time-code"
                inputMode="text"
                placeholder="123456 or recovery code"
                autoFocus
                required
              />
              <p className="mt-1 text-[11px] text-ink-4">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
            </div>
          )}
          <ErrorNote error={error} />
          <Button type="submit" variant="primary" className="w-full" loading={busy} icon={setup ? KeyRound : ArrowRight}>
            {setup ? "Create owner account" : "Sign in"}
          </Button>
        </form>
        <p className="mt-5 text-center text-[11px] leading-relaxed text-ink-4">
          Sessions use HttpOnly cookies with CSRF protection. Your API keys stay on the server.
        </p>
      </motion.div>
    </main>
  );
}
