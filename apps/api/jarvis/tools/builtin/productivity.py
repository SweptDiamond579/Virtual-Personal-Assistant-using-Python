"""Notes, reminders, memory proposals, research findings and email drafts."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from pydantic import EmailStr, Field, HttpUrl, model_validator
from sqlalchemy import or_, select

from jarvis.db.models import EmailDraft, Finding, Memory, Note
from jarvis.db.session import db_session
from jarvis.memory import service as memory
from jarvis.realtime.hub import hub
from jarvis.schemas import MemoryDTO
from jarvis.tools.base import ToolContext, ToolInput, ToolResult, tool
from jarvis.workflows.jobs import create_job


class NoteInput(ToolInput):
    title: str = Field(min_length=1, max_length=200)
    body: str = Field(default="", max_length=20000)
    tags: list[str] = Field(default_factory=list, max_length=10)


@tool(
    name="notes_create",
    title="Create note",
    description="Save a note for the user (title, body, optional tags). Visible in the Personal Assistant workspace.",
    input_model=NoteInput,
    category="productivity",
    risk="low",
    side_effects=True,
    default_policy="auto",
)
async def notes_create(args: NoteInput, ctx: ToolContext) -> ToolResult:
    async with db_session() as db:
        note = Note(user_id=ctx.user_id, title=args.title, body=args.body, tags=args.tags, created_by="jarvis")
        db.add(note)
        await db.commit()
        saved = await db.get(Note, note.id)  # verify persistence
    ok = saved is not None and saved.title == args.title
    return ToolResult(
        ok=ok,
        summary=f"Saved note “{args.title}”.",
        data={"note_id": note.id},
        verified=ok,
        verification="Note re-read from the database after saving.",
    )


class SearchInput(ToolInput):
    query: str = Field(default="", max_length=200)
    limit: int = Field(default=10, ge=1, le=50)


@tool(
    name="notes_search",
    title="Search notes",
    description="Search the user's notes by keyword (empty query lists the most recent).",
    input_model=SearchInput,
    category="productivity",
    risk="read_only",
    side_effects=False,
    default_policy="auto",
    retryable=True,
)
async def notes_search(args: SearchInput, ctx: ToolContext) -> ToolResult:
    async with db_session() as db:
        stmt = select(Note).where(Note.user_id == ctx.user_id)
        if args.query:
            like = f"%{args.query}%"
            stmt = stmt.where(or_(Note.title.ilike(like), Note.body.ilike(like)))
        notes = (await db.execute(stmt.order_by(Note.updated_at.desc()).limit(args.limit))).scalars().all()
    items = [
        {"id": n.id, "title": n.title, "body": n.body[:500], "updated_at": n.updated_at.isoformat()} for n in notes
    ]
    return ToolResult(ok=True, summary=f"Found {len(items)} note(s).", data={"notes": items})


class ReminderInput(ToolInput):
    text: str = Field(min_length=1, max_length=300)
    in_minutes: int | None = Field(default=None, ge=1, le=60 * 24 * 365)
    at: datetime | None = Field(default=None, description="Absolute time (ISO 8601 with timezone).")

    @model_validator(mode="after")
    def _one_of(self) -> ReminderInput:
        if (self.in_minutes is None) == (self.at is None):
            raise ValueError("provide exactly one of in_minutes or at")
        return self


@tool(
    name="reminder_create",
    title="Create reminder",
    description="Schedule a one-off reminder notification, either in N minutes or at an absolute time.",
    input_model=ReminderInput,
    category="productivity",
    risk="low",
    side_effects=True,
    default_policy="auto",
)
async def reminder_create(args: ReminderInput, ctx: ToolContext) -> ToolResult:
    when = args.at or datetime.now(UTC) + timedelta(minutes=args.in_minutes or 0)
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    if when <= datetime.now(UTC):
        return ToolResult.fail("Reminder time is in the past.")
    async with db_session() as db:
        job = await create_job(
            db,
            user_id=ctx.user_id,
            name=f"Reminder: {args.text}",
            kind="reminder",
            run_at=when,
            payload={"text": args.text},
        )
        await db.commit()
    return ToolResult(
        ok=True,
        summary=f"Reminder set for {when.strftime('%Y-%m-%d %H:%M UTC')}.",
        data={"job_id": job.id, "run_at": when.isoformat()},
        verified=True,
        verification="Scheduled job persisted; the scheduler will deliver it.",
    )


class MemoryProposeInput(ToolInput):
    content: str = Field(min_length=3, max_length=2000)
    kind: str = Field(default="fact", pattern="^(preference|fact|project|note)$")
    confidence: float = Field(default=0.7, ge=0.0, le=1.0)


@tool(
    name="memory_propose",
    title="Propose memory",
    description=(
        "Propose a long-term memory about the user (a stable preference, fact or project detail). "
        "It is NOT saved until the user approves it in the Memory Centre. Never propose secrets or credentials."
    ),
    input_model=MemoryProposeInput,
    category="memory",
    risk="low",
    side_effects=True,
    default_policy="auto",
)
async def memory_propose(args: MemoryProposeInput, ctx: ToolContext) -> ToolResult:
    async with db_session() as db:
        try:
            mem = await memory.propose(
                db,
                user_id=ctx.user_id,
                content=args.content,
                kind=args.kind,
                source="agent",
                provenance={"run_id": ctx.run_id, "origin": ctx.origin},
                confidence=args.confidence,
            )
        except memory.SensitiveContentError as exc:
            return ToolResult.fail(str(exc))
        await db.commit()
        dto = MemoryDTO.model_validate(mem)
    hub.publish(ctx.user_id, "memory.proposed", {"memory": dto}, run_id=ctx.run_id)
    note = " It may conflict with an existing memory." if dto.conflicts_with else ""
    return ToolResult(ok=True, summary=f"Proposed memory awaiting user approval.{note}", data={"memory_id": mem.id})


class MemorySearchInput(ToolInput):
    query: str = Field(min_length=1, max_length=300)


@tool(
    name="memory_search",
    title="Search memory",
    description="Search the user's approved long-term memories.",
    input_model=MemorySearchInput,
    category="memory",
    risk="read_only",
    side_effects=False,
    default_policy="auto",
    retryable=True,
)
async def memory_search(args: MemorySearchInput, ctx: ToolContext) -> ToolResult:
    async with db_session() as db:
        found = await memory.search(db, ctx.user_id, args.query, for_model=True)
        await db.commit()
    items = [
        {"id": s.memory.id, "kind": s.memory.kind, "content": s.memory.content, "score": round(s.score, 3)}
        for s in found
    ]
    return ToolResult(ok=True, summary=f"{len(items)} relevant memories.", data={"memories": items})


class SourceRef(ToolInput):
    title: str = Field(max_length=300)
    url: HttpUrl | None = None


class FindingInput(ToolInput):
    title: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=10000)
    sources: list[SourceRef] = Field(default_factory=list, max_length=20)


@tool(
    name="findings_save",
    title="Save research finding",
    description="Save a research finding with its evidence sources to the Intelligence workspace.",
    input_model=FindingInput,
    category="research",
    risk="low",
    side_effects=True,
    default_policy="auto",
)
async def findings_save(args: FindingInput, ctx: ToolContext) -> ToolResult:
    async with db_session() as db:
        f = Finding(
            user_id=ctx.user_id,
            title=args.title,
            summary=args.summary,
            run_id=ctx.run_id,
            sources=[{"title": s.title, "url": str(s.url) if s.url else None} for s in args.sources],
        )
        db.add(f)
        await db.commit()
    return ToolResult(ok=True, summary=f"Saved finding “{args.title}”.", data={"finding_id": f.id}, verified=True)


class EmailDraftInput(ToolInput):
    to: EmailStr
    subject: str = Field(min_length=1, max_length=300)
    body: str = Field(min_length=1, max_length=20000)


@tool(
    name="email_draft",
    title="Draft email",
    description="Prepare an email draft for the user to review. Does NOT send anything.",
    input_model=EmailDraftInput,
    category="communication",
    risk="low",
    side_effects=True,
    default_policy="auto",
)
async def email_draft(args: EmailDraftInput, ctx: ToolContext) -> ToolResult:
    async with db_session() as db:
        d = EmailDraft(user_id=ctx.user_id, to=str(args.to), subject=args.subject, body=args.body)
        db.add(d)
        await db.commit()
    return ToolResult(ok=True, summary=f"Draft to {args.to} saved for review (not sent).", data={"draft_id": d.id})


class EmailSendInput(ToolInput):
    draft_id: str = Field(min_length=8, max_length=32)


@tool(
    name="email_send",
    title="Send email",
    description="Send a previously prepared email draft via the configured SMTP account. Requires approval.",
    input_model=EmailSendInput,
    category="communication",
    risk="high",
    side_effects=True,
    default_policy="ask",
    requires={"smtp"},
    timeout_s=45,
)
async def email_send(args: EmailSendInput, ctx: ToolContext) -> ToolResult:
    from jarvis.integrations.smtp import send_draft

    return await send_draft(ctx.user_id, args.draft_id)


# Keep Memory imported for type checkers that resolve forward references in DTOs.
_ = Memory


class UpcomingInput(ToolInput):
    hours: int = Field(default=24, ge=1, le=24 * 30)


@tool(
    name="reminders_upcoming",
    title="Upcoming reminders",
    description="List reminders and scheduled jobs due within the next N hours.",
    input_model=UpcomingInput,
    category="productivity",
    risk="read_only",
    side_effects=False,
    default_policy="auto",
    retryable=True,
)
async def reminders_upcoming(args: UpcomingInput, ctx: ToolContext) -> ToolResult:
    from jarvis.db.models import ScheduledJob

    horizon = datetime.now(UTC) + timedelta(hours=args.hours)
    async with db_session() as db:
        jobs = (
            (
                await db.execute(
                    select(ScheduledJob)
                    .where(
                        ScheduledJob.user_id == ctx.user_id,
                        ScheduledJob.enabled.is_(True),
                        ScheduledJob.next_run_at.is_not(None),
                        ScheduledJob.next_run_at <= horizon,
                    )
                    .order_by(ScheduledJob.next_run_at)
                    .limit(25)
                )
            )
            .scalars()
            .all()
        )
    items = [{"name": j.name, "kind": j.kind, "at": j.next_run_at.isoformat() if j.next_run_at else None} for j in jobs]
    summary = ", ".join(f"{i['name']} at {i['at'][11:16]} UTC" for i in items) if items else "none due"
    return ToolResult(ok=True, summary=summary, data={"items": items})
