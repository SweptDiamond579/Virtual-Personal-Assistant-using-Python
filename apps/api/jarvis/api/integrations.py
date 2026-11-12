"""Integrations: catalogue, GitHub connection and development data."""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.config import get_settings
from jarvis.db.models import (
    Integration,
)
from jarvis.db.session import get_db
from jarvis.integrations import github
from jarvis.security.audit import audit
from jarvis.security.auth import SessionContext, current_session
from jarvis.security.crypto import encrypt_secret
from jarvis.security.ratelimit import limiter
from jarvis.services import devices as device_service

router = APIRouter(prefix="/api", tags=["integrations"])

# --------------------------------------------------------------------------- integrations


@router.get("/integrations")
async def integrations(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> list:
    from jarvis.integrations.smtp import smtp_configured

    gh = (
        (
            await db.execute(
                select(Integration).where(
                    Integration.user_id == ctx.user.id,
                    Integration.provider == "github",
                    Integration.revoked_at.is_(None),
                )
            )
        )
        .scalars()
        .first()
    )
    s = get_settings()
    desktop = device_service.online_desktop(ctx.user.id)
    return [
        {
            "id": "github",
            "name": "GitHub",
            "implemented": True,
            "status": "connected" if gh else "public_mode",
            "account": gh.account_label if gh else None,
            "scopes": gh.scopes if gh else [],
            "connected_at": gh.created_at if gh else None,
            "auth": "Fine-grained personal access token (stored encrypted)",
            "capabilities": [
                "Repository overview",
                "Pull requests & issues",
                "CI workflow runs",
                "Create issues (approval)",
            ],
        },
        {
            "id": "smtp",
            "name": "Email (SMTP)",
            "implemented": True,
            "status": "connected" if smtp_configured() else "not_configured",
            "account": s.smtp_from if smtp_configured() else None,
            "auth": "Server environment (SMTP_* variables)",
            "capabilities": ["Draft emails", "Send drafts (approval)"],
        },
        {
            "id": "desktop",
            "name": "Desktop companion",
            "implemented": True,
            "status": "connected" if desktop else "not_connected",
            "account": desktop,
            "auth": "Pairing code + local Rust policy",
            "capabilities": ["Launch allow-listed apps", "Files in authorised folders"],
        },
        {
            "id": "anthropic",
            "name": "Anthropic Claude",
            "implemented": True,
            "status": "connected" if s.resolved_provider() == "anthropic" else "not_configured",
            "account": s.anthropic_model if s.resolved_provider() == "anthropic" else None,
            "auth": "ANTHROPIC_API_KEY (server environment)",
            "capabilities": ["Reasoning", "Tool use", "Streaming"],
        },
        *[
            {
                "id": pid,
                "name": name,
                "implemented": False,
                "status": "planned",
                "account": None,
                "auth": "OAuth 2.0 (requires your own OAuth client credentials)",
                "capabilities": caps,
            }
            for pid, name, caps in [
                ("google", "Google (Gmail, Calendar, Drive)", ["Planned for a later milestone"]),
                ("microsoft", "Microsoft 365", ["Planned for a later milestone"]),
                ("notion", "Notion", ["Planned for a later milestone"]),
                ("slack", "Slack", ["Planned for a later milestone"]),
            ]
        ],
    ]


class GitHubConnect(BaseModel):
    token: str = Field(min_length=20, max_length=400)


@router.post("/integrations/github")
async def connect_github(
    body: GitHubConnect, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    if not limiter.hit(f"gh-connect:{ctx.user.id}", limit=10, window_s=300):
        raise HTTPException(429, "too many attempts")
    try:
        info = await github.validate_token(body.token.strip())
    except github.GitHubError as exc:
        raise HTTPException(400, f"GitHub rejected the token: {exc}") from exc
    rows = (
        (
            await db.execute(
                select(Integration).where(
                    Integration.user_id == ctx.user.id,
                    Integration.provider == "github",
                    Integration.revoked_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    for r in rows:
        r.revoked_at = datetime.now(UTC)
        r.encrypted_token = None
    db.add(
        Integration(
            user_id=ctx.user.id,
            provider="github",
            account_label=info["login"],
            encrypted_token=encrypt_secret(body.token.strip()),
            config={"name": info.get("name")},
            last_checked_at=datetime.now(UTC),
        )
    )
    await audit("integration.connected", actor=ctx.actor, target="github", details={"login": info["login"]}, db=db)
    await db.commit()
    return {"connected": True, "account": info["login"]}


@router.delete("/integrations/github")
async def disconnect_github(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> dict:
    rows = (
        (
            await db.execute(
                select(Integration).where(
                    Integration.user_id == ctx.user.id,
                    Integration.provider == "github",
                    Integration.revoked_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    for r in rows:
        r.revoked_at = datetime.now(UTC)
        r.encrypted_token = None  # destroy the credential, keep the audit trail
    await audit("integration.revoked", actor=ctx.actor, target="github", db=db)
    await db.commit()
    return {"revoked": len(rows)}


@router.get("/dev/repos/{owner}/{name}")
async def repo(owner: str, name: str, ctx: SessionContext = Depends(current_session)) -> dict:
    try:
        return await github.repo_overview(ctx.user.id, f"{owner}/{name}")
    except github.GitHubError as exc:
        raise HTTPException(exc.status or 400, str(exc)) from exc


@router.get("/dev/my-repos")
async def my_repos(ctx: SessionContext = Depends(current_session)) -> list:
    try:
        return await github.my_repos(ctx.user.id)
    except github.GitHubError as exc:
        raise HTTPException(400, str(exc)) from exc
