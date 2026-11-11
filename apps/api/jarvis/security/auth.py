"""Session authentication, CSRF protection and WebSocket tickets.

- Sessions: random 256-bit token in an HttpOnly cookie; only its SHA-256 is stored.
- CSRF: every unsafe request must echo the session's CSRF token in `X-CSRF-Token`
  (the token is delivered in a readable cookie and in the login response).
- WebSockets: browsers cannot set headers on WS upgrades, so clients first obtain
  a single-use 30-second ticket over authenticated REST, and the Origin header is
  checked against the allow-list.
"""

from __future__ import annotations

import secrets
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.config import get_settings
from jarvis.db.models import AuthSession, User
from jarvis.db.session import get_db
from jarvis.security.crypto import constant_time_eq, new_token, token_hash

SESSION_COOKIE = "jarvis_session"
CSRF_COOKIE = "jarvis_csrf"
CSRF_HEADER = "x-csrf-token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@dataclass
class SessionContext:
    user: User
    session: AuthSession

    @property
    def actor(self) -> str:
        return f"session:{self.session.id}"

    @property
    def client_kind(self) -> str:
        return self.session.client_kind


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


async def create_session(
    db: AsyncSession, user: User, *, client_kind: str, user_agent: str, ip: str
) -> tuple[str, AuthSession]:
    raw = new_token()
    sess = AuthSession(
        token_hash=token_hash(raw),
        csrf_token=new_token(24),
        user_id=user.id,
        client_kind=client_kind if client_kind in {"web", "mobile"} else "web",
        user_agent=user_agent[:400],
        ip=ip,
        expires_at=datetime.now(UTC) + timedelta(hours=get_settings().jarvis_session_ttl_hours),
    )
    db.add(sess)
    await db.flush()
    return raw, sess


def set_session_cookies(response: Response, raw_token: str, csrf: str) -> None:
    s = get_settings()
    max_age = s.jarvis_session_ttl_hours * 3600
    response.set_cookie(
        SESSION_COOKIE,
        raw_token,
        max_age=max_age,
        httponly=True,
        secure=s.jarvis_cookie_secure,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        CSRF_COOKIE,
        csrf,
        max_age=max_age,
        httponly=False,
        secure=s.jarvis_cookie_secure,
        samesite="strict",
        path="/",
    )


def clear_session_cookies(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")


async def load_session(db: AsyncSession, raw_token: str | None) -> SessionContext | None:
    if not raw_token:
        return None
    row = (
        await db.execute(
            select(AuthSession, User)
            .join(User, User.id == AuthSession.user_id)
            .where(AuthSession.token_hash == token_hash(raw_token))
        )
    ).first()
    if row is None:
        return None
    sess, user = row
    now = datetime.now(UTC)
    if sess.revoked_at is not None or sess.expires_at <= now:
        return None
    if (now - sess.last_seen_at).total_seconds() > 60:
        sess.last_seen_at = now
        await db.commit()
    return SessionContext(user=user, session=sess)


async def current_session(request: Request, db: AsyncSession = Depends(get_db)) -> SessionContext:
    ctx = await load_session(db, request.cookies.get(SESSION_COOKIE))
    if ctx is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "not authenticated")
    if request.method not in SAFE_METHODS:
        sent = request.headers.get(CSRF_HEADER, "")
        if not sent or not constant_time_eq(sent, ctx.session.csrf_token):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "CSRF token missing or invalid")
    request.state.session = ctx
    return ctx


def origin_allowed(origin: str | None) -> bool:
    if origin is None:
        return True  # non-browser clients (tests, CLI) do not send Origin
    return origin.rstrip("/") in get_settings().allowed_origins


# ---------------------------------------------------------------------------
# WebSocket tickets (single use, 30 s)
# ---------------------------------------------------------------------------

_tickets: dict[str, tuple[str, float]] = {}
TICKET_TTL_S = 30.0


def issue_ws_ticket(session_id: str) -> str:
    now = time.monotonic()
    for k, (_, exp) in list(_tickets.items()):
        if exp < now:
            _tickets.pop(k, None)
    ticket = secrets.token_urlsafe(24)
    _tickets[ticket] = (session_id, now + TICKET_TTL_S)
    return ticket


def redeem_ws_ticket(ticket: str) -> str | None:
    entry = _tickets.pop(ticket, None)
    if entry is None:
        return None
    session_id, exp = entry
    return session_id if exp >= time.monotonic() else None


async def session_by_id(db: AsyncSession, session_id: str) -> SessionContext | None:
    row = (
        await db.execute(
            select(AuthSession, User).join(User, User.id == AuthSession.user_id).where(AuthSession.id == session_id)
        )
    ).first()
    if row is None:
        return None
    sess, user = row
    if sess.revoked_at is not None or sess.expires_at <= datetime.now(UTC):
        return None
    return SessionContext(user=user, session=sess)
