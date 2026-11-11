"""Provider-neutral model interface.

Conversation history is stored as provider-neutral content blocks:
  {"type": "text", "text": ...}
  {"type": "tool_call", "id": ..., "name": ..., "input": {...}}
  {"type": "tool_result", "tool_call_id": ..., "content": "...", "is_error": bool}
  {"type": "opaque", "provider": "anthropic", "block": {...}}   # e.g. thinking blocks,
      replayed verbatim to the provider that produced them and ignored by others.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

Block = dict[str, Any]


@dataclass
class ProviderMessage:
    role: Literal["user", "assistant"]
    blocks: list[Block]


@dataclass
class ToolSchema:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass
class TurnUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0


@dataclass
class TextDelta:
    text: str


@dataclass
class TurnComplete:
    blocks: list[Block]
    tool_calls: list[ToolCall]
    stop_reason: str
    usage: TurnUsage
    model: str
    notes: list[str] = field(default_factory=list)


ProviderEvent = TextDelta | TurnComplete


ErrorKind = Literal[
    "not_configured",
    "auth",
    "permission",
    "rate_limit",
    "overloaded",
    "bad_request",
    "connection",
    "timeout",
    "refusal",
    "truncated",
    "invalid_tool_input",
    "unknown",
]


class ProviderError(Exception):
    def __init__(self, kind: ErrorKind, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.kind = kind
        self.retryable = retryable


@dataclass
class TurnRequest:
    system: str
    messages: list[ProviderMessage]
    tools: list[ToolSchema]
    model: str
    max_tokens: int
    effort: str | None = None


class ModelProvider(Protocol):
    name: str

    def default_model(self, *, fast: bool = False) -> str: ...

    def stream_turn(self, req: TurnRequest) -> AsyncIterator[ProviderEvent]: ...
