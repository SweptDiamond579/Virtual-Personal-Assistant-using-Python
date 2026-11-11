"use client";

import type { DesktopAction, DeviceActionResult } from "@jarvis/protocol";
import { post } from "./api";
import { onServerEvent } from "./realtime";
import { useJarvis } from "./store";

/**
 * Desktop companion bridge (active only inside the Tauri app).
 * The backend proposes an action; the Rust layer enforces the local policy and
 * executes it; we relay the outcome. This file never executes anything itself.
 */

export interface DesktopInfo {
  version: string;
  os: string;
  emergency_stop: boolean;
  policy: {
    apps: { id: string; label: string }[];
    roots: { id: string; label: string; path: string; writable: boolean }[];
    max_file_bytes: number;
  };
}

export function inDesktopApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

export const desktopInfo = () => invoke<DesktopInfo>("desktop_info");
export const setDesktopEmergencyStop = (enabled: boolean) => invoke<boolean>("set_emergency_stop", { enabled });

let started = false;

export function startDesktopBridge(): () => void {
  if (!inDesktopApp() || started) return () => undefined;
  started = true;
  const off = onServerEvent(async (e) => {
    if (e.type === "system.status") {
      // Mirror the server-side emergency stop into the local Rust kill switch.
      try {
        await setDesktopEmergencyStop(e.data.status.emergency_stop);
      } catch {
        /* the desktop keeps its own state if the call fails */
      }
      return;
    }
    if (e.type !== "device.action.request") return;
    const req = e.data.request;
    if (useJarvis.getState().auth.session?.client_kind !== "desktop") return;
    let result: DeviceActionResult;
    try {
      const value = await invoke<unknown>("execute_action", { action: req.action as DesktopAction });
      result = { request_id: req.request_id, ok: true, result: value };
    } catch (err) {
      result = { request_id: req.request_id, ok: false, error: String(err).slice(0, 1900) };
    }
    try {
      await post(`/api/devices/actions/${req.request_id}/result`, {
        ok: result.ok,
        result: result.result ?? null,
        error: result.error ?? null,
      });
    } catch {
      /* request expired server-side */
    }
  });
  return () => {
    off();
    started = false;
  };
}
