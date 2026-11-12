"""System status, usage, notifications, settings, security centre, voice and insights."""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import case, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.config import get_settings
from jarvis.db.models import (
    Approval,
    AuditLog,
    AuthSession,
    Feedback,
    Notification,
    Run,
    RunStep,
    UsageRecord,
)
from jarvis.db.session import get_db
from jarvis.integrations import github
from jarvis.orchestrator import engine
from jarvis.realtime.hub import hub
from jarvis.schemas import NotificationDTO, SystemStatus
from jarvis.security.audit import audit
from jarvis.security.auth import SessionContext, client_ip, current_session
from jarvis.security.ratelimit import limiter
from jarvis.services.settings_store import DEFAULTS, get_all, set_emergency_stop, set_setting
from jarvis.services.status import system_status
from jarvis.voice import service as voice

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
async def health() -> dict:
    return {"ok": True, "version": get_settings().jarvis_version}


@router.get("/system/status")
async def status(ctx: SessionContext = Depends(current_session)) -> SystemStatus:
    return await system_status(ctx.user.id)


@router.get("/usage")
async def usage(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> dict:
    now = datetime.now(UTC)
    start_today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = start_today - timedelta(days=6)
    day = func.date_trunc("day", UsageRecord.ts)
    rows = (
        await db.execute(
            select(
                day,
                func.sum(UsageRecord.cost_usd),
                func.sum(UsageRecord.input_tokens),
                func.sum(UsageRecord.output_tokens),
            )
            .where(UsageRecord.user_id == ctx.user.id, UsageRecord.ts >= week_start)
            .group_by(day)
            .order_by(day)
        )
    ).all()
    by_model = (
        await db.execute(
            select(UsageRecord.model, func.count(), func.sum(UsageRecord.cost_usd))
            .where(UsageRecord.user_id == ctx.user.id, UsageRecord.ts >= week_start)
            .group_by(UsageRecord.model)
        )
    ).all()
    today = await engine.spent_today(ctx.user.id)
    return {
        "today_usd": round(today, 4),
        "daily_budget_usd": await engine.daily_budget(ctx.user.id),
        "series": [
            {
                "day": d.date().isoformat(),
                "cost_usd": round(c or 0, 4),
                "input_tokens": int(i or 0),
                "output_tokens": int(o or 0),
            }
            for d, c, i, o in rows
        ],
        "by_model": [{"model": m, "calls": n, "cost_usd": round(c or 0, 4)} for m, n, c in by_model],
    }


# --------------------------------------------------------------------------- notifications


@router.get("/notifications")
async def notifications(
    ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db), unread: bool = False
) -> list[NotificationDTO]:
    stmt = select(Notification).where(Notification.user_id == ctx.user.id)
    if unread:
        stmt = stmt.where(Notification.read_at.is_(None))
    rows = (await db.execute(stmt.order_by(Notification.created_at.desc()).limit(100))).scalars().all()
    return [NotificationDTO.model_validate(n) for n in rows]


@router.post("/notifications/read-all")
async def read_all(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> dict:
    await db.execute(
        update(Notification)
        .where(Notification.user_id == ctx.user.id, Notification.read_at.is_(None))
        .values(read_at=datetime.now(UTC))
    )
    await db.commit()
    return {"ok": True}


@router.post("/notifications/{notification_id}/read")
async def read_one(
    notification_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    await db.execute(
        update(Notification)
        .where(Notification.id == notification_id, Notification.user_id == ctx.user.id)
        .values(read_at=datetime.now(UTC))
    )
    await db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- settings

EDITABLE = {
    "voice",
    "interface",
    "notifications",
    "privacy",
    "budget",
    "web_allowlist",
    "watched_repos",
    "timezone",
    "dev_projects",
}
HOST_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$")


@router.get("/settings")
async def get_settings_route(
    ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    s = get_settings()
    return {
        "values": await get_all(db, ctx.user.id),
        "server": {
            "ai_provider": s.resolved_provider(),
            "anthropic_model": s.anthropic_model,
            "anthropic_fast_model": s.anthropic_fast_model,
            "effort": s.anthropic_effort,
            "model_routing": s.jarvis_model_routing,
            "stt_engine": s.jarvis_stt_engine,
            "tts_engine": s.jarvis_tts_engine,
            "max_steps_per_run": s.jarvis_max_steps_per_run,
            "default_daily_budget_usd": s.jarvis_daily_budget_usd,
            "env": s.jarvis_env,
        },
    }


class SettingBody(BaseModel):
    value: Any


def _validate_projects(value: object) -> list[dict[str, str]]:
    from pathlib import Path

    if not isinstance(value, list) or len(value) > 50:
        raise HTTPException(422, "dev_projects must be a list of {id, path}")
    out: list[dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            raise HTTPException(422, "each project needs an id and a path")
        pid, raw = str(item.get("id", "")), str(item.get("path", ""))
        if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,63}", pid):
            raise HTTPException(422, f"invalid project id {pid!r} (lowercase letters, digits, . _ -)")
        path = Path(raw)
        if not path.is_absolute():
            raise HTTPException(422, f"{pid}: path must be absolute")
        resolved = path.resolve()
        if not resolved.is_dir():
            raise HTTPException(422, f"{pid}: {raw} is not a directory on the JARVIS server")
        if resolved in (Path("/"), Path.home().resolve()) or len(resolved.parts) < 3:
            raise HTTPException(422, f"{pid}: refusing a system or home root; register the project folder itself")
        out.append({"id": pid, "path": str(resolved)})
    return out


@router.put("/settings/{key}")
async def put_setting(
    key: str, body: SettingBody, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    if key not in EDITABLE:
        raise HTTPException(403, "this setting cannot be changed here")
    value = body.value
    if key == "web_allowlist":
        if not isinstance(value, list) or len(value) > 200:
            raise HTTPException(422, "web_allowlist must be a list of hostnames")
        value = sorted({str(v).lower().strip(".") for v in value})
        bad = [v for v in value if not HOST_RE.match(v)]
        if bad:
            raise HTTPException(422, f"invalid hostnames: {bad[:5]}")
    elif key == "watched_repos":
        if not isinstance(value, list) or not all(isinstance(v, str) and github.REPO_RE.match(v) for v in value):
            raise HTTPException(422, "watched_repos must be a list of owner/name strings")
    elif key == "dev_projects":
        value = _validate_projects(value)
        await audit("settings.dev_projects", actor=ctx.actor, details={"projects": value}, db=db)
    elif key == "budget":
        daily = (value or {}).get("daily_usd")
        if daily is not None and not (isinstance(daily, int | float) and 0 <= daily <= 1000):
            raise HTTPException(422, "daily_usd must be between 0 and 1000")
    elif isinstance(DEFAULTS.get(key), dict) and not isinstance(value, dict):
        raise HTTPException(422, f"{key} must be an object")
    await set_setting(db, ctx.user.id, key, value)
    if key in ("web_allowlist", "budget"):
        await audit("settings.security_changed", actor=ctx.actor, target=key, details={"value": value}, db=db)
    await db.commit()
    return {"key": key, "value": value}


# --------------------------------------------------------------------------- security centre


@router.get("/audit")
async def audit_log(
    ctx: SessionContext = Depends(current_session),
    db: AsyncSession = Depends(get_db),
    limit: int = Query(default=100, le=500),
    action: str | None = None,
) -> list:
    stmt = select(AuditLog)
    if action:
        stmt = stmt.where(AuditLog.action.startswith(action))
    rows = (await db.execute(stmt.order_by(AuditLog.id.desc()).limit(limit))).scalars().all()
    return [
        {
            "id": r.id,
            "ts": r.ts,
            "actor": r.actor,
            "action": r.action,
            "target": r.target,
            "outcome": r.outcome,
            "ip": r.ip,
            "details": r.details,
        }
        for r in rows
    ]


class EmergencyBody(BaseModel):
    active: bool


@router.post("/security/emergency-stop")
async def emergency(
    body: EmergencyBody, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    await set_emergency_stop(db, ctx.user.id, body.active)
    await audit("security.emergency_stop", actor=ctx.actor, details={"active": body.active}, db=db)
    await db.commit()
    cancelled = await engine.cancel_all(ctx.user.id) if body.active else 0
    hub.publish(ctx.user.id, "system.status", {"status": await system_status(ctx.user.id)})
    return {"active": body.active, "cancelled_runs": cancelled}


@router.get("/security/overview")
async def security_overview(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> dict:
    since = datetime.now(UTC) - timedelta(days=7)
    denied = (
        await db.execute(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.ts >= since, AuditLog.outcome.in_(["denied", "failed"]))
        )
    ).scalar()
    pending = (
        await db.execute(
            select(func.count())
            .select_from(Approval)
            .where(Approval.user_id == ctx.user.id, Approval.status == "pending")
        )
    ).scalar()
    sessions = (
        await db.execute(
            select(func.count())
            .select_from(AuthSession)
            .where(
                AuthSession.user_id == ctx.user.id,
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > datetime.now(UTC),
            )
        )
    ).scalar()
    failed_logins = (
        await db.execute(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.ts >= since, AuditLog.action == "auth.login_failed")
        )
    ).scalar()
    s = get_settings()
    return {
        "denied_or_failed_7d": denied,
        "pending_approvals": pending,
        "active_sessions": sessions,
        "failed_logins_7d": failed_logins,
        "posture": {
            "secret_key_configured": bool(s.jarvis_secret_key.get_secret_value()),
            "secure_cookies": s.jarvis_cookie_secure,
            "environment": s.jarvis_env,
            "allowed_origins": s.allowed_origins,
        },
    }


# --------------------------------------------------------------------------- voice


@router.post("/voice/transcribe")
async def transcribe(audio: UploadFile = File(...), ctx: SessionContext = Depends(current_session)) -> dict:
    if not limiter.hit(f"stt:{ctx.user.id}", limit=30, window_s=60):
        raise HTTPException(429, "too many requests")
    data = await audio.read(voice.MAX_AUDIO_BYTES + 1)
    try:
        t = await voice.transcribe(data, filename=audio.filename or "audio.wav")
    except voice.VoiceError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"text": t.text, "engine": t.engine, "duration_s": round(t.duration_s, 2)}


class SpeakBody(BaseModel):
    text: str = Field(min_length=1, max_length=voice.MAX_TTS_CHARS)
    voice: str = Field(default="en-gb", max_length=20)
    rate: float = Field(default=1.0, ge=0.5, le=2.0)


@router.post("/voice/speak")
async def speak(body: SpeakBody, ctx: SessionContext = Depends(current_session)) -> Response:
    if not limiter.hit(f"tts:{ctx.user.id}", limit=60, window_s=60):
        raise HTTPException(429, "too many requests")
    try:
        audio, mime = await voice.synthesize(body.text, voice=body.voice, rate=body.rate)
    except voice.VoiceError as exc:
        raise HTTPException(422, str(exc)) from exc
    return Response(content=audio, media_type=mime, headers={"Cache-Control": "no-store"})


# --------------------------------------------------------------------------- insights (self-improvement)


@router.get("/insights")
async def insights(
    ctx: SessionContext = Depends(current_session),
    db: AsyncSession = Depends(get_db),
    days: int = Query(default=14, ge=1, le=90),
) -> dict:
    since = datetime.now(UTC) - timedelta(days=days)
    tool_rows = (
        await db.execute(
            select(
                RunStep.name,
                func.count(),
                func.sum(case((RunStep.status == "succeeded", 1), else_=0)),
                func.sum(case((RunStep.status == "denied", 1), else_=0)),
                func.avg(RunStep.duration_ms),
            )
            .join(Run, Run.id == RunStep.run_id)
            .where(Run.user_id == ctx.user.id, RunStep.kind == "tool_call", RunStep.started_at >= since)
            .group_by(RunStep.name)
        )
    ).all()
    run_rows = (
        await db.execute(
            select(Run.kind, Run.status, func.count())
            .where(Run.user_id == ctx.user.id, Run.created_at >= since)
            .group_by(Run.kind, Run.status)
        )
    ).all()
    fb = (
        await db.execute(
            select(
                func.sum(case((Feedback.rating > 0, 1), else_=0)), func.sum(case((Feedback.rating < 0, 1), else_=0))
            ).where(Feedback.user_id == ctx.user.id, Feedback.created_at >= since)
        )
    ).one()
    recent_failures = (
        await db.execute(
            select(RunStep.name, RunStep.error, RunStep.started_at)
            .join(Run, Run.id == RunStep.run_id)
            .where(Run.user_id == ctx.user.id, RunStep.status == "failed", RunStep.started_at >= since)
            .order_by(RunStep.started_at.desc())
            .limit(10)
        )
    ).all()
    tools = [
        {
            "tool": n,
            "calls": c,
            "succeeded": int(s or 0),
            "denied": int(d or 0),
            "success_rate": round((s or 0) / c, 3) if c else None,
            "avg_ms": round(a or 0),
        }
        for n, c, s, d, a in tool_rows
    ]
    suggestions: list[str] = []
    for t in tools:
        if t["calls"] >= 3 and t["success_rate"] is not None and t["success_rate"] < 0.6:
            suggestions.append(
                f"{t['tool']} succeeds only {t['success_rate']:.0%} of the time — review its recent failures below."
            )
        if t["denied"] >= 3:
            suggestions.append(
                f"{t['tool']} was denied {t['denied']} times — consider adjusting its permission "
                "or the allow-list if those requests were legitimate."
            )
    return {
        "days": days,
        "tools": sorted(tools, key=lambda t: -t["calls"]),
        "runs": [{"kind": k, "status": s, "count": n} for k, s, n in run_rows],
        "feedback": {"positive": int(fb[0] or 0), "negative": int(fb[1] or 0)},
        "recent_failures": [{"tool": n, "error": e, "at": a} for n, e, a in recent_failures],
        "suggestions": suggestions,
    }


@router.get("/artifacts/{name}")
async def artifact(name: str, ctx: SessionContext = Depends(current_session)) -> FileResponse:
    if not re.fullmatch(r"[a-f0-9]{32}\.png", name):
        raise HTTPException(404, "not found")
    path = get_settings().jarvis_data_dir / "artifacts" / ctx.user.id / name
    if not path.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="image/png")


_ = (Literal, client_ip)
