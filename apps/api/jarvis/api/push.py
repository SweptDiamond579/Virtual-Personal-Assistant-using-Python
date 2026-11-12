"""Web Push subscription management."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.db.models import PushSubscription
from jarvis.db.session import get_db
from jarvis.security.audit import audit
from jarvis.security.auth import SessionContext, current_session
from jarvis.services import push

router = APIRouter(prefix="/api/push", tags=["push"])


class Keys(BaseModel):
    p256dh: str = Field(min_length=20, max_length=200)
    auth: str = Field(min_length=8, max_length=100)


class SubscriptionBody(BaseModel):
    endpoint: str = Field(min_length=20, max_length=1000)
    keys: Keys


class EndpointBody(BaseModel):
    endpoint: str = Field(min_length=20, max_length=1000)


@router.get("/public-key")
async def public_key(ctx: SessionContext = Depends(current_session)) -> dict:
    return {"public_key": push.public_key_b64url()}


@router.get("/subscriptions")
async def subscriptions(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> list:
    rows = (await db.execute(select(PushSubscription).where(PushSubscription.user_id == ctx.user.id))).scalars().all()
    return [
        {
            "id": r.id,
            "endpoint_host": r.endpoint.split("/")[2],
            "user_agent": r.user_agent,
            "created_at": r.created_at,
            "last_success_at": r.last_success_at,
        }
        for r in rows
    ]


@router.post("/subscribe")
async def subscribe(
    body: SubscriptionBody,
    request: Request,
    ctx: SessionContext = Depends(current_session),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not push.endpoint_allowed(body.endpoint):
        raise HTTPException(422, "push endpoint is not a recognised browser push service")
    existing = (
        await db.execute(select(PushSubscription).where(PushSubscription.endpoint == body.endpoint))
    ).scalar_one_or_none()
    if existing is not None and existing.user_id != ctx.user.id:
        raise HTTPException(409, "subscription belongs to another account")
    if existing is None:
        db.add(
            PushSubscription(
                user_id=ctx.user.id,
                endpoint=body.endpoint,
                p256dh=body.keys.p256dh,
                auth=body.keys.auth,
                user_agent=request.headers.get("user-agent", "")[:400],
            )
        )
    else:
        existing.p256dh, existing.auth = body.keys.p256dh, body.keys.auth
    await audit("push.subscribed", actor=ctx.actor, target=body.endpoint.split("/")[2], db=db)
    await db.commit()
    return {"subscribed": True}


@router.post("/unsubscribe")
async def unsubscribe(
    body: EndpointBody, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    res = await db.execute(
        delete(PushSubscription).where(
            PushSubscription.endpoint == body.endpoint, PushSubscription.user_id == ctx.user.id
        )
    )
    await db.commit()
    return {"removed": res.rowcount}


@router.post("/test")
async def test_push(ctx: SessionContext = Depends(current_session)) -> dict:
    delivered = await push.send_to_user(
        ctx.user.id,
        title="JARVIS test notification",
        body="Push notifications are working on this device.",
        link="/command/",
        level="info",
    )
    return {"delivered": delivered}
