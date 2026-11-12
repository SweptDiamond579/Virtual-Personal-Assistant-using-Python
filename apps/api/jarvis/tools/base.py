"""Tool framework.

A tool declares what it does (input model), how dangerous it is (risk, side
effects), what it needs (requirements) and how it is allowed to run by default
(default policy). The policy engine — not the model — decides whether a call
runs automatically, needs approval, or is denied.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

Risk = Literal["read_only", "low", "medium", "high", "critical"]
Policy = Literal["auto", "ask", "deny"]
RISK_ORDER: dict[str, int] = {"read_only": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}


class ToolInput(BaseModel):
    """Base for tool inputs: unknown fields are rejected."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


@dataclass
class ToolContext:
    user_id: str
    run_id: str | None
    origin: str = "user"  # user | scheduler | workflow | command | agent:<name>
    client_kind: str | None = None
    session_id: str | None = None


@dataclass
class ToolResult:
    ok: bool
    summary: str
    data: dict[str, Any] = field(default_factory=dict)
    # Outcome verification: True = independently confirmed, False = check failed, None = not applicable.
    verified: bool | None = None
    verification: str | None = None
    untrusted: bool = False  # data contains external content (web pages, emails, …)

    @classmethod
    def fail(cls, summary: str, **data: Any) -> ToolResult:
        return cls(ok=False, summary=summary, data=data)


Handler = Callable[[Any, ToolContext], Awaitable[ToolResult]]


@dataclass
class ToolSpec:
    name: str
    title: str
    description: str
    input_model: type[ToolInput]
    handler: Handler
    category: str
    risk: Risk
    side_effects: bool
    default_policy: Policy
    timeout_s: float = 30.0
    requires: frozenset[str] = frozenset()
    # Untrusted output taints the run: later side-effecting calls escalate to approval.
    untrusted_output: bool = False
    # Approvals for this tool must come from a session of this client kind (e.g. "desktop").
    approval_client_kind: str | None = None
    # Safe to retry automatically on transient failure (idempotent, read-only).
    retryable: bool = False

    def input_schema(self) -> dict[str, Any]:
        schema = self.input_model.model_json_schema()
        schema.pop("title", None)
        schema["additionalProperties"] = False
        return schema

    def describe(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "title": self.title,
            "description": self.description,
            "category": self.category,
            "risk": self.risk,
            "side_effects": self.side_effects,
            "default_policy": self.default_policy,
            "requires": sorted(self.requires),
            "untrusted_output": self.untrusted_output,
            "approval_client_kind": self.approval_client_kind,
            "timeout_s": self.timeout_s,
            "input_schema": self.input_schema(),
        }


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> ToolSpec:
        if spec.name in self._tools:
            raise ValueError(f"duplicate tool {spec.name}")
        if spec.risk in ("high", "critical") and spec.default_policy == "auto":
            raise ValueError(f"{spec.name}: high-risk tools cannot default to auto")
        self._tools[spec.name] = spec
        return spec

    def get(self, name: str) -> ToolSpec | None:
        return self._tools.get(name)

    def all(self) -> list[ToolSpec]:
        return sorted(self._tools.values(), key=lambda t: t.name)


registry = ToolRegistry()


def tool(
    *,
    name: str,
    title: str,
    description: str,
    input_model: type[ToolInput],
    category: str,
    risk: Risk,
    side_effects: bool,
    default_policy: Policy,
    timeout_s: float = 30.0,
    requires: set[str] | None = None,
    untrusted_output: bool = False,
    approval_client_kind: str | None = None,
    retryable: bool = False,
) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        registry.register(
            ToolSpec(
                name=name,
                title=title,
                description=description,
                input_model=input_model,
                handler=fn,
                category=category,
                risk=risk,
                side_effects=side_effects,
                default_policy=default_policy,
                timeout_s=timeout_s,
                requires=frozenset(requires or ()),
                untrusted_output=untrusted_output,
                approval_client_kind=approval_client_kind,
                retryable=retryable,
            )
        )
        return fn

    return deco
