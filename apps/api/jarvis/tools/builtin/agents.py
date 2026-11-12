"""Delegation to specialist agents."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from jarvis.tools.base import ToolContext, ToolInput, ToolResult, tool


class DelegateInput(ToolInput):
    agent: Literal["research", "development", "productivity"] = Field(
        description="research: web/knowledge investigation with sources; development: repositories, CI and project "
        "checks; productivity: notes, reminders, calendar and memories."
    )
    task: str = Field(min_length=5, max_length=4000, description="A self-contained description of the sub-task.")
    context: str = Field(default="", max_length=8000, description="Relevant context the specialist needs.")


@tool(
    name="delegate_task",
    title="Delegate to specialist",
    description=(
        "Hand a bounded sub-task to a specialist agent that works with its own restricted tools and returns a "
        "structured report (summary, findings, sources, confidence). Use for multi-source research, repository "
        "diagnosis or planning across notes/reminders/calendar. The specialist's actions follow the same permissions."
    ),
    input_model=DelegateInput,
    category="agents",
    risk="low",
    side_effects=False,
    default_policy="auto",
    untrusted_output=True,
    timeout_s=600,
)
async def delegate_task(args: DelegateInput, ctx: ToolContext) -> ToolResult:
    from jarvis.agents.specialists import SPECIALISTS, run_specialist

    if ctx.run_id is None:
        return ToolResult.fail("Delegation requires a run context.")
    if ctx.origin.startswith("agent:"):
        return ToolResult.fail("Specialists cannot delegate further.")
    outcome = await run_specialist(
        name=args.agent,
        task=args.task,
        context=args.context,
        user_id=ctx.user_id,
        run_id=ctx.run_id,
        client_kind=ctx.client_kind,
        tainted=False,
    )
    r = outcome.report
    data = {
        "agent": args.agent,
        "summary": r.summary,
        "findings": r.findings,
        "sources": r.sources,
        "confidence": r.confidence,
        "structured": outcome.structured,
        "steps": outcome.steps,
        "tools_used": outcome.tool_calls,
    }
    if outcome.error:
        data["error"] = outcome.error
    ok = outcome.error is None or outcome.structured
    return ToolResult(
        ok=ok,
        summary=f"{SPECIALISTS[args.agent].title}: {r.summary[:200]}",
        data=data,
        untrusted=outcome.untrusted,
        verified=outcome.structured,
        verification="Report validated against the specialist output schema."
        if outcome.structured
        else "Specialist returned unstructured text.",
    )
