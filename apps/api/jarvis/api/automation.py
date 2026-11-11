"""Automation Centre: scheduled jobs, workflows and templates."""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.db.models import JobRun, ScheduledJob, Workflow
from jarvis.db.session import get_db
from jarvis.schemas import JobDTO
from jarvis.security.audit import audit
from jarvis.security.auth import SessionContext, current_session
from jarvis.workflows.engine import TEMPLATES, WorkflowDef, instantiate_template, run_workflow
from jarvis.workflows.jobs import create_job
from jarvis.workflows.scheduler import run_job

router = APIRouter(prefix="/api", tags=["automation"])


class JobBody(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    kind: Literal["reminder", "workflow", "agent_task", "health_check"]
    schedule: str | None = Field(default=None, max_length=80, description="cron (UTC)")
    run_at: datetime | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    max_runtime_s: int = Field(default=120, ge=5, le=1800)
    max_retries: int = Field(default=0, ge=0, le=3)


@router.get("/jobs")
async def list_jobs(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> list[JobDTO]:
    rows = (
        (
            await db.execute(
                select(ScheduledJob)
                .where(ScheduledJob.user_id == ctx.user.id)
                .order_by(ScheduledJob.created_at.desc())
                .limit(200)
            )
        )
        .scalars()
        .all()
    )
    return [JobDTO.model_validate(j) for j in rows]


@router.post("/jobs")
async def new_job(
    body: JobBody, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> JobDTO:
    if body.kind == "workflow":
        if "definition" in body.payload:
            try:
                WorkflowDef.model_validate(body.payload["definition"]).ordered()
            except (ValidationError, ValueError) as exc:
                raise HTTPException(422, f"invalid workflow: {exc}") from exc
        elif "workflow_id" not in body.payload:
            raise HTTPException(422, "workflow jobs need payload.definition or payload.workflow_id")
    if body.kind == "agent_task" and not str(body.payload.get("prompt", "")).strip():
        raise HTTPException(422, "agent_task jobs need payload.prompt")
    try:
        job = await create_job(
            db,
            user_id=ctx.user.id,
            name=body.name,
            kind=body.kind,
            payload=body.payload,
            schedule=body.schedule,
            run_at=body.run_at,
            max_runtime_s=body.max_runtime_s,
            max_retries=body.max_retries,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    await audit(
        "job.created", actor=ctx.actor, target=job.id, details={"kind": body.kind, "schedule": body.schedule}, db=db
    )
    await db.commit()
    return JobDTO.model_validate(job)


class JobPatch(BaseModel):
    enabled: bool


@router.patch("/jobs/{job_id}")
async def patch_job(
    job_id: str, body: JobPatch, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> JobDTO:
    job = await db.get(ScheduledJob, job_id)
    if job is None or job.user_id != ctx.user.id:
        raise HTTPException(404, "job not found")
    job.enabled = body.enabled
    if body.enabled and job.next_run_at is None and job.schedule:
        from datetime import UTC
        from datetime import datetime as dt

        from jarvis.workflows.jobs import next_cron_run

        job.next_run_at = next_cron_run(job.schedule, dt.now(UTC))
    await db.commit()
    return JobDTO.model_validate(job)


@router.delete("/jobs/{job_id}")
async def delete_job(
    job_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    job = await db.get(ScheduledJob, job_id)
    if job is None or job.user_id != ctx.user.id:
        raise HTTPException(404, "job not found")
    await db.delete(job)
    await audit("job.deleted", actor=ctx.actor, target=job_id, db=db)
    await db.commit()
    return {"ok": True}


@router.post("/jobs/{job_id}/run-now")
async def run_now(
    job_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    job = await db.get(ScheduledJob, job_id)
    if job is None or job.user_id != ctx.user.id:
        raise HTTPException(404, "job not found")
    asyncio.create_task(run_job(job))
    await audit("job.run_now", actor=ctx.actor, target=job_id)
    return {"started": True}


@router.get("/jobs/{job_id}/runs")
async def job_runs(
    job_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> list:
    job = await db.get(ScheduledJob, job_id)
    if job is None or job.user_id != ctx.user.id:
        raise HTTPException(404, "job not found")
    rows = (
        (await db.execute(select(JobRun).where(JobRun.job_id == job_id).order_by(JobRun.started_at.desc()).limit(50)))
        .scalars()
        .all()
    )
    return [
        {
            "id": r.id,
            "status": r.status,
            "attempt": r.attempt,
            "started_at": r.started_at,
            "finished_at": r.finished_at,
            "error": r.error,
            "run_id": r.run_id,
            "output": r.output,
        }
        for r in rows
    ]


# --------------------------------------------------------------------------- workflows


class WorkflowBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    definition: dict[str, Any]


@router.get("/workflows")
async def list_workflows(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> list:
    rows = (
        (await db.execute(select(Workflow).where(Workflow.user_id == ctx.user.id).order_by(Workflow.updated_at.desc())))
        .scalars()
        .all()
    )
    return [
        {
            "id": w.id,
            "name": w.name,
            "description": w.description,
            "definition": w.definition,
            "updated_at": w.updated_at,
        }
        for w in rows
    ]


@router.post("/workflows")
async def create_workflow(
    body: WorkflowBody, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    try:
        WorkflowDef.model_validate(body.definition).ordered()
    except (ValidationError, ValueError) as exc:
        raise HTTPException(422, f"invalid workflow: {exc}") from exc
    w = Workflow(user_id=ctx.user.id, name=body.name, description=body.description, definition=body.definition)
    db.add(w)
    await audit("workflow.created", actor=ctx.actor, target=w.name, db=db)
    await db.commit()
    return {"id": w.id}


@router.delete("/workflows/{workflow_id}")
async def delete_workflow(
    workflow_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    w = await db.get(Workflow, workflow_id)
    if w is None or w.user_id != ctx.user.id:
        raise HTTPException(404, "workflow not found")
    await db.delete(w)
    await db.commit()
    return {"ok": True}


@router.post("/workflows/{workflow_id}/run")
async def run_saved_workflow(
    workflow_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    w = await db.get(Workflow, workflow_id)
    if w is None or w.user_id != ctx.user.id:
        raise HTTPException(404, "workflow not found")
    asyncio.create_task(run_workflow(user_id=ctx.user.id, name=w.name, definition=w.definition, origin="workflow"))
    await audit("workflow.run", actor=ctx.actor, target=w.id)
    return {"started": True}


@router.get("/workflow-templates")
async def templates(ctx: SessionContext = Depends(current_session)) -> list:
    return [
        {"key": k, "name": v["name"], "description": v["description"], "params": v["params"]}
        for k, v in TEMPLATES.items()
    ]


class TemplateBody(BaseModel):
    params: dict[str, str] = Field(default_factory=dict)
    schedule: str | None = Field(default=None, max_length=80)
    run_now: bool = False


@router.post("/workflow-templates/{key}/instantiate")
async def instantiate(
    key: str, body: TemplateBody, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    try:
        name, definition = instantiate_template(key, body.params)
        WorkflowDef.model_validate(definition).ordered()
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except (ValidationError, ValueError) as exc:
        raise HTTPException(422, f"invalid parameters: {exc}") from exc
    w = Workflow(user_id=ctx.user.id, name=name, description=TEMPLATES[key]["description"], definition=definition)
    db.add(w)
    await db.flush()
    job_id = None
    if body.schedule:
        try:
            job = await create_job(
                db,
                user_id=ctx.user.id,
                name=name,
                kind="workflow",
                payload={"workflow_id": w.id},
                schedule=body.schedule,
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        job_id = job.id
    await db.commit()
    if body.run_now:
        asyncio.create_task(run_workflow(user_id=ctx.user.id, name=name, definition=definition))
    return {"workflow_id": w.id, "job_id": job_id}
