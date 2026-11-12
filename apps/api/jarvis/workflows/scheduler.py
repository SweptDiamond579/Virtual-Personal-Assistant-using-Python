"""Database-backed job scheduler.

A single asyncio loop polls `scheduled_jobs` for due work, claims it with
`FOR UPDATE SKIP LOCKED` (safe if several API workers ever run), sets a lease
(`locked_until`), computes the next occurrence, and executes the job with a
hard timeout. Every execution is recorded in `job_runs`.

Retry policy: only idempotent kinds (reminder, health_check) are retried, up
to `max_retries`. Workflows and agent tasks are never re-run automatically —
their side effects may already have happened.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import and_, or_, select

from jarvis.config import get_settings
from jarvis.db.models import JobRun, Run, ScheduledJob, Workflow
from jarvis.db.session import db_session
from jarvis.logging import get_logger
from jarvis.realtime.hub import hub
from jarvis.schemas import JobDTO
from jarvis.services.notifications import notify
from jarvis.services.settings_store import emergency_stop_active
from jarvis.workflows.jobs import next_cron_run

log = get_logger("scheduler")
RETRYABLE_KINDS = {"reminder", "health_check"}

_state: dict[str, Any] = {"last_tick": None, "running": False, "executed": 0}


def scheduler_state() -> dict[str, Any]:
    return dict(_state)


async def claim_due(now: datetime, limit: int = 10) -> list[ScheduledJob]:
    async with db_session() as db:
        stmt = (
            select(ScheduledJob)
            .where(
                ScheduledJob.enabled.is_(True),
                ScheduledJob.next_run_at <= now,
                or_(ScheduledJob.locked_until.is_(None), ScheduledJob.locked_until < now),
            )
            .order_by(ScheduledJob.next_run_at)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
        jobs = list((await db.execute(stmt)).scalars().all())
        claimed: list[ScheduledJob] = []
        for job in jobs:
            if emergency_stop_active(job.user_id):
                continue  # deferred, not dropped
            job.locked_until = now + timedelta(seconds=job.max_runtime_s + 30)
            job.last_run_at = now
            if job.schedule:
                job.next_run_at = next_cron_run(job.schedule, now)
            else:
                job.next_run_at = None
                job.enabled = False
            claimed.append(job)
        await db.commit()
        return claimed


async def _execute(job: ScheduledJob) -> tuple[str, dict[str, Any], str | None]:
    from jarvis.orchestrator import engine
    from jarvis.services.status import system_status
    from jarvis.workflows.engine import run_workflow

    payload = job.payload or {}
    if job.kind == "reminder":
        await notify(job.user_id, "Reminder", payload.get("text", job.name), level="info", link="/assistant")
        return "succeeded", {"delivered": True}, None
    if job.kind == "health_check":
        status = await system_status(job.user_id)
        down = [s.name for s in status.services if s.status in ("down", "degraded")]
        if down or payload.get("notify_always"):
            await notify(
                job.user_id,
                "System health check",
                ("Issues: " + ", ".join(down)) if down else "All services nominal.",
                level="warning" if down else "success",
                link="/",
            )
        return "succeeded", {"issues": down}, None
    if job.kind == "workflow":
        definition = payload.get("definition")
        name = job.name
        if definition is None and payload.get("workflow_id"):
            async with db_session() as db:
                wf = await db.get(Workflow, payload["workflow_id"])
            if wf is None or wf.user_id != job.user_id:
                return "failed", {}, "workflow not found"
            definition, name = wf.definition, wf.name
        summary = await run_workflow(user_id=job.user_id, name=name, definition=definition or {}, origin="scheduler")
        return summary.status, {"run_id": summary.id}, summary.error
    if job.kind == "agent_task":
        run = await engine.run_agent_task(user_id=job.user_id, prompt=payload.get("prompt", ""), title=job.name)
        try:
            await engine.wait_for_run(run.id, timeout=job.max_runtime_s)
        except TimeoutError:
            await engine.cancel_run(run.id)
            return "failed", {"run_id": run.id}, "agent task exceeded its runtime limit"
        async with db_session() as db:
            fresh = await db.get(Run, run.id)
        status = fresh.status if fresh else "failed"
        return status, {"run_id": run.id}, fresh.error if fresh else "run missing"
    return "failed", {}, f"unknown job kind {job.kind}"


async def run_job(job: ScheduledJob) -> None:
    attempts = 1 + (job.max_retries if job.kind in RETRYABLE_KINDS else 0)
    for attempt in range(1, attempts + 1):
        async with db_session() as db:
            jr = JobRun(job_id=job.id, attempt=attempt)
            db.add(jr)
            await db.commit()
            await db.refresh(jr)
        status, output, error = "failed", {}, None
        try:
            status, output, error = await asyncio.wait_for(_execute(job), timeout=job.max_runtime_s)
        except TimeoutError:
            error = f"timed out after {job.max_runtime_s}s"
        except Exception as exc:
            log.exception("job failed", job=job.id)
            error = f"{type(exc).__name__}: {exc}"
        async with db_session() as db:
            jr_db = await db.get(JobRun, jr.id)
            job_db = await db.get(ScheduledJob, job.id)
            if jr_db is not None:
                jr_db.status, jr_db.output, jr_db.error = status, output, error
                jr_db.run_id = output.get("run_id")
                jr_db.finished_at = datetime.now(UTC)
            if job_db is not None:
                job_db.last_status = status
                job_db.locked_until = None
            await db.commit()
            if job_db is not None:
                hub.publish(job.user_id, "job.updated", {"job": JobDTO.model_validate(job_db)})
        _state["executed"] += 1
        if status == "succeeded":
            return
        if attempt < attempts:
            await asyncio.sleep(min(2**attempt, 30))
    if job.kind != "reminder":
        await notify(job.user_id, f"Scheduled job failed: {job.name}", error or "", level="error", link="/automation")


async def purge_expired_conversations(now: datetime | None = None) -> int:
    """Apply each user's conversation retention setting (0 = keep forever)."""
    from sqlalchemy import delete

    from jarvis.db.models import Conversation, UserSetting

    now = now or datetime.now(UTC)
    deleted = 0
    async with db_session() as db:
        rows = (await db.execute(select(UserSetting).where(UserSetting.key == "privacy"))).scalars().all()
        for row in rows:
            days = int((row.value.get("v") or {}).get("conversation_retention_days") or 0)
            if days <= 0:
                continue
            res = await db.execute(
                delete(Conversation).where(
                    Conversation.user_id == row.user_id, Conversation.updated_at < now - timedelta(days=days)
                )
            )
            deleted += res.rowcount or 0
        await db.commit()
    if deleted:
        log.info("retention purge", conversations=deleted)
    return deleted


async def tick(now: datetime | None = None) -> int:
    now = now or datetime.now(UTC)
    _state["last_tick"] = now.isoformat()
    last_purge = _state.get("last_purge")
    if last_purge is None or (now - last_purge).total_seconds() > 3600:
        _state["last_purge"] = now
        await purge_expired_conversations(now)
    jobs = await claim_due(now)
    for job in jobs:
        asyncio.create_task(run_job(job), name=f"job-{job.id}")
    return len(jobs)


async def scheduler_loop() -> None:
    _state["running"] = True
    poll = get_settings().jarvis_scheduler_poll_s
    try:
        while True:
            try:
                await tick()
            except Exception:
                log.exception("scheduler tick failed")
            await asyncio.sleep(poll)
    finally:
        _state["running"] = False


async def release_stale_leases() -> None:
    async with db_session() as db:
        now = datetime.now(UTC)
        rows = (
            (
                await db.execute(
                    select(ScheduledJob).where(
                        and_(ScheduledJob.locked_until.is_not(None), ScheduledJob.locked_until < now)
                    )
                )
            )
            .scalars()
            .all()
        )
        for r in rows:
            r.locked_until = None
        await db.commit()
