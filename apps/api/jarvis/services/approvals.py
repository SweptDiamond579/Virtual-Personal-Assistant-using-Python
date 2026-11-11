"""Approval gates for consequential actions.

An approval binds to the exact tool arguments (hash), expires, can require a
specific client kind (e.g. high-risk desktop actions must be approved from the
desktop itself), and is single-use.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, update

from jarvis.config import get_settings
from jarvis.db.models import Approval
from jarvis.db.session import db_session
from jarvis.realtime.hub import hub
from jarvis.schemas import ApprovalDTO
from jarvis.security.audit import audit
from jarvis.security.crypto import canonical_hash
from jarvis.services.notifications import notify
from jarvis.tools.base import registry

_waiters: dict[str, asyncio.Event] = {}


class ApprovalError(Exception):
    pass


def to_dto(a: Approval) -> ApprovalDTO:
    dto = ApprovalDTO.model_validate(a)
    spec = registry.get(a.tool)
    dto.tool_title = spec.title if spec else a.tool
    return dto


async def request_approval(
    *,
    user_id: str,
    run_id: str | None,
    step_id: str | None,
    tool: str,
    risk: str,
    arguments: dict[str, Any],
    reason: str,
    requires_client_kind: str | None,
    conversation_id: str | None = None,
) -> Approval:
    timeout = get_settings().jarvis_approval_timeout_s
    async with db_session() as db:
        a = Approval(
            user_id=user_id,
            run_id=run_id,
            step_id=step_id,
            tool=tool,
            risk=risk,
            arguments=arguments,
            arguments_hash=canonical_hash({"tool": tool, "args": arguments}),
            reason=reason,
            requires_client_kind=requires_client_kind,
            expires_at=datetime.now(UTC) + timedelta(seconds=timeout),
        )
        db.add(a)
        await db.commit()
        await db.refresh(a)
    _waiters[a.id] = asyncio.Event()
    hub.publish(user_id, "approval.requested", {"approval": to_dto(a)}, run_id=run_id, conversation_id=conversation_id)
    spec = registry.get(tool)
    await notify(
        user_id,
        f"Approval needed: {spec.title if spec else tool}",
        reason,
        level="approval",
        link=f"/security?approval={a.id}",
    )
    return a


async def wait_for_decision(approval_id: str, timeout_s: float | None = None) -> str:
    """Block until the approval is decided or expires. Returns the final status."""
    ev = _waiters.setdefault(approval_id, asyncio.Event())
    timeout = timeout_s if timeout_s is not None else get_settings().jarvis_approval_timeout_s
    try:
        await asyncio.wait_for(ev.wait(), timeout=timeout)
    except TimeoutError:
        await _finalize(approval_id, "expired", None)
    finally:
        _waiters.pop(approval_id, None)
    async with db_session() as db:
        a = await db.get(Approval, approval_id)
        return a.status if a else "expired"


async def _finalize(approval_id: str, status: str, session_id: str | None) -> Approval | None:
    async with db_session() as db:
        result = await db.execute(
            update(Approval)
            .where(Approval.id == approval_id, Approval.status == "pending")
            .values(status=status, decided_at=datetime.now(UTC), decided_by_session=session_id)
            .returning(Approval)
        )
        a = result.scalar_one_or_none()
        await db.commit()
    if a is not None:
        hub.publish(a.user_id, "approval.resolved", {"approval": to_dto(a)}, run_id=a.run_id)
        ev = _waiters.get(approval_id)
        if ev:
            ev.set()
    return a


async def decide(
    approval_id: str, *, user_id: str, approve: bool, session_id: str, client_kind: str, ip: str = ""
) -> Approval:
    async with db_session() as db:
        a = await db.get(Approval, approval_id)
        if a is None or a.user_id != user_id:
            raise ApprovalError("approval not found")
        if a.status != "pending":
            raise ApprovalError(f"approval is already {a.status}")
        if a.expires_at <= datetime.now(UTC):
            await _finalize(approval_id, "expired", None)
            raise ApprovalError("approval has expired")
        if approve and a.requires_client_kind and client_kind != a.requires_client_kind:
            await audit(
                "approval.rejected_client_kind",
                actor=f"session:{session_id}",
                target=approval_id,
                outcome="denied",
                ip=ip,
                details={"required": a.requires_client_kind, "got": client_kind},
            )
            raise ApprovalError(f"this action can only be approved from a {a.requires_client_kind} session")
    final = await _finalize(approval_id, "approved" if approve else "denied", session_id)
    if final is None:
        raise ApprovalError("approval was decided concurrently")
    await audit(
        "approval.decided",
        actor=f"session:{session_id}",
        target=approval_id,
        ip=ip,
        details={"tool": final.tool, "status": final.status},
    )
    return final


async def cancel_for_run(run_id: str) -> None:
    async with db_session() as db:
        ids = (
            (await db.execute(select(Approval.id).where(Approval.run_id == run_id, Approval.status == "pending")))
            .scalars()
            .all()
        )
    for approval_id in ids:
        await _finalize(approval_id, "cancelled", None)


def verify_binding(a: Approval, tool: str, arguments: dict[str, Any]) -> bool:
    return a.status == "approved" and a.arguments_hash == canonical_hash({"tool": tool, "args": arguments})
