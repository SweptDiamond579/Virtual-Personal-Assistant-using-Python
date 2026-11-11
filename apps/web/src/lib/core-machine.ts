import type { CoreState, RunSummary } from "@jarvis/protocol";

/**
 * Derives the AI core's visual state from real application signals.
 * Pure and deterministic so it can be unit-tested; nothing here invents activity.
 *
 * Priority (highest first):
 *   OFFLINE              — realtime connection to the server is down
 *   WAITING_FOR_APPROVAL — at least one approval is pending
 *   LISTENING            — the microphone is actively capturing
 *   SPEAKING             — a spoken response is playing
 *   EXECUTING            — a tool call is in flight
 *   THINKING             — a run is active (model reasoning / streaming)
 *   SUCCESS / ERROR      — briefly after the most recent run finished
 *   IDLE
 */
export interface CoreInputs {
  connected: boolean;
  micActive: boolean;
  speaking: boolean;
  pendingApprovals: number;
  runningTools: number;
  activeRuns: number;
  lastOutcome: { status: RunSummary["status"]; at: number } | null;
  now: number;
}

export const SUCCESS_HOLD_MS = 1800;
export const ERROR_HOLD_MS = 4000;

export function deriveCoreState(i: CoreInputs): CoreState {
  if (!i.connected) return "OFFLINE";
  if (i.pendingApprovals > 0) return "WAITING_FOR_APPROVAL";
  if (i.micActive) return "LISTENING";
  if (i.speaking) return "SPEAKING";
  if (i.runningTools > 0) return "EXECUTING";
  if (i.activeRuns > 0) return "THINKING";
  if (i.lastOutcome) {
    const age = i.now - i.lastOutcome.at;
    if (i.lastOutcome.status === "succeeded" && age < SUCCESS_HOLD_MS) return "SUCCESS";
    if (i.lastOutcome.status === "failed" && age < ERROR_HOLD_MS) return "ERROR";
  }
  return "IDLE";
}

/** Milliseconds until the derived state could change on its own (outcome hold expiry), or null. */
export function nextTransitionIn(i: CoreInputs): number | null {
  if (!i.lastOutcome) return null;
  const hold = i.lastOutcome.status === "succeeded" ? SUCCESS_HOLD_MS : i.lastOutcome.status === "failed" ? ERROR_HOLD_MS : 0;
  const remaining = hold - (i.now - i.lastOutcome.at);
  return remaining > 0 ? remaining : null;
}

export const ACTIVE_RUN_STATUSES = new Set<RunSummary["status"]>(["queued", "running", "waiting_approval"]);
