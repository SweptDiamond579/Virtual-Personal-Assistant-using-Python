import type { CoreNodeId } from "../types";

export interface CoreNodeDef {
  id: CoreNodeId;
  label: string;
  description: string;
}

/** The six satellite systems, in orbital order. */
export const CORE_NODES: readonly CoreNodeDef[] = [
  { id: "mission", label: "Mission", description: "Mission control: runs, approvals and history" },
  { id: "intelligence", label: "Intelligence", description: "Models, reasoning and providers" },
  { id: "memory", label: "Memory", description: "Long-term memory and knowledge" },
  { id: "automation", label: "Automation", description: "Workflows and scheduled tasks" },
  { id: "integrations", label: "Integrations", description: "Connected apps and tools" },
  { id: "security", label: "Security", description: "Policies, permissions and audit" },
];

/** Satellite orbit: radius, inclination about X (rad) and a yaw about Y (rad). */
export const SATELLITE_ORBIT = { radius: 3.45, inclination: 0.3, yaw: -0.2 } as const;

/**
 * World-space position of satellite `index` of `count` at orbital phase
 * `phase` (radians). Writes into `out` to avoid allocation.
 */
export function satellitePosition(
  index: number,
  count: number,
  phase: number,
  out: [number, number, number] = [0, 0, 0],
  orbit: { radius: number; inclination: number; yaw: number } = SATELLITE_ORBIT,
): [number, number, number] {
  const a = phase + (index / count) * Math.PI * 2;
  // circle in XZ plane
  const x0 = Math.cos(a) * orbit.radius;
  const z0 = Math.sin(a) * orbit.radius;
  // incline about X
  const ci = Math.cos(orbit.inclination);
  const si = Math.sin(orbit.inclination);
  const y1 = -z0 * si;
  const z1 = z0 * ci;
  // yaw about Y
  const cy = Math.cos(orbit.yaw);
  const sy = Math.sin(orbit.yaw);
  out[0] = x0 * cy + z1 * sy;
  out[1] = y1;
  out[2] = -x0 * sy + z1 * cy;
  return out;
}

export function nodeIndex(id: CoreNodeId): number {
  return CORE_NODES.findIndex((n) => n.id === id);
}
