"use client";

import { BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Chip, ErrorNote } from "@/components/ui";
import { post } from "@/lib/api";
import { currentSubscription, disablePush, enablePush, pushSupported } from "@/lib/push";

export function PushControls() {
  const [state, setState] = useState<"unknown" | "on" | "off" | "unsupported">("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!pushSupported()) {
      queueMicrotask(() => setState("unsupported"));
      return;
    }
    void currentSubscription().then((s) => setState(s ? "on" : "off"));
  }, []);

  const act = async (fn: () => Promise<void>, next: "on" | "off") => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setState(next);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-ink">Push to this device</span>
        <Chip tone={state === "on" ? "success" : state === "unsupported" ? "amber" : "muted"}>
          {state === "unsupported" ? "not supported here" : state}
        </Chip>
      </div>
      <p className="text-xs text-ink-3">
        Approvals, reminders and failures reach you even when JARVIS is closed (install it to your home screen on iOS first). Payloads are end-to-end encrypted to this device.
      </p>
      <ErrorNote error={error} />
      {note && <p className="text-xs text-ink-2">{note}</p>}
      <div className="flex gap-2">
        {state === "off" && <Button icon={BellRing} loading={busy} onClick={() => act(enablePush, "on")}>Enable</Button>}
        {state === "on" && (
          <>
            <Button loading={busy} onClick={async () => setNote(`Delivered to ${(await post<{ delivered: number }>("/api/push/test")).delivered} device(s).`)}>Send test</Button>
            <Button variant="ghost" loading={busy} onClick={() => act(disablePush, "off")}>Disable</Button>
          </>
        )}
      </div>
    </div>
  );
}
