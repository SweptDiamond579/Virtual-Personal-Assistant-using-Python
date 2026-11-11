"""API DTOs. These mirror packages/protocol/src/index.ts (checked by tests/test_protocol_contract.py)."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from jarvis.db import models as m

ClientKind = Literal["web", "mobile", "desktop"]
Risk = Literal["read_only", "low", "medium", "high", "critical"]

SERVER_EVENT_TYPES: tuple[str, ...] = (
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
)


class DTO(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class UsageDTO(DTO):
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cost_usd: float = 0.0


class RunSummary(DTO):
    id: str
    kind: str
    status: str
    title: str
    conversation_id: str | None
    provider: str | None
    model: str | None
    error: str | None
    usage: UsageDTO
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

    @classmethod
    def of(cls, run: m.Run) -> RunSummary:
        return cls(
            id=run.id,
            kind=run.kind,
            status=run.status,
            title=run.title,
            conversation_id=run.conversation_id,
            provider=run.provider,
            model=run.model,
            error=run.error,
            usage=UsageDTO(
                input_tokens=run.input_tokens,
                output_tokens=run.output_tokens,
                cache_read_tokens=run.cache_read_tokens,
                cost_usd=round(run.cost_usd, 6),
            ),
            created_at=run.created_at,
            started_at=run.started_at,
            finished_at=run.finished_at,
        )


class RunStepDTO(DTO):
    id: str
    run_id: str
    seq: int
    kind: str
    name: str
    status: str
    summary: str | None
    input: Any
    output: Any
    error: str | None
    started_at: datetime
    finished_at: datetime | None
    duration_ms: int | None


class ChatMessageDTO(DTO):
    id: str
    conversation_id: str
    role: Literal["user", "assistant"]
    content: str
    run_id: str | None
    created_at: datetime


class ApprovalDTO(DTO):
    id: str
    run_id: str | None
    tool: str
    tool_title: str = ""
    risk: str
    arguments: dict[str, Any]
    reason: str
    status: str
    requires_client_kind: str | None
    requested_at: datetime
    expires_at: datetime
    decided_at: datetime | None


class MemoryDTO(DTO):
    id: str
    kind: str
    content: str
    status: str
    confidence: float
    source: str
    provenance: dict[str, Any]
    share_with_model: bool
    conflicts_with: list[str]
    created_at: datetime
    updated_at: datetime
    last_used_at: datetime | None
    expires_at: datetime | None


class NotificationDTO(DTO):
    id: str
    level: str
    title: str
    body: str
    link: str | None
    created_at: datetime
    read_at: datetime | None


class JobDTO(DTO):
    id: str
    name: str
    kind: str
    schedule: str | None
    run_at: datetime | None
    enabled: bool
    next_run_at: datetime | None
    last_run_at: datetime | None
    last_status: str | None
    payload: dict[str, Any] = Field(default_factory=dict)


class ServiceHealth(BaseModel):
    name: str
    status: Literal["ok", "degraded", "down", "not_configured"]
    detail: str
    latency_ms: float | None = None


class AIStatus(BaseModel):
    provider: str | None
    model: str | None
    configured: bool


class SystemStatus(BaseModel):
    version: str
    server_time: datetime
    services: list[ServiceHealth]
    ai: AIStatus
    desktop_online: bool
    emergency_stop: bool
