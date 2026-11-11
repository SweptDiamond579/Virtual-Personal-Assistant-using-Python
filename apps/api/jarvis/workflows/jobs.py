from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from croniter import croniter
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.db.models import ScheduledJob

JOB_KINDS = {"reminder", "workflow", "agent_task", "health_check"}
MIN_CRON_INTERVAL_S = 300  # resource limit: recurring jobs at most every 5 minutes


def next_cron_run(expr: str, after: datetime) -> datetime:
    return croniter(expr, after).get_next(datetime).astimezone(UTC)


def validate_cron(expr: str) -> None:
    if not croniter.is_valid(expr):
        raise ValueError(f"invalid cron expression '{expr}'")
    base = datetime(2026, 1, 1, tzinfo=UTC)
    first = next_cron_run(expr, base)
    second = next_cron_run(expr, first)
    if (second - first).total_seconds() < MIN_CRON_INTERVAL_S:
        raise ValueError("recurring jobs may run at most every 5 minutes")


async def create_job(
    db: AsyncSession,
    *,
    user_id: str,
    name: str,
    kind: str,
    payload: dict[str, Any],
    schedule: str | None = None,
    run_at: datetime | None = None,
    max_runtime_s: int = 120,
    max_retries: int = 0,
) -> ScheduledJob:
    if kind not in JOB_KINDS:
        raise ValueError(f"unknown job kind {kind}")
    if (schedule is None) == (run_at is None):
        raise ValueError("provide exactly one of schedule (cron) or run_at")
    now = datetime.now(UTC)
    if schedule:
        validate_cron(schedule)
        next_run = next_cron_run(schedule, now)
    else:
        assert run_at is not None
        next_run = run_at if run_at.tzinfo else run_at.replace(tzinfo=UTC)
    job = ScheduledJob(
        user_id=user_id,
        name=name[:160],
        kind=kind,
        schedule=schedule,
        run_at=run_at,
        payload=payload,
        next_run_at=next_run,
        max_runtime_s=max(5, min(max_runtime_s, 1800)),
        max_retries=max(0, min(max_retries, 3)),
    )
    db.add(job)
    await db.flush()
    return job
