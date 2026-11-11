from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.db.models import AuditLog
from jarvis.db.session import db_session
from jarvis.logging import get_logger

log = get_logger("audit")

_REDACT_KEYS = {"password", "token", "api_key", "secret", "content", "body", "authorization"}


def redact(details: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in details.items():
        if any(s in k.lower() for s in _REDACT_KEYS):
            out[k] = f"<redacted:{len(str(v))} chars>"
        elif isinstance(v, dict):
            out[k] = redact(v)
        elif isinstance(v, str) and len(v) > 500:
            out[k] = v[:500] + "…"
        else:
            out[k] = v
    return out


async def audit(
    action: str,
    *,
    actor: str,
    target: str = "",
    outcome: str = "ok",
    ip: str = "",
    details: dict[str, Any] | None = None,
    db: AsyncSession | None = None,
) -> None:
    """Append an audit record. Uses its own transaction unless a session is passed."""
    entry = AuditLog(
        actor=actor, action=action, target=target[:200], outcome=outcome, ip=ip, details=redact(details or {})
    )
    log.info("audit", action=action, actor=actor, target=target, outcome=outcome)
    if db is not None:
        db.add(entry)
        return
    async with db_session() as s:
        s.add(entry)
        await s.commit()
