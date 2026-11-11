/**
 * @jarvis/protocol — the shared contract between the JARVIS API, the web/PWA
 * client, the Tauri desktop companion and the 3D core.
 *
 * The Python side mirrors these shapes in `apps/api/jarvis/schemas.py`.
 * `apps/api/tests/test_protocol_contract.py` checks that every server event
 * type declared here is emitted by the backend schema, and vice versa.
 */

/* ------------------------------------------------------------------ */
/* Core visual state machine                                           */
/* ------------------------------------------------------------------ */

export const CORE_STATES = [
  "IDLE",
  "LISTENING",
  "THINKING",
  "SPEAKING",
  "EXECUTING",
  "WAITING_FOR_APPROVAL",
  "SUCCESS",
  "ERROR",
  "OFFLINE",
] as const;
export type CoreState = (typeof CORE_STATES)[number];

/* ------------------------------------------------------------------ */
/* Domain DTOs                                                         */
/* ------------------------------------------------------------------ */

export type ClientKind = "web" | "mobile" | "desktop";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";
export type RunKind = "chat" | "command" | "workflow" | "scheduled";
export type StepKind = "model_call" | "tool_call" | "approval" | "verification" | "note";
export type StepStatus = "running" | "succeeded" | "failed" | "denied" | "cancelled" | "skipped";
export type Risk = "read_only" | "low" | "medium" | "high" | "critical";
export type PolicyDecision = "auto" | "ask" | "deny";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
}

export interface RunSummary {
  id: string;
  kind: RunKind;
  status: RunStatus;
  title: string;
  conversation_id: string | null;
  provider: string | null;
  model: string | null;
  error: string | null;
  usage: Usage;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface RunStep {
  id: string;
  run_id: string;
  seq: number;
  kind: StepKind;
  name: string;
  status: StepStatus;
  summary: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  run_id: string | null;
  created_at: string;
}

export interface Approval {
  id: string;
  run_id: string | null;
  tool: string;
  tool_title: string;
  risk: Risk;
  arguments: Record<string, unknown>;
  reason: string;
  status: ApprovalStatus;
  requires_client_kind: ClientKind | null;
  requested_at: string;
  expires_at: string;
  decided_at: string | null;
}

export interface MemoryItem {
  id: string;
  kind: "preference" | "fact" | "project" | "note";
  content: string;
  status: "proposed" | "active" | "archived";
  confidence: number;
  source: string;
  provenance: Record<string, unknown>;
  share_with_model: boolean;
  conflicts_with: string[];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export interface NotificationItem {
  id: string;
  level: "info" | "success" | "warning" | "error" | "approval";
  title: string;
  body: string;
  link: string | null;
  created_at: string;
  read_at: string | null;
}

export interface JobSummary {
  id: string;
  name: string;
  kind: "reminder" | "workflow" | "agent_task" | "health_check";
  schedule: string | null;
  run_at: string | null;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
}

export interface ServiceHealth {
  name: string;
  status: "ok" | "degraded" | "down" | "not_configured";
  detail: string;
  latency_ms: number | null;
}

export interface SystemStatus {
  version: string;
  server_time: string;
  services: ServiceHealth[];
  ai: { provider: string | null; model: string | null; configured: boolean };
  desktop_online: boolean;
  emergency_stop: boolean;
}

/* ------------------------------------------------------------------ */
/* Desktop companion contract                                          */
/* ------------------------------------------------------------------ */

/** Every action the desktop companion understands. Validated again in Rust. */
export type DesktopAction =
  | { action: "status" }
  | { action: "launch_app"; app_id: string }
  | { action: "list_dir"; root_id: string; path: string }
  | { action: "read_text_file"; root_id: string; path: string }
  | { action: "write_text_file"; root_id: string; path: string; content: string; overwrite: boolean }
  | { action: "organize_by_type"; root_id: string; path: string; dry_run: boolean };

export interface DeviceActionRequest {
  request_id: string;
  action: DesktopAction;
  expires_at: string;
}

export interface DeviceActionResult {
  request_id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Realtime events (server -> client over WebSocket)                   */
/* ------------------------------------------------------------------ */

interface Envelope<T extends string, D> {
  type: T;
  seq: number;
  ts: string;
  run_id: string | null;
  conversation_id: string | null;
  data: D;
}

export type ServerEvent =
  | Envelope<"hello", { session_id: string; client_kind: ClientKind; version: string }>
  | Envelope<"run.started", { run: RunSummary }>
  | Envelope<"run.updated", { run: RunSummary }>
  | Envelope<"message.created", { message: ChatMessage }>
  | Envelope<"assistant.delta", { message_id: string; text: string }>
  | Envelope<"assistant.completed", { message: ChatMessage }>
  | Envelope<"tool.started", { step: RunStep }>
  | Envelope<"tool.finished", { step: RunStep }>
  | Envelope<"approval.requested", { approval: Approval }>
  | Envelope<"approval.resolved", { approval: Approval }>
  | Envelope<"memory.used", { memory_ids: string[] }>
  | Envelope<"memory.proposed", { memory: MemoryItem }>
  | Envelope<"notification.created", { notification: NotificationItem }>
  | Envelope<"job.updated", { job: JobSummary }>
  | Envelope<"system.status", { status: SystemStatus }>
  | Envelope<"device.action.request", { request: DeviceActionRequest }>;

export type ServerEventType = ServerEvent["type"];
export type EventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;

export const SERVER_EVENT_TYPES = [
  "hello",
  "run.started",
  "run.updated",
  "message.created",
  "assistant.delta",
  "assistant.completed",
  "tool.started",
  "tool.finished",
  "approval.requested",
  "approval.resolved",
  "memory.used",
  "memory.proposed",
  "notification.created",
  "job.updated",
  "system.status",
  "device.action.request",
] as const satisfies readonly ServerEventType[];

/** Client -> server messages over the WebSocket. Everything else uses REST. */
export type ClientMessage = { type: "ping" } | { type: "subscribe"; conversation_id: string | null };
