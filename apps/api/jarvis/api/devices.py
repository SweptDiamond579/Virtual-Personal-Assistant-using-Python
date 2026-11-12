"""Desktop companion pairing, device management and action results."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.db.models import (
    AuthSession,
    Device,
)
from jarvis.db.session import get_db
from jarvis.realtime.hub import hub
from jarvis.security.audit import audit
from jarvis.security.auth import SessionContext, current_session
from jarvis.security.crypto import new_token, token_hash
from jarvis.security.ratelimit import limiter
from jarvis.services import devices as device_service

router = APIRouter(prefix="/api", tags=["devices"])

# --------------------------------------------------------------------------- devices


@router.post("/devices/pairing")
async def start_pairing(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> dict:
    code = new_token(6).replace("-", "").replace("_", "")[:8].upper()
    d = Device(
        user_id=ctx.user.id,
        name="Pending desktop",
        pairing_code_hash=token_hash(code),
        pairing_expires_at=datetime.now(UTC) + timedelta(minutes=10),
    )
    db.add(d)
    await audit("device.pairing_started", actor=ctx.actor, db=db)
    await db.commit()
    return {"code": code, "expires_in": 600}


class PairBody(BaseModel):
    code: str = Field(min_length=6, max_length=12)
    name: str = Field(min_length=1, max_length=120)


@router.post("/devices/pair")
async def pair(
    body: PairBody, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    if not limiter.hit(f"pair:{ctx.user.id}", limit=10, window_s=600):
        raise HTTPException(429, "too many attempts")
    d = await db.execute(
        select(Device).where(
            Device.user_id == ctx.user.id, Device.pairing_code_hash == token_hash(body.code.strip().upper())
        )
    )
    device = d.scalars().first()
    if device is None or device.pairing_expires_at is None or device.pairing_expires_at < datetime.now(UTC):
        await audit("device.pair_failed", actor=ctx.actor, outcome="denied", db=db)
        await db.commit()
        raise HTTPException(403, "invalid or expired pairing code")
    device.name, device.paired_at, device.pairing_code_hash = body.name, datetime.now(UTC), None
    device.pairing_expires_at = None
    sess = await db.get(AuthSession, ctx.session.id)
    assert sess is not None
    sess.client_kind, sess.device_id = "desktop", device.id
    await audit("device.paired", actor=ctx.actor, target=device.id, details={"name": body.name}, db=db)
    await db.commit()
    return {"device_id": device.id}


@router.get("/devices")
async def list_devices(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> list:
    online = hub.online_devices(ctx.user.id)
    rows = (
        (
            await db.execute(
                select(Device).where(
                    Device.user_id == ctx.user.id, Device.paired_at.is_not(None), Device.revoked_at.is_(None)
                )
            )
        )
        .scalars()
        .all()
    )
    return [{"id": d.id, "name": d.name, "paired_at": d.paired_at, "online": d.id in online} for d in rows]


@router.delete("/devices/{device_id}")
async def revoke_device(
    device_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    d = await db.get(Device, device_id)
    if d is None or d.user_id != ctx.user.id:
        raise HTTPException(404, "device not found")
    d.revoked_at = datetime.now(UTC)
    await db.execute(update(AuthSession).where(AuthSession.device_id == device_id).values(revoked_at=datetime.now(UTC)))
    await audit("device.revoked", actor=ctx.actor, target=device_id, db=db)
    await db.commit()
    return {"ok": True}


class ActionResult(BaseModel):
    ok: bool
    result: Any = None
    error: str | None = Field(default=None, max_length=2000)


@router.post("/devices/actions/{request_id}/result")
async def action_result(request_id: str, body: ActionResult, ctx: SessionContext = Depends(current_session)) -> dict:
    if ctx.client_kind != "desktop":
        raise HTTPException(403, "only a paired desktop session may report action results")
    accepted = device_service.submit_result(
        request_id, user_id=ctx.user.id, device_id=ctx.session.device_id, result=body.model_dump()
    )
    if not accepted:
        raise HTTPException(404, "unknown or expired action request")
    return {"ok": True}
