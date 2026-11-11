import { describe, expect, it } from "vitest";
import { deriveCoreState, nextTransitionIn, type CoreInputs } from "./core-machine";

const base: CoreInputs = {
  connected: true,
  micActive: false,
  speaking: false,
  pendingApprovals: 0,
  runningTools: 0,
  activeRuns: 0,
  lastOutcome: null,
  now: 10_000,
};

describe("deriveCoreState", () => {
  it("is idle with no activity", () => {
    expect(deriveCoreState(base)).toBe("IDLE");
  });

  it("is offline when disconnected, overriding everything", () => {
    expect(deriveCoreState({ ...base, connected: false, micActive: true, pendingApprovals: 2 })).toBe("OFFLINE");
  });

  it("prioritises approvals over listening and execution", () => {
    expect(deriveCoreState({ ...base, pendingApprovals: 1, micActive: true, runningTools: 1 })).toBe(
      "WAITING_FOR_APPROVAL",
    );
  });

  it("maps real activity signals", () => {
    expect(deriveCoreState({ ...base, micActive: true })).toBe("LISTENING");
    expect(deriveCoreState({ ...base, speaking: true, activeRuns: 1 })).toBe("SPEAKING");
    expect(deriveCoreState({ ...base, runningTools: 1, activeRuns: 1 })).toBe("EXECUTING");
    expect(deriveCoreState({ ...base, activeRuns: 1 })).toBe("THINKING");
  });

  it("holds success and error briefly, then returns to idle", () => {
    const ok = { ...base, lastOutcome: { status: "succeeded" as const, at: 9_000 } };
    expect(deriveCoreState(ok)).toBe("SUCCESS");
    expect(nextTransitionIn(ok)).toBe(800);
    expect(deriveCoreState({ ...ok, now: 11_000 })).toBe("IDLE");
    const bad = { ...base, lastOutcome: { status: "failed" as const, at: 8_000 } };
    expect(deriveCoreState(bad)).toBe("ERROR");
    expect(deriveCoreState({ ...bad, now: 13_000 })).toBe("IDLE");
  });

  it("does not show success for cancelled runs", () => {
    expect(deriveCoreState({ ...base, lastOutcome: { status: "cancelled", at: 9_900 } })).toBe("IDLE");
  });
});

import { mergeMessages } from "./chat";

describe("mergeMessages", () => {
  it("unions by id and orders by creation time", () => {
    const m = (id: string, t: string) =>
      ({ id, conversation_id: "c", role: "user", content: id, run_id: null, created_at: t }) as const;
    const out = mergeMessages([m("b", "2026-01-01T00:00:02Z")], [m("a", "2026-01-01T00:00:01Z"), m("b", "2026-01-01T00:00:02Z")]);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });
});
