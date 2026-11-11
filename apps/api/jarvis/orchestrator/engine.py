"""JARVIS orchestrator: runs conversations, direct commands and agent tasks.

Agent loop per chat run:
  retrieve memories -> build append-only history -> stream model turn
  -> persist assistant blocks + usage -> execute tool calls through the executor
  -> feed results back -> repeat until the model stops, the step budget is hit,
  the daily cost budget is exhausted, or the run is cancelled.

Conversation history is append-only and the system prompt / tool set are fixed
per conversation (required to keep Claude's thinking blocks valid and the
prompt cache warm — see docs/DECISIONS.md D-004).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, time, timedelta
from typing import Any

from sqlalchemy import func, select, update

from jarvis.config import get_settings
from jarvis.db.models import Approval, Conversation, Message, Run, UsageRecord
from jarvis.db.session import db_session
from jarvis.logging import get_logger
from jarvis.memory import service as memory
from jarvis.orchestrator.executor import (
    execute_tool_call,
    finish_step,
    record_step,
    result_for_model,
    set_run_status,
)
from jarvis.orchestrator.prompts import SYSTEM_PROMPT, context_preamble
from jarvis.providers import build_provider, estimate_cost, route_model
from jarvis.providers.base import (
    ProviderError,
    ProviderMessage,
    TextDelta,
    ToolSchema,
    TurnComplete,
    TurnRequest,
)
from jarvis.realtime.hub import hub
from jarvis.schemas import ChatMessageDTO, RunSummary
from jarvis.services import approvals
from jarvis.services.settings_store import emergency_stop_active, get_setting
from jarvis.tools.base import registry

log = get_logger("orchestrator")

_tasks: dict[str, asyncio.Task[None]] = {}


class BudgetExceeded(Exception):
    pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def tool_schemas() -> list[ToolSchema]:
    # Always the full, name-sorted set: the tool list must not change within a conversation.
    return [ToolSchema(t.name, t.description, t.input_schema()) for t in registry.all()]


async def spent_today(user_id: str) -> float:
    start = datetime.combine(datetime.now(UTC).date(), time.min, tzinfo=UTC)
    async with db_session() as db:
        total = (
            await db.execute(
                select(func.coalesce(func.sum(UsageRecord.cost_usd), 0.0)).where(
                    UsageRecord.user_id == user_id, UsageRecord.ts >= start
                )
            )
        ).scalar()
    return float(total or 0.0)


async def daily_budget(user_id: str) -> float:
    async with db_session() as db:
        b = await get_setting(db, user_id, "budget")
    override = (b or {}).get("daily_usd")
    return float(override) if override is not None else get_settings().jarvis_daily_budget_usd


async def _publish_run(run: Run, type_: str = "run.updated") -> None:
    hub.publish(run.user_id, type_, {"run": RunSummary.of(run)}, run_id=run.id, conversation_id=run.conversation_id)


async def _record_usage(run_id: str, user_id: str, provider: str, turn: TurnComplete) -> None:
    u = turn.usage
    cost = estimate_cost(turn.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens)
    async with db_session() as db:
        db.add(
            UsageRecord(
                user_id=user_id,
                run_id=run_id,
                provider=provider,
                model=turn.model,
                input_tokens=u.input_tokens,
                output_tokens=u.output_tokens,
                cache_read_tokens=u.cache_read_tokens,
                cache_write_tokens=u.cache_write_tokens,
                cost_usd=cost,
            )
        )
        run = await db.get(Run, run_id)
        assert run is not None
        run.input_tokens += u.input_tokens
        run.output_tokens += u.output_tokens
        run.cache_read_tokens += u.cache_read_tokens
        run.cost_usd += cost
        run.model = turn.model
        await db.commit()
        await _publish_run(run)


async def _load_history(conversation_id: str) -> list[ProviderMessage]:
    async with db_session() as db:
        rows = (
            (
                await db.execute(
                    select(Message).where(Message.conversation_id == conversation_id).order_by(Message.created_at)
                )
            )
            .scalars()
            .all()
        )
    history: list[ProviderMessage] = []
    for msg in rows:
        if not msg.blocks:
            continue  # display-only rows
        role = "assistant" if msg.role == "assistant" else "user"
        history.append(ProviderMessage(role=role, blocks=list(msg.blocks)))
    return history


async def _append_message(
    conversation_id: str,
    role: str,
    blocks: list[dict[str, Any]],
    *,
    run_id: str,
    content: str = "",
    visible: bool = False,
) -> Message:
    async with db_session() as db:
        msg = Message(
            conversation_id=conversation_id, role=role, blocks=blocks, run_id=run_id, content=content, visible=visible
        )
        db.add(msg)
        await db.execute(
            update(Conversation).where(Conversation.id == conversation_id).values(updated_at=datetime.now(UTC))
        )
        await db.commit()
        await db.refresh(msg)
        return msg


async def _repair_dangling_tool_calls(conversation_id: str, run_id: str) -> None:
    """If a previous run stopped between a tool call and its result, append error results.

    Appending (never editing) keeps the history valid for the provider.
    """
    history = await _load_history(conversation_id)
    if not history or history[-1].role != "assistant":
        return
    calls = [b for b in history[-1].blocks if b.get("type") == "tool_call"]
    if calls:
        await _append_message(
            conversation_id,
            "tool",
            [
                {
                    "type": "tool_result",
                    "tool_call_id": c["id"],
                    "is_error": True,
                    "content": "Not executed: the previous run was interrupted before this tool ran.",
                }
                for c in calls
            ],
            run_id=run_id,
        )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def start_chat(
    *, user_id: str, text: str, conversation_id: str | None, client_kind: str, session_id: str | None
) -> tuple[Run, Message]:
    text = text.strip()
    async with db_session() as db:
        if conversation_id:
            conv = await db.get(Conversation, conversation_id)
            if conv is None or conv.user_id != user_id:
                raise LookupError("conversation not found")
        else:
            conv = Conversation(user_id=user_id, title=text[:80] or "New conversation")
            db.add(conv)
            await db.flush()
        provider = build_provider()
        run = Run(
            user_id=user_id,
            conversation_id=conv.id,
            kind="chat",
            status="queued",
            title=text[:120],
            provider=provider.name if provider else None,
            origin="user",
        )
        db.add(run)
        await db.flush()
        # The visible user message (display text). The model-facing user turn, with context, is
        # appended by the run once memories are retrieved.
        user_msg = Message(conversation_id=conv.id, role="user", content=text, blocks=[], run_id=run.id, visible=True)
        db.add(user_msg)
        conv.updated_at = datetime.now(UTC)
        await db.commit()
        await db.refresh(run)
        await db.refresh(user_msg)
    hub.publish(
        user_id,
        "message.created",
        {"message": ChatMessageDTO.model_validate(user_msg)},
        run_id=run.id,
        conversation_id=conv.id,
    )
    await _publish_run(run, "run.started")
    _spawn(run.id, _run_chat(run.id, text, client_kind))
    return run, user_msg


async def run_agent_task(*, user_id: str, prompt: str, title: str, origin: str = "scheduler") -> Run:
    """Start an unattended agent run in its own conversation (used by scheduled jobs)."""
    async with db_session() as db:
        conv = Conversation(user_id=user_id, title=f"⏱ {title}"[:200])
        db.add(conv)
        await db.flush()
        provider = build_provider()
        run = Run(
            user_id=user_id,
            conversation_id=conv.id,
            kind="scheduled",
            status="queued",
            title=title[:120],
            provider=provider.name if provider else None,
            origin=origin,
        )
        db.add(run)
        db.add(Message(conversation_id=conv.id, role="user", content=prompt, blocks=[], run_id=run.id))
        await db.commit()
        await db.refresh(run)
    await _publish_run(run, "run.started")
    _spawn(run.id, _run_chat(run.id, prompt, None, origin=origin))
    return run


async def run_command(*, user_id: str, tool: str, args: dict[str, Any], client_kind: str) -> Run:
    """Direct tool invocation from the command bar — no model, same permission path."""
    spec = registry.get(tool)
    if spec is None:
        raise LookupError(f"unknown tool {tool}")
    async with db_session() as db:
        run = Run(user_id=user_id, kind="command", status="queued", title=f"/{tool}", origin="command")
        db.add(run)
        await db.commit()
        await db.refresh(run)
    await _publish_run(run, "run.started")
    _spawn(run.id, _run_command(run.id, user_id, tool, args, client_kind))
    return run


def _spawn(run_id: str, coro: Any) -> None:
    task = asyncio.create_task(coro, name=f"run-{run_id}")
    _tasks[run_id] = task
    task.add_done_callback(lambda _t: _tasks.pop(run_id, None))


async def cancel_run(run_id: str) -> bool:
    task = _tasks.get(run_id)
    await approvals.cancel_for_run(run_id)
    if task is None:
        return False
    task.cancel()
    return True


async def cancel_all(user_id: str) -> int:
    async with db_session() as db:
        ids = (
            (
                await db.execute(
                    select(Run.id).where(
                        Run.user_id == user_id, Run.status.in_(["queued", "running", "waiting_approval"])
                    )
                )
            )
            .scalars()
            .all()
        )
    n = 0
    for rid in ids:
        if await cancel_run(rid):
            n += 1
    return n


async def wait_for_run(run_id: str, timeout: float = 30.0) -> None:
    task = _tasks.get(run_id)
    if task is not None:
        await asyncio.wait_for(asyncio.shield(task), timeout=timeout)


async def recover_interrupted() -> None:
    """After a restart, nothing that was in flight is resumed or repeated automatically."""
    async with db_session() as db:
        now = datetime.now(UTC)
        await db.execute(
            update(Run)
            .where(Run.status.in_(["queued", "running", "waiting_approval"]))
            .values(
                status="failed", error="Interrupted by a server restart; not retried automatically.", finished_at=now
            )
        )
        await db.execute(update(Approval).where(Approval.status == "pending").values(status="expired", decided_at=now))
        await db.commit()


# ---------------------------------------------------------------------------
# Run bodies
# ---------------------------------------------------------------------------


async def _mark_started(run_id: str, *, provider: str | None, model: str | None) -> Run:
    async with db_session() as db:
        run = await db.get(Run, run_id)
        assert run is not None
        run.status = "running"
        run.started_at = datetime.now(UTC)
        run.provider = provider
        run.model = model
        await db.commit()
        await _publish_run(run)
        return run


async def _finish(run_id: str, status: str, error: str | None = None) -> None:
    await set_run_status(run_id, status, error=error)


async def _run_command(run_id: str, user_id: str, tool: str, args: dict[str, Any], client_kind: str) -> None:
    await _mark_started(run_id, provider=None, model=None)
    try:
        outcome = await execute_tool_call(
            user_id=user_id,
            run_id=run_id,
            conversation_id=None,
            tool_name=tool,
            raw_args=args,
            origin="command",
            client_kind=client_kind,
            tainted=False,
        )
        if outcome.result.ok:
            await _finish(run_id, "succeeded")
        else:
            await _finish(run_id, "failed", outcome.result.summary)
    except asyncio.CancelledError:
        await _finish(run_id, "cancelled", "Cancelled by user.")
    except Exception as exc:
        log.exception("command run failed")
        await _finish(run_id, "failed", f"Internal error: {type(exc).__name__}")


async def _run_chat(run_id: str, text: str, client_kind: str | None, origin: str = "user") -> None:
    settings = get_settings()
    async with db_session() as db:
        run = await db.get(Run, run_id)
        assert run is not None
        user_id, conversation_id = run.user_id, run.conversation_id
    assert conversation_id is not None
    display_id_holder: dict[str, str] = {}
    display_parts: list[str] = []

    async def flush_display() -> None:
        text_out = "".join(display_parts).strip()
        if not text_out:
            return
        msg = await _append_message(conversation_id, "assistant", [], run_id=run_id, content=text_out, visible=True)
        hub.publish(
            user_id,
            "assistant.completed",
            {"message": ChatMessageDTO.model_validate(msg)},
            run_id=run_id,
            conversation_id=conversation_id,
        )

    provider = build_provider()
    if provider is None:
        await _mark_started(run_id, provider=None, model=None)
        display_parts.append(
            "No AI model is configured, so I can't interpret free-form requests yet. "
            "Add an ANTHROPIC_API_KEY (or an OpenAI-compatible endpoint) to the server environment and restart. "
            "Meanwhile, direct commands in the command bar (Ctrl/⌘+K) still work."
        )
        display_id_holder["id"] = f"stream-{run_id}"
        await flush_display()
        await _finish(run_id, "failed", "AI provider not configured")
        return

    route = route_model(provider, text)
    await _mark_started(run_id, provider=provider.name, model=route.model)
    display_id_holder["id"] = f"stream-{run_id}"
    tainted = False

    try:
        # 1. Memory retrieval -> context preamble, persisted with the user turn (append-only history).
        async with db_session() as db:
            found = await memory.search(db, user_id, text, for_model=True, limit=6)
            tz = await get_setting(db, user_id, "timezone")
            await db.commit()
        if found:
            hub.publish(
                user_id,
                "memory.used",
                {"memory_ids": [s.memory.id for s in found]},
                run_id=run_id,
                conversation_id=conversation_id,
            )
        preamble = context_preamble(
            now=datetime.now(UTC),
            timezone=tz or "UTC",
            memories=[(s.memory.kind, s.memory.content) for s in found],
            origin=origin,
        )
        await _repair_dangling_tool_calls(conversation_id, run_id)
        await _append_message(
            conversation_id,
            "user",
            [{"type": "text", "text": preamble}, {"type": "text", "text": text}],
            run_id=run_id,
        )

        tools = tool_schemas()
        for step_index in range(settings.jarvis_max_steps_per_run):
            if emergency_stop_active(user_id):
                raise asyncio.CancelledError
            budget = await daily_budget(user_id)
            if await spent_today(user_id) >= budget:
                raise BudgetExceeded(f"Daily AI budget of ${budget:.2f} reached.")

            history = await _load_history(conversation_id)
            model_step = await record_step(
                run_id, kind="model_call", name=route.model, summary=f"Model turn {step_index + 1} ({route.reason})"
            )
            turn: TurnComplete | None = None
            try:
                async for ev in provider.stream_turn(
                    TurnRequest(
                        system=SYSTEM_PROMPT,
                        messages=history,
                        tools=tools,
                        model=route.model,
                        max_tokens=settings.jarvis_max_output_tokens,
                        effort=route.effort,
                    )
                ):
                    if isinstance(ev, TextDelta):
                        display_parts.append(ev.text)
                        hub.publish(
                            user_id,
                            "assistant.delta",
                            {"message_id": display_id_holder["id"], "text": ev.text},
                            run_id=run_id,
                            conversation_id=conversation_id,
                        )
                    else:
                        turn = ev
            except ProviderError as exc:
                await finish_step(model_step.id, status="failed", error=f"{exc.kind}: {exc}")
                raise
            assert turn is not None
            await _record_usage(run_id, user_id, provider.name, turn)
            await finish_step(
                model_step.id,
                status="succeeded",
                summary=f"{turn.stop_reason}; {len(turn.tool_calls)} tool call(s)",
                output={"stop_reason": turn.stop_reason, "usage": turn.usage.__dict__, "notes": turn.notes},
            )
            await _append_message(conversation_id, "assistant", turn.blocks, run_id=run_id)

            if "refusal" in turn.notes:
                display_parts.append("\n\nI can't help with that request.")
            if not turn.tool_calls:
                await flush_display()
                await _finish(run_id, "succeeded")
                return

            display_parts.append("\n\n")
            results: list[dict[str, Any]] = []
            for call in turn.tool_calls:
                outcome = await execute_tool_call(
                    user_id=user_id,
                    run_id=run_id,
                    conversation_id=conversation_id,
                    tool_name=call.name,
                    raw_args=call.input,
                    origin=origin,
                    client_kind=client_kind,
                    tainted=tainted,
                )
                if outcome.result.untrusted:
                    tainted = True
                    async with db_session() as db:
                        await db.execute(update(Run).where(Run.id == run_id).values(tainted=True))
                        await db.commit()
                content, is_error = result_for_model(call.name, outcome)
                results.append(
                    {"type": "tool_result", "tool_call_id": call.id, "content": content, "is_error": is_error}
                )
            # All results of one assistant turn go back in a single user message.
            await _append_message(conversation_id, "tool", results, run_id=run_id)

        display_parts.append(
            f"\n\nI stopped after {settings.jarvis_max_steps_per_run} steps (the per-run step limit) "
            "before finishing. You can ask me to continue."
        )
        await flush_display()
        await _finish(run_id, "failed", "Step limit reached")
    except asyncio.CancelledError:
        display_parts.append("\n\n[Run cancelled.]")
        await flush_display()
        await approvals.cancel_for_run(run_id)
        await _finish(run_id, "cancelled", "Cancelled.")
    except BudgetExceeded as exc:
        display_parts.append(f"\n\n{exc} Raise it in Settings → AI to continue today.")
        await flush_display()
        await _finish(run_id, "failed", str(exc))
    except ProviderError as exc:
        display_parts.append(f"\n\nThe AI provider returned an error: {exc}")
        await flush_display()
        await _finish(run_id, "failed", f"{exc.kind}: {exc}")
    except Exception as exc:
        log.exception("chat run crashed", run_id=run_id)
        display_parts.append("\n\nSomething went wrong inside JARVIS; the error has been logged.")
        await flush_display()
        await _finish(run_id, "failed", f"Internal error: {type(exc).__name__}: {exc}")


__all__ = [
    "cancel_all",
    "cancel_run",
    "recover_interrupted",
    "run_agent_task",
    "run_command",
    "start_chat",
    "wait_for_run",
    "timedelta",
]
