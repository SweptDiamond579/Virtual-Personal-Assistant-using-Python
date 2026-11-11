from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.config import get_settings
from jarvis.db.models import AuthSession, User
from jarvis.db.session import get_db
from jarvis.security.audit import audit
from jarvis.security.auth import (
    SESSION_COOKIE,
    SessionContext,
    clear_session_cookies,
    client_ip,
    create_session,
    current_session,
    load_session,
    set_session_cookies,
)
from jarvis.security.crypto import burn_password_check, constant_time_eq, hash_password, verify_password
from jarvis.security.ratelimit import limiter

router = APIRouter(prefix="/api/auth", tags=["auth"])


class SetupBody(BaseModel):
    setup_token: str = Field(min_length=8, max_length=200)
    username: str = Field(min_length=3, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")
    display_name: str = Field(default="", max_length=120)
    password: str = Field(min_length=12, max_length=256)


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    client_kind: Literal["web", "mobile"] = "web"


def _user_dto(u: User) -> dict[str, str]:
    return {"id": u.id, "username": u.username, "display_name": u.display_name or u.username}


@router.get("/state")
async def auth_state(request: Request, db: AsyncSession = Depends(get_db)) -> dict:
    users = (await db.execute(select(func.count(User.id)))).scalar() or 0
    ctx = await load_session(db, request.cookies.get(SESSION_COOKIE))
    return {
        "setup_required": users == 0,
        "authenticated": ctx is not None,
        "user": _user_dto(ctx.user) if ctx else None,
        "session": {
            "id": ctx.session.id,
            "client_kind": ctx.session.client_kind,
            "csrf_token": ctx.session.csrf_token,
            "device_id": ctx.session.device_id,
        }
        if ctx
        else None,
    }


@router.post("/setup")
async def setup(body: SetupBody, request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> dict:
    ip = client_ip(request)
    if not limiter.hit(f"setup:{ip}", limit=5, window_s=300):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "too many attempts")
    expected = get_settings().jarvis_setup_token
    if expected is None or not expected.get_secret_value():
        raise HTTPException(status.HTTP_403_FORBIDDEN, "JARVIS_SETUP_TOKEN is not configured on the server")
    if not constant_time_eq(body.setup_token, expected.get_secret_value()):
        await audit("auth.setup_failed", actor="anonymous", outcome="denied", ip=ip)
        raise HTTPException(status.HTTP_403_FORBIDDEN, "invalid setup token")
    if ((await db.execute(select(func.count(User.id)))).scalar() or 0) > 0:
        raise HTTPException(status.HTTP_409_CONFLICT, "owner account already exists")
    user = User(username=body.username, display_name=body.display_name, password_hash=hash_password(body.password))
    db.add(user)
    await db.flush()
    raw, sess = await create_session(
        db, user, client_kind="web", user_agent=request.headers.get("user-agent", ""), ip=ip
    )
    await audit("auth.setup", actor=f"user:{user.id}", ip=ip, db=db)
    await db.commit()
    set_session_cookies(response, raw, sess.csrf_token)
    return {"user": _user_dto(user), "csrf_token": sess.csrf_token}


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> dict:
    ip = client_ip(request)
    if not limiter.hit(f"login:ip:{ip}", limit=10, window_s=300) or not limiter.hit(
        f"login:user:{body.username.lower()}", limit=10, window_s=300
    ):
        await audit(
            "auth.login_rate_limited", actor="anonymous", outcome="denied", ip=ip, details={"username": body.username}
        )
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "too many login attempts; try again later")
    user = (await db.execute(select(User).where(User.username == body.username))).scalar_one_or_none()
    if user is None:
        burn_password_check(body.password)
        ok = False
    else:
        ok = verify_password(user.password_hash, body.password)
    if not ok or user is None:
        await audit(
            "auth.login_failed", actor="anonymous", outcome="denied", ip=ip, details={"username": body.username}
        )
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid username or password")
    raw, sess = await create_session(
        db, user, client_kind=body.client_kind, user_agent=request.headers.get("user-agent", ""), ip=ip
    )
    await audit("auth.login", actor=f"session:{sess.id}", ip=ip, details={"client_kind": sess.client_kind}, db=db)
    await db.commit()
    set_session_cookies(response, raw, sess.csrf_token)
    return {"user": _user_dto(user), "csrf_token": sess.csrf_token}


@router.post("/logout")
async def logout(
    response: Response, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    sess = await db.get(AuthSession, ctx.session.id)
    if sess:
        sess.revoked_at = datetime.now(UTC)
    await audit("auth.logout", actor=ctx.actor, db=db)
    await db.commit()
    clear_session_cookies(response)
    return {"ok": True}


@router.get("/sessions")
async def list_sessions(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> list:
    now = datetime.now(UTC)
    rows = (
        (
            await db.execute(
                select(AuthSession)
                .where(
                    AuthSession.user_id == ctx.user.id, AuthSession.revoked_at.is_(None), AuthSession.expires_at > now
                )
                .order_by(AuthSession.last_seen_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return [
        {
            "id": s.id,
            "client_kind": s.client_kind,
            "user_agent": s.user_agent,
            "ip": s.ip,
            "created_at": s.created_at,
            "last_seen_at": s.last_seen_at,
            "current": s.id == ctx.session.id,
            "device_id": s.device_id,
        }
        for s in rows
    ]


@router.post("/sessions/{session_id}/revoke")
async def revoke_session(
    session_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    sess = await db.get(AuthSession, session_id)
    if sess is None or sess.user_id != ctx.user.id:
        raise HTTPException(404, "session not found")
    sess.revoked_at = datetime.now(UTC)
    await audit("auth.session_revoked", actor=ctx.actor, target=session_id, db=db)
    await db.commit()
    return {"ok": True}


class PasswordBody(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=12, max_length=256)


@router.post("/password")
async def change_password(
    body: PasswordBody, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    user = await db.get(User, ctx.user.id)
    assert user is not None
    if not verify_password(user.password_hash, body.current_password):
        raise HTTPException(403, "current password is incorrect")
    user.password_hash = hash_password(body.new_password)
    # Revoke every other session.
    others = (
        (await db.execute(select(AuthSession).where(AuthSession.user_id == user.id, AuthSession.id != ctx.session.id)))
        .scalars()
        .all()
    )
    for s in others:
        s.revoked_at = datetime.now(UTC)
    await audit("auth.password_changed", actor=ctx.actor, db=db)
    await db.commit()
    return {"ok": True, "revoked_sessions": len(others)}
