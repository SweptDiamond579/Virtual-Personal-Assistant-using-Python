from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.db.models import Approval, Conversation, Feedback, Message, Run, RunStep
from jarvis.db.session import get_db
from jarvis.orchestrator import engine
from jarvis.schemas import ApprovalDTO, ChatMessageDTO, RunStepDTO, RunSummary
from jarvis.security.audit import audit
from jarvis.security.auth import SessionContext, client_ip, current_session
from jarvis.security.ratelimit import limiter
from jarvis.services import approvals
from jarvis.services.settings_store import get_setting, set_setting
from jarvis.tools.base import registry

router = APIRouter(prefix="/api", tags=["chat"])


class ChatBody(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    conversation_id: str | None = Field(default=None, max_length=32)


@router.post("/chat")
async def chat(body: ChatBody, ctx: SessionContext = Depends(current_session)) -> dict:
    if not limiter.hit(f"chat:{ctx.user.id}", limit=30, window_s=60):
        raise HTTPException(429, "too many requests")
    try:
        run, msg = await engine.start_chat(
            user_id=ctx.user.id,
            text=body.text,
            conversation_id=body.conversation_id,
            client_kind=ctx.client_kind,
            session_id=ctx.session.id,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"run": RunSummary.of(run), "message": ChatMessageDTO.model_validate(msg)}


@router.get("/conversations")
async def conversations(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> list:
    rows = (
        (
            await db.execute(
                select(Conversation)
                .where(Conversation.user_id == ctx.user.id)
                .order_by(Conversation.updated_at.desc())
                .limit(100)
            )
        )
        .scalars()
        .all()
    )
    return [{"id": c.id, "title": c.title, "updated_at": c.updated_at, "created_at": c.created_at} for c in rows]


@router.get("/conversations/{conversation_id}/messages")
async def conversation_messages(
    conversation_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> list[ChatMessageDTO]:
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != ctx.user.id:
        raise HTTPException(404, "conversation not found")
    rows = (
        (
            await db.execute(
                select(Message)
                .where(Message.conversation_id == conversation_id, Message.visible.is_(True))
                .order_by(Message.created_at)
            )
        )
        .scalars()
        .all()
    )
    return [ChatMessageDTO.model_validate(m) for m in rows]


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    conv = await db.get(Conversation, conversation_id)
    if conv is None or conv.user_id != ctx.user.id:
        raise HTTPException(404, "conversation not found")
    await db.delete(conv)
    await audit("conversation.deleted", actor=ctx.actor, target=conversation_id, db=db)
    await db.commit()
    return {"ok": True}


@router.get("/runs")
async def runs(
    ctx: SessionContext = Depends(current_session),
    db: AsyncSession = Depends(get_db),
    status: str | None = Query(default=None),
    limit: int = Query(default=50, le=200),
) -> list[RunSummary]:
    stmt = select(Run).where(Run.user_id == ctx.user.id)
    if status == "active":
        stmt = stmt.where(Run.status.in_(["queued", "running", "waiting_approval"]))
    elif status:
        stmt = stmt.where(Run.status == status)
    rows = (await db.execute(stmt.order_by(Run.created_at.desc()).limit(limit))).scalars().all()
    return [RunSummary.of(r) for r in rows]


@router.get("/runs/{run_id}")
async def run_detail(
    run_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    run = await db.get(Run, run_id)
    if run is None or run.user_id != ctx.user.id:
        raise HTTPException(404, "run not found")
    steps = (await db.execute(select(RunStep).where(RunStep.run_id == run_id).order_by(RunStep.seq))).scalars().all()
    return {
        "run": RunSummary.of(run),
        "tainted": run.tainted,
        "origin": run.origin,
        "steps": [RunStepDTO.model_validate(s) for s in steps],
    }


@router.post("/runs/{run_id}/cancel")
async def cancel(
    run_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    run = await db.get(Run, run_id)
    if run is None or run.user_id != ctx.user.id:
        raise HTTPException(404, "run not found")
    cancelled = await engine.cancel_run(run_id)
    await audit("run.cancel", actor=ctx.actor, target=run_id, details={"was_active": cancelled})
    return {"cancelled": cancelled}


class FeedbackBody(BaseModel):
    run_id: str | None = Field(default=None, max_length=32)
    message_id: str | None = Field(default=None, max_length=32)
    rating: int = Field(ge=-1, le=1)
    comment: str = Field(default="", max_length=2000)


@router.post("/feedback")
async def feedback(
    body: FeedbackBody, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    db.add(
        Feedback(
            user_id=ctx.user.id,
            run_id=body.run_id,
            message_id=body.message_id,
            rating=body.rating,
            comment=body.comment,
        )
    )
    await db.commit()
    return {"ok": True}


# --------------------------------------------------------------------------- tools


@router.get("/tools")
async def tools(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> list:
    overrides = await get_setting(db, ctx.user.id, "tool_policies") or {}
    return [{**t.describe(), "override": overrides.get(t.name)} for t in registry.all()]


class CommandBody(BaseModel):
    tool: str = Field(max_length=80)
    args: dict[str, Any] = Field(default_factory=dict)


@router.post("/commands")
async def command(body: CommandBody, ctx: SessionContext = Depends(current_session)) -> dict:
    if not limiter.hit(f"cmd:{ctx.user.id}", limit=60, window_s=60):
        raise HTTPException(429, "too many requests")
    try:
        run = await engine.run_command(user_id=ctx.user.id, tool=body.tool, args=body.args, client_kind=ctx.client_kind)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"run": RunSummary.of(run)}


class PolicyBody(BaseModel):
    policies: dict[str, str]


@router.put("/settings/tool-policies")
async def set_tool_policies(
    body: PolicyBody, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    clean: dict[str, str] = {}
    for name, value in body.policies.items():
        spec = registry.get(name)
        if spec is None or value not in ("auto", "ask", "deny", "default"):
            raise HTTPException(422, f"invalid policy for {name}")
        if value == "default":
            continue
        if value == "auto" and spec.risk in ("high", "critical"):
            raise HTTPException(422, f"{name} is {spec.risk} risk and cannot run without approval")
        clean[name] = value
    await set_setting(db, ctx.user.id, "tool_policies", clean)
    await audit("policy.updated", actor=ctx.actor, details={"policies": clean}, db=db)
    await db.commit()
    return {"policies": clean}


# --------------------------------------------------------------------------- approvals


@router.get("/approvals")
async def list_approvals(
    ctx: SessionContext = Depends(current_session),
    db: AsyncSession = Depends(get_db),
    status: str | None = Query(default=None),
) -> list[ApprovalDTO]:
    stmt = select(Approval).where(Approval.user_id == ctx.user.id)
    if status:
        stmt = stmt.where(Approval.status == status)
    rows = (await db.execute(stmt.order_by(Approval.requested_at.desc()).limit(100))).scalars().all()
    return [approvals.to_dto(a) for a in rows]


class DecisionBody(BaseModel):
    approve: bool


@router.post("/approvals/{approval_id}/decision")
async def decide_approval(
    approval_id: str, body: DecisionBody, request: Request, request_ctx: SessionContext = Depends(current_session)
) -> ApprovalDTO:
    try:
        a = await approvals.decide(
            approval_id,
            user_id=request_ctx.user.id,
            approve=body.approve,
            session_id=request_ctx.session.id,
            client_kind=request_ctx.client_kind,
            ip=client_ip(request),
        )
    except approvals.ApprovalError as exc:
        raise HTTPException(409, str(exc)) from exc
    return approvals.to_dto(a)
