"""Memory Centre, notes, research findings and email drafts."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.db.models import EmailDraft, Finding, Memory, Note
from jarvis.db.session import get_db
from jarvis.memory import service as memory
from jarvis.memory.embeddings import embed_text, get_embedder
from jarvis.schemas import MemoryDTO
from jarvis.security.audit import audit
from jarvis.security.auth import SessionContext, current_session

router = APIRouter(prefix="/api", tags=["knowledge"])

MemoryKind = Literal["preference", "fact", "project", "note"]


async def _own_memory(db: AsyncSession, memory_id: str, user_id: str) -> Memory:
    m = await db.get(Memory, memory_id)
    if m is None or m.user_id != user_id:
        raise HTTPException(404, "memory not found")
    return m


@router.get("/memories")
async def list_memories(
    ctx: SessionContext = Depends(current_session),
    db: AsyncSession = Depends(get_db),
    q: str = Query(default="", max_length=300),
    status: str | None = Query(default=None),
) -> list[dict]:
    if q:
        found = await memory.search(db, ctx.user.id, q, limit=50, include_proposed=True, min_score=0.05)
        return [
            {**MemoryDTO.model_validate(s.memory).model_dump(mode="json"), "score": round(s.score, 3)}
            for s in found
            if status is None or s.memory.status == status
        ]
    stmt = select(Memory).where(Memory.user_id == ctx.user.id)
    if status:
        stmt = stmt.where(Memory.status == status)
    rows = (await db.execute(stmt.order_by(Memory.updated_at.desc()).limit(500))).scalars().all()
    return [MemoryDTO.model_validate(m).model_dump(mode="json") for m in rows]


class MemoryCreate(BaseModel):
    content: str = Field(min_length=1, max_length=2000)
    kind: MemoryKind = "fact"
    share_with_model: bool = True
    expires_at: datetime | None = None


@router.post("/memories")
async def create_memory(
    body: MemoryCreate, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> MemoryDTO:
    m = await memory.propose(
        db,
        user_id=ctx.user.id,
        content=body.content,
        kind=body.kind,
        source="user",
        provenance={"created_by": "user", "session": ctx.session.id},
        confidence=1.0,
        active=True,
        share_with_model=body.share_with_model,
    )
    m.expires_at = body.expires_at
    await audit("memory.created", actor=ctx.actor, target=m.id, db=db)
    await db.commit()
    return MemoryDTO.model_validate(m)


class MemoryPatch(BaseModel):
    content: str | None = Field(default=None, min_length=1, max_length=2000)
    kind: MemoryKind | None = None
    share_with_model: bool | None = None
    expires_at: datetime | None = None
    clear_expiry: bool = False


@router.patch("/memories/{memory_id}")
async def update_memory(
    memory_id: str,
    body: MemoryPatch,
    ctx: SessionContext = Depends(current_session),
    db: AsyncSession = Depends(get_db),
) -> MemoryDTO:
    m = await _own_memory(db, memory_id, ctx.user.id)
    if body.content is not None:
        m.content = body.content
        m.embedding, m.embedder = await embed_text(body.content)
        m.provenance = {**m.provenance, "edited_by_user": datetime.now(UTC).isoformat()}
    if body.kind is not None:
        m.kind = body.kind
    if body.share_with_model is not None:
        m.share_with_model = body.share_with_model
    if body.clear_expiry:
        m.expires_at = None
    elif body.expires_at is not None:
        m.expires_at = body.expires_at
    m.updated_at = datetime.now(UTC)
    await audit("memory.updated", actor=ctx.actor, target=m.id, db=db)
    await db.commit()
    return MemoryDTO.model_validate(m)


class ApproveBody(BaseModel):
    supersede: bool = False


@router.post("/memories/{memory_id}/approve")
async def approve_memory(
    memory_id: str,
    body: ApproveBody,
    ctx: SessionContext = Depends(current_session),
    db: AsyncSession = Depends(get_db),
) -> MemoryDTO:
    m = await _own_memory(db, memory_id, ctx.user.id)
    if m.status != "proposed":
        raise HTTPException(409, f"memory is {m.status}")
    await memory.approve(db, m, supersede=body.supersede)
    await audit("memory.approved", actor=ctx.actor, target=m.id, details={"supersede": body.supersede}, db=db)
    await db.commit()
    return MemoryDTO.model_validate(m)


@router.post("/memories/{memory_id}/archive")
async def archive_memory(
    memory_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> MemoryDTO:
    m = await _own_memory(db, memory_id, ctx.user.id)
    m.status = "archived"
    m.updated_at = datetime.now(UTC)
    await db.commit()
    return MemoryDTO.model_validate(m)


@router.delete("/memories/{memory_id}")
async def delete_memory(
    memory_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    m = await _own_memory(db, memory_id, ctx.user.id)
    await db.delete(m)
    await audit("memory.deleted", actor=ctx.actor, target=memory_id, db=db)
    await db.commit()
    return {"ok": True}


@router.delete("/memories")
async def delete_all_memories(
    confirm: str = Query(...), ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    if confirm != "DELETE ALL":
        raise HTTPException(400, "confirmation phrase mismatch")
    res = await db.execute(delete(Memory).where(Memory.user_id == ctx.user.id))
    await audit("memory.deleted_all", actor=ctx.actor, details={"count": res.rowcount}, db=db)
    await db.commit()
    return {"deleted": res.rowcount}


# --------------------------------------------------------------------------- notes


class NoteBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=20000)
    tags: list[str] = Field(default_factory=list, max_length=10)


@router.get("/notes")
async def list_notes(
    ctx: SessionContext = Depends(current_session),
    db: AsyncSession = Depends(get_db),
    q: str = Query(default="", max_length=200),
) -> list[dict]:
    stmt = select(Note).where(Note.user_id == ctx.user.id)
    if q:
        stmt = stmt.where(or_(Note.title.ilike(f"%{q}%"), Note.body.ilike(f"%{q}%")))
    rows = (await db.execute(stmt.order_by(Note.updated_at.desc()).limit(200))).scalars().all()
    return [
        {
            "id": n.id,
            "title": n.title,
            "body": n.body,
            "tags": n.tags,
            "created_by": n.created_by,
            "created_at": n.created_at,
            "updated_at": n.updated_at,
        }
        for n in rows
    ]


@router.post("/notes")
async def create_note(
    body: NoteBody, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    n = Note(user_id=ctx.user.id, title=body.title, body=body.body, tags=body.tags, created_by="user")
    db.add(n)
    await db.commit()
    return {"id": n.id}


@router.delete("/notes/{note_id}")
async def delete_note(
    note_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    n = await db.get(Note, note_id)
    if n is None or n.user_id != ctx.user.id:
        raise HTTPException(404, "note not found")
    await db.delete(n)
    await db.commit()
    return {"ok": True}


@router.get("/findings")
async def list_findings(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> list:
    rows = (
        (
            await db.execute(
                select(Finding).where(Finding.user_id == ctx.user.id).order_by(Finding.created_at.desc()).limit(200)
            )
        )
        .scalars()
        .all()
    )
    return [
        {
            "id": f.id,
            "title": f.title,
            "summary": f.summary,
            "sources": f.sources,
            "run_id": f.run_id,
            "created_at": f.created_at,
        }
        for f in rows
    ]


@router.delete("/findings/{finding_id}")
async def delete_finding(
    finding_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    f = await db.get(Finding, finding_id)
    if f is None or f.user_id != ctx.user.id:
        raise HTTPException(404, "finding not found")
    await db.delete(f)
    await db.commit()
    return {"ok": True}


@router.get("/drafts")
async def list_drafts(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> list:
    rows = (
        (
            await db.execute(
                select(EmailDraft)
                .where(EmailDraft.user_id == ctx.user.id)
                .order_by(EmailDraft.created_at.desc())
                .limit(100)
            )
        )
        .scalars()
        .all()
    )
    return [
        {
            "id": d.id,
            "to": d.to,
            "subject": d.subject,
            "body": d.body,
            "status": d.status,
            "error": d.error,
            "created_at": d.created_at,
            "sent_at": d.sent_at,
        }
        for d in rows
    ]


@router.delete("/drafts/{draft_id}")
async def delete_draft(
    draft_id: str, ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)
) -> dict:
    d = await db.get(EmailDraft, draft_id)
    if d is None or d.user_id != ctx.user.id:
        raise HTTPException(404, "draft not found")
    await db.delete(d)
    await db.commit()
    return {"ok": True}


@router.get("/memories/embeddings/status")
async def embedding_status(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> dict:
    from sqlalchemy import func

    active = get_embedder().name
    rows = (
        await db.execute(
            select(Memory.embedder, func.count()).where(Memory.user_id == ctx.user.id).group_by(Memory.embedder)
        )
    ).all()
    counts = {name or "none": n for name, n in rows}
    return {"active": active, "counts": counts, "stale": sum(n for name, n in counts.items() if name != active)}


@router.post("/memories/embeddings/reembed")
async def reembed(ctx: SessionContext = Depends(current_session), db: AsyncSession = Depends(get_db)) -> dict:
    n = await memory.reembed_all(db, ctx.user.id)
    await audit("memory.reembedded", actor=ctx.actor, details={"count": n, "embedder": get_embedder().name}, db=db)
    await db.commit()
    return {"reembedded": n, "embedder": get_embedder().name}
