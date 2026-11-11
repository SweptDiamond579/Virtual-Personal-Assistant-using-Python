import type { CoreState } from "@jarvis/protocol";

/**
 * Visual parameters for each AI core state. Shared by the WebGL core, the 2D
 * fallback core and the compact status indicator so every representation of
 * JARVIS agrees on colour and energy for a given state.
 */
export interface CoreVisual {
  /** Primary emissive colour of the nucleus and rings. */
  primary: string;
  /** Secondary light used for filaments and particle highlights. */
  secondary: string;
  /** 0..1 — overall energy: rotation speed, particle agitation, bloom. */
  energy: number;
  /** Multiplier for ring/orbital rotation speed. */
  spin: number;
  /** Whether neural connections should show travelling pulses. */
  pulses: boolean;
  /** Human-readable label for accessibility and status UI. */
  label: string;
  description: string;
}

export const CORE_VISUALS: Record<CoreState, CoreVisual> = {
  IDLE: {
    primary: "#2ee6ff",
    secondary: "#8b7bff",
    energy: 0.25,
    spin: 0.35,
    pulses: false,
    label: "Idle",
    description: "Standing by.",
  },
  LISTENING: {
    primary: "#7df9ff",
    secondary: "#c4f1ff",
    energy: 0.55,
    spin: 0.5,
    pulses: false,
    label: "Listening",
    description: "Microphone is live and capturing your voice.",
  },
  THINKING: {
    primary: "#8b7bff",
    secondary: "#2ee6ff",
    energy: 0.8,
    spin: 1.6,
    pulses: true,
    label: "Thinking",
    description: "The model is reasoning about your request.",
  },
  SPEAKING: {
    primary: "#5cf2ff",
    secondary: "#c4f1ff",
    energy: 0.6,
    spin: 0.7,
    pulses: false,
    label: "Speaking",
    description: "Playing a spoken response.",
  },
  EXECUTING: {
    primary: "#3fb8ff",
    secondary: "#2ee6ff",
    energy: 0.9,
    spin: 1.2,
    pulses: true,
    label: "Executing",
    description: "Running an authorised tool.",
  },
  WAITING_FOR_APPROVAL: {
    primary: "#ffb547",
    secondary: "#ffd89a",
    energy: 0.45,
    spin: 0.2,
    pulses: false,
    label: "Awaiting approval",
    description: "An action is waiting for your authorisation.",
  },
  SUCCESS: {
    primary: "#3dffa8",
    secondary: "#2ee6ff",
    energy: 0.65,
    spin: 0.6,
    pulses: false,
    label: "Complete",
    description: "The last task completed successfully.",
  },
  ERROR: {
    primary: "#ff4d6d",
    secondary: "#ff9aac",
    energy: 0.5,
    spin: 0.25,
    pulses: false,
    label: "Error",
    description: "The last task failed. See Mission Control for details.",
  },
  OFFLINE: {
    primary: "#4a5a70",
    secondary: "#2a3646",
    energy: 0.05,
    spin: 0.08,
    pulses: false,
    label: "Offline",
    description: "Disconnected from the JARVIS server.",
  },
};

export type GraphicsQuality = "low" | "medium" | "high" | "ultra";
export type RenderMode = "3d" | "2d";
