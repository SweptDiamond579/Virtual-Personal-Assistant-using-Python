"""Permission policy engine.

Order of evaluation (first decisive rule wins):
 1. Emergency stop          -> deny every side-effecting tool.
 2. Missing requirement     -> deny (integration not connected, desktop offline, …).
 3. User override "deny"    -> deny.
 4. Critical risk           -> ask, always.
 5. User override           -> "ask" honoured; "auto" honoured only up to medium risk.
 6. Tool default policy.
 7. Taint escalation        -> if untrusted content is in the run's context, any
                               side-effecting tool that would run automatically needs approval.
 8. Domain policy (web)     -> network tools to domains outside the allow-list need approval.

Agents cannot change policy: overrides live in user settings that only an
authenticated, CSRF-protected user request can modify (never a tool).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from jarvis.tools.base import RISK_ORDER, ToolSpec

DEFAULT_WEB_ALLOWLIST = [
    "en.wikipedia.org",
    "api.github.com",
    "github.com",
    "docs.python.org",
    "developer.mozilla.org",
    "api.open-meteo.com",
    "geocoding-api.open-meteo.com",
]


@dataclass
class PolicyInput:
    emergency_stop: bool
    overrides: dict[str, str]
    tainted: bool
    unmet_requirements: list[str]
    web_allowlist: list[str]


@dataclass
class Decision:
    decision: str  # auto | ask | deny
    reason: str
    requires_client_kind: str | None = None


def domain_allowed(url: str, allowlist: list[str]) -> bool:
    host = (urlsplit(url).hostname or "").lower().strip(".")
    return any(host == d or host.endswith("." + d) for d in (a.lower().strip(".") for a in allowlist))


def decide(spec: ToolSpec, args: dict[str, Any], p: PolicyInput) -> Decision:
    if p.emergency_stop and (spec.side_effects or spec.category in ("desktop", "browser")):
        return Decision("deny", "Emergency stop is active.")
    if p.unmet_requirements:
        return Decision("deny", "Unavailable: " + "; ".join(p.unmet_requirements))

    override = p.overrides.get(spec.name)
    if override == "deny":
        return Decision("deny", "Disabled in your tool permissions.")

    kind = spec.approval_client_kind
    if spec.risk == "critical":
        return Decision("ask", "Critical-risk action always requires approval.", kind)

    if override == "ask":
        decision, reason = "ask", "Your tool permissions require approval."
    elif override == "auto" and RISK_ORDER[spec.risk] <= RISK_ORDER["medium"]:
        decision, reason = "auto", "Allowed automatically by your tool permissions."
    else:
        decision = spec.default_policy
        reason = {
            "auto": "Allowed by default policy.",
            "ask": f"{spec.risk.replace('_', ' ').capitalize()}-risk action requires approval.",
            "deny": "Denied by default policy.",
        }[decision]

    if decision == "auto" and p.tainted and spec.side_effects:
        decision, reason = "ask", "Untrusted external content is in context; side-effecting actions need approval."

    url = args.get("url")
    if decision == "auto" and spec.category in ("web", "browser") and isinstance(url, str):
        if not domain_allowed(url, p.web_allowlist):
            decision, reason = "ask", f"Domain {urlsplit(url).hostname} is not on your web allow-list."

    return Decision(decision, reason, kind if decision == "ask" else None)
