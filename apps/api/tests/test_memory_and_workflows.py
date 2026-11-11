from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from jarvis.db.models import JobRun, Note, Notification, ScheduledJob
from jarvis.db.session import db_session
from jarvis.memory import service as memory
from jarvis.workflows import scheduler
from jarvis.workflows.engine import WorkflowDef, instantiate_template, run_workflow
from jarvis.workflows.jobs import create_job, validate_cron
from tests.conftest import AuthedClient


async def test_memory_lifecycle(owner: AuthedClient) -> None:
    uid = owner.user_id
    async with db_session() as db:
        with pytest.raises(memory.SensitiveContentError):
            await memory.propose(
                db,
                user_id=uid,
                content="my api key is sk-abcdefghijklmnopqrstuv",
                kind="fact",
                source="agent",
                provenance={},
            )
        proposed = await memory.propose(
            db,
            user_id=uid,
            content="The user prefers concise answers in British English",
            kind="preference",
            source="agent",
            provenance={"run_id": "r1"},
        )
        await db.commit()
        # Proposed memories never reach the model.
        assert await memory.search(db, uid, "british english answers", for_model=True) == []

    r = await owner.post(f"/api/memories/{proposed.id}/approve", json={"supersede": False})
    assert r.status_code == 200 and r.json()["status"] == "active"
    async with db_session() as db:
        hits = await memory.search(db, uid, "Which English spelling does the user prefer?", for_model=True)
        await db.commit()
    assert hits and hits[0].memory.id == proposed.id
    assert hits[0].memory.last_used_at is not None


async def test_memory_conflict_and_supersede(owner: AuthedClient) -> None:
    old = (
        await owner.post("/api/memories", json={"content": "The user's favourite editor is Vim", "kind": "preference"})
    ).json()
    async with db_session() as db:
        new = await memory.propose(
            db,
            user_id=owner.user_id,
            content="The user's favourite editor is Neovim",
            kind="preference",
            source="agent",
            provenance={},
        )
        await db.commit()
    assert old["id"] in new.conflicts_with
    await owner.post(f"/api/memories/{new.id}/approve", json={"supersede": True})
    listed = {m["id"]: m for m in (await owner.get("/api/memories")).json()}
    assert listed[old["id"]]["status"] == "archived"
    assert listed[new.id]["status"] == "active"


async def test_private_memory_excluded_from_model_and_deletion(owner: AuthedClient) -> None:
    m = (
        await owner.post(
            "/api/memories", json={"content": "Medical appointment details at the clinic", "share_with_model": False}
        )
    ).json()
    async with db_session() as db:
        assert await memory.search(db, owner.user_id, "medical appointment clinic", for_model=True) == []
        assert await memory.search(db, owner.user_id, "medical appointment clinic", for_model=False)
    assert (await owner.delete(f"/api/memories/{m['id']}")).status_code == 200
    assert (await owner.get("/api/memories")).json() == []
    bad = await owner.delete("/api/memories", params={"confirm": "yes"})
    assert bad.status_code == 400


def test_cron_limits() -> None:
    validate_cron("*/5 * * * *")
    with pytest.raises(ValueError):
        validate_cron("* * * * *")
    with pytest.raises(ValueError):
        validate_cron("not a cron")


async def test_reminder_delivered_by_scheduler(owner: AuthedClient) -> None:
    async with db_session() as db:
        job = await create_job(
            db,
            user_id=owner.user_id,
            name="Reminder: stretch",
            kind="reminder",
            run_at=datetime.now(UTC) + timedelta(seconds=1),
            payload={"text": "stretch"},
        )
        await db.commit()
    assert await scheduler.tick(datetime.now(UTC)) == 0  # not yet due
    claimed = await scheduler.tick(datetime.now(UTC) + timedelta(seconds=2))
    assert claimed == 1
    for _ in range(50):
        async with db_session() as db:
            notes = (await db.execute(select(Notification).where(Notification.title == "Reminder"))).scalars().all()
        if notes:
            break
        await asyncio.sleep(0.05)
    assert notes and notes[0].body == "stretch"
    async with db_session() as db:
        j = await db.get(ScheduledJob, job.id)
        runs = (await db.execute(select(JobRun).where(JobRun.job_id == job.id))).scalars().all()
    assert j is not None and j.enabled is False and j.last_status == "succeeded"
    assert len(runs) == 1 and runs[0].status == "succeeded"
    # Not delivered twice.
    assert await scheduler.tick(datetime.now(UTC) + timedelta(seconds=10)) == 0


async def test_workflow_dependencies_and_failure_handling(owner: AuthedClient) -> None:
    with pytest.raises(ValueError):
        WorkflowDef.model_validate(
            {
                "steps": [
                    {"id": "a", "tool": "get_current_time", "depends_on": ["b"]},
                    {"id": "b", "tool": "get_current_time", "depends_on": ["a"]},
                ]
            }
        ).ordered()
    summary = await run_workflow(
        user_id=owner.user_id,
        name="t",
        definition={
            "steps": [
                {"id": "calc", "tool": "calculate", "args": {"expression": "1/0"}},
                {
                    "id": "after",
                    "tool": "notes_create",
                    "args": {"title": "{{steps.calc.summary}}"},
                    "depends_on": ["calc"],
                },
            ]
        },
    )
    assert summary.status == "failed"
    async with db_session() as db:
        assert (await db.execute(select(Note))).scalars().all() == []


async def test_daily_briefing_template(owner: AuthedClient) -> None:
    name, definition = instantiate_template("daily_briefing", {})
    summary = await run_workflow(user_id=owner.user_id, name=name, definition=definition)
    assert summary.status == "succeeded", summary.error
    async with db_session() as db:
        note = (await db.execute(select(Note).where(Note.title == "Daily briefing"))).scalar_one()
    assert "Reminders:" in note.body and "UTC" in note.body


async def test_jobs_api_validation(owner: AuthedClient) -> None:
    r = await owner.post("/api/jobs", json={"name": "spam", "kind": "health_check", "schedule": "* * * * *"})
    assert r.status_code == 422
    r = await owner.post(
        "/api/jobs",
        json={
            "name": "bad wf",
            "kind": "workflow",
            "schedule": "0 7 * * *",
            "payload": {"definition": {"steps": [{"id": "x", "tool": "rm_rf"}]}},
        },
    )
    assert r.status_code == 422
    r = await owner.post("/api/jobs", json={"name": "Morning health", "kind": "health_check", "schedule": "0 7 * * *"})
    assert r.status_code == 200 and r.json()["next_run_at"]
