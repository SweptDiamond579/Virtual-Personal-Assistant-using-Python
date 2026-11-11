import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { CORE_STATES } from "@jarvis/protocol";
import { CORE_VISUALS } from "@/lib/core-visuals";
import { AICore, CoreMiniIndicator, detectWebGL, FallbackCore2D } from "./index";
import { resetWebGLDetection } from "./detect-webgl";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetWebGLDetection();
});

function levelRef(v = 0) {
  const r = createRef<number>() as { current: number };
  r.current = v;
  return r;
}

describe("detectWebGL", () => {
  it("returns false when no WebGL2 context can be created (jsdom)", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(detectWebGL()).toBe(false);
  });

  it("returns true when a WebGL2 context is available", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      getExtension: () => null,
    } as unknown as RenderingContext);
    expect(detectWebGL()).toBe(true);
  });
});

describe("CoreMiniIndicator", () => {
  it("renders an accessible glyph for every state with the state colour", () => {
    for (const s of CORE_STATES) {
      const { container, unmount } = render(<CoreMiniIndicator state={s} size={16} />);
      const el = screen.getByRole("img");
      expect(el.getAttribute("aria-label")).toBe(`Core: ${CORE_VISUALS[s].label}`);
      expect(el.dataset.state).toBe(s);
      expect(el.style.getPropertyValue("--c1")).toBe(CORE_VISUALS[s].primary);
      expect(container.querySelector("svg")?.getAttribute("width")).toBe("16");
      unmount();
    }
  });
});

describe("FallbackCore2D", () => {
  it("applies state colours and writes the audio level to a CSS variable without re-rendering", () => {
    let raf: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      raf = cb;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const ref = levelRef(0);
    const { container } = render(<FallbackCore2D state="LISTENING" levelRef={ref} reducedMotion={false} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.dataset.state).toBe("LISTENING");
    expect(root.style.getPropertyValue("--c1")).toBe(CORE_VISUALS.LISTENING.primary);
    ref.current = 1;
    for (let i = 0; i < 20; i++) {
      const cb = raf as FrameRequestCallback | null;
      if (cb) cb(i * 16);
    }
    expect(Number.parseFloat(root.style.getPropertyValue("--lvl"))).toBeGreaterThan(0.9);
  });

  it("marks reduced motion", () => {
    const { container } = render(<FallbackCore2D state="IDLE" levelRef={levelRef()} reducedMotion />);
    expect((container.firstElementChild as HTMLElement).dataset.reduced).toBe("true");
  });
});

describe("AICore (no WebGL)", () => {
  it("falls back to 2D, labels the state and exposes accessible node buttons", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const onNodeSelect = vi.fn();
    render(
      <AICore
        state="WAITING_FOR_APPROVAL"
        levelRef={levelRef()}
        quality="high"
        mode="3d"
        reducedMotion={false}
        active
        onNodeSelect={onNodeSelect}
      />,
    );
    const img = screen.getByRole("img", { name: /Awaiting approval/ });
    expect(img.getAttribute("aria-label")).toContain(CORE_VISUALS.WAITING_FOR_APPROVAL.description);
    expect(document.querySelector("canvas")).toBeNull();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Mission",
      "Intelligence",
      "Memory",
      "Automation",
      "Integrations",
      "Security",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Memory" }));
    expect(onNodeSelect).toHaveBeenCalledWith("memory");
    const group = screen.getByRole("group");
    expect(group.tabIndex).toBe(0);
  });

  it("uses the 2D core when mode is 2d and shows a stats placeholder", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      getExtension: () => null,
    } as unknown as RenderingContext);
    render(
      <AICore state="IDLE" levelRef={levelRef()} quality="low" mode="2d" reducedMotion active={false} showStats />,
    );
    expect(document.querySelector("canvas")).toBeNull();
    expect(screen.getByText(/2D fallback/)).toBeTruthy();
  });

  it("updates the accessible label when the state changes", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const ref = levelRef();
    const { rerender } = render(
      <AICore state="IDLE" levelRef={ref} quality="medium" mode="3d" reducedMotion={false} active />,
    );
    act(() => {
      rerender(<AICore state="ERROR" levelRef={ref} quality="medium" mode="3d" reducedMotion={false} active />);
    });
    expect(screen.getByRole("img", { name: /Error/ })).toBeTruthy();
  });
});
