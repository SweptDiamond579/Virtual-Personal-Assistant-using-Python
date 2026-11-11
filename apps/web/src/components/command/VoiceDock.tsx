"use client";

import { Mic, MicOff, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVoicePrefs } from "@/lib/hooks";
import { useJarvis } from "@/lib/store";
import { micAvailable, voice } from "@/lib/voice";
import { clsx } from "@/components/ui";

/**
 * Push-to-talk: hold the button (or hold Space when not typing) to talk; release to send.
 * A click toggles capture for hands-free use; with auto-stop, silence ends the capture.
 * The microphone is only open while the red indicator is visible.
 */
export function VoiceButton({ onTranscript }: { onTranscript: (text: string) => void }) {
  const prefs = useVoicePrefs();
  const micActive = useJarvis((s) => s.micActive);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const holdStart = useRef(0);
  const supported = typeof window !== "undefined" && micAvailable();

  const stop = useCallback(async () => {
    if (!voice.capturing) return;
    setBusy(true);
    try {
      const { text } = await voice.stopCapture();
      onTranscript(text);
      if (!text) useJarvis.getState().pushToast({ level: "warning", title: "No speech recognised" });
    } catch (e) {
      useJarvis.getState().pushToast({ level: "error", title: "Transcription failed", body: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }, [onTranscript]);

  const start = useCallback(async () => {
    if (voice.capturing || busy) return;
    try {
      await voice.startCapture(prefs, () => void stop());
      setDenied(false);
    } catch {
      setDenied(true);
      useJarvis.getState().pushToast({ level: "error", title: "Microphone unavailable", body: "Permission denied or no input device." });
    }
  }, [prefs, busy, stop]);

  // Hold Space to talk (ignored while typing in inputs).
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !e.repeat && !isTyping(e.target)) {
        e.preventDefault();
        void start();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping(e.target)) void stop();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [start, stop]);

  if (!supported) {
    return (
      <span className="grid h-[2.6rem] w-[2.6rem] place-items-center rounded-[9px] border border-line text-ink-4" title="Voice input is not supported in this browser">
        <MicOff className="size-4" aria-hidden />
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-label={micActive ? "Stop listening" : "Push to talk (hold, or press Space)"}
      aria-pressed={micActive}
      data-testid="voice-button"
      onPointerDown={() => {
        holdStart.current = performance.now();
        void start();
      }}
      onPointerUp={() => {
        // Long press = push-to-talk; short click = toggle hands-free.
        if (performance.now() - holdStart.current > 350) void stop();
      }}
      onClick={() => {
        if (performance.now() - holdStart.current <= 350 && micActive) void stop();
      }}
      className={clsx(
        "relative grid h-[2.6rem] w-[2.6rem] shrink-0 place-items-center rounded-[9px] border transition-all",
        micActive
          ? "border-danger/70 bg-danger/20 text-[#ffd0d8] shadow-[0_0_24px_-6px_rgb(255_77_109/0.8)]"
          : denied
            ? "border-line text-ink-4"
            : "border-cyan/40 bg-cyan/10 text-cyan hover:bg-cyan/20",
      )}
    >
      {micActive && <span className="absolute inset-0 animate-ping rounded-[9px] border border-danger/50" aria-hidden />}
      {busy ? <span className="size-3.5 animate-spin rounded-full border border-cyan/30 border-t-cyan" aria-hidden /> : micActive ? <Square className="size-3.5" aria-hidden /> : <Mic className="size-4" aria-hidden />}
    </button>
  );
}
