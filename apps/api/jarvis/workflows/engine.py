"""Bounded multi-step workflows.

Definition format:
{
  "steps": [
    {"id": "time", "tool": "get_current_time", "args": {}},
    {"id": "repo", "tool": "github_repo_overview", "args": {"repo": "owner/name"},
     "depends_on": ["time"], "continue_on_error": true},
    {"id": "note", "tool": "notes_create",
     "args": {"title": "Briefing", "body": "{{steps.time.summary}}\\n{{steps.repo.summary}}"}}
  ]
}

Steps run in dependency order through the same executor as model tool calls,
so permissions, approvals, taint tracking, timeouts and audit apply equally.
A failed step stops the workflow unless `continue_on_error` is set; steps
depending on a failed/skipped step are skipped. Nothing is retried unless the
tool is declared idempotent (`retryable`).
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

from jarvis.db.models import Run
from jarvis.db.session import db_session
from jarvis.orchestrator.executor import execute_tool_call, set_run_status
from jarvis.realtime.hub import hub
from jarvis.schemas import RunSummary
from jarvis.services.notifications import notify
from jarvis.tools.base import registry

MAX_STEPS = 20
_TEMPLATE = re.compile(r"\{\{\s*steps\.([A-Za-z0-9_-]+)\.(summary|ok)\s*\}\}")


class StepDef(BaseModel):
    id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,40}$")
    tool: str
    args: dict[str, Any] = Field(default_factory=dict)
    depends_on: list[str] = Field(default_factory=list)
    continue_on_error: bool = False

    @field_validator("tool")
    @classmethod
    def _known(cls, v: str) -> str:
        if registry.get(v) is None:
            raise ValueError(f"unknown tool '{v}'")
        return v


class WorkflowDef(BaseModel):
    steps: list[StepDef] = Field(min_length=1, max_length=MAX_STEPS)
    notify_on_finish: bool = True

    def ordered(self) -> list[StepDef]:
        ids = {s.id for s in self.steps}
        if len(ids) != len(self.steps):
            raise ValueError("duplicate step ids")
        for s in self.steps:
            missing = set(s.depends_on) - ids
            if missing:
                raise ValueError(f"step {s.id} depends on unknown steps {sorted(missing)}")
        done: set[str] = set()
        order: list[StepDef] = []
        pending = list(self.steps)
        while pending:
            ready = [s for s in pending if set(s.depends_on) <= done]
            if not ready:
                raise ValueError("workflow has a dependency cycle")
            for s in ready:
                order.append(s)
                done.add(s.id)
                pending.remove(s)
        return order


def render(value: Any, results: dict[str, dict[str, Any]]) -> Any:
    if isinstance(value, str):
        return _TEMPLATE.sub(lambda m: str(results.get(m[1], {}).get(m[2], "")), value)
    if isinstance(value, dict):
        return {k: render(v, results) for k, v in value.items()}
    if isinstance(value, list):
        return [render(v, results) for v in value]
    return value


async def run_workflow(*, user_id: str, name: str, definition: dict[str, Any], origin: str = "workflow") -> RunSummary:
    wf = WorkflowDef.model_validate(definition)
    order = wf.ordered()
    async with db_session() as db:
        run = Run(
            user_id=user_id,
            kind="workflow",
            status="running",
            title=name[:120],
            origin=origin,
            started_at=datetime.now(UTC),
        )
        db.add(run)
        await db.commit()
        await db.refresh(run)
    hub.publish(user_id, "run.started", {"run": RunSummary.of(run)}, run_id=run.id)

    results: dict[str, dict[str, Any]] = {}
    tainted = False
    failed_step: str | None = None
    for step in order:
        blocked = [d for d in step.depends_on if not results.get(d, {}).get("ok")]
        if blocked or (failed_step and not step.continue_on_error):
            results[step.id] = {"ok": False, "summary": "skipped", "skipped": True}
            continue
        outcome = await execute_tool_call(
            user_id=user_id,
            run_id=run.id,
            conversation_id=None,
            tool_name=step.tool,
            raw_args=render(step.args, results),
            origin=origin,
            client_kind=None,
            tainted=tainted,
        )
        tainted = tainted or outcome.result.untrusted
        results[step.id] = {"ok": outcome.result.ok, "summary": outcome.result.summary}
        if not outcome.result.ok and not step.continue_on_error:
            failed_step = step.id

    ok = failed_step is None
    summary = await set_run_status(
        run.id, "succeeded" if ok else "failed", error=None if ok else f"Step '{failed_step}' failed"
    )
    if wf.notify_on_finish:
        lines = [
            f"{'✓' if r.get('ok') else ('–' if r.get('skipped') else '✗')} {sid}: {r['summary']}"
            for sid, r in results.items()
        ]
        await notify(
            user_id,
            f"Workflow {'completed' if ok else 'failed'}: {name}",
            "\n".join(lines),
            level="success" if ok else "error",
            link=f"/mission?run={run.id}",
        )
    return summary


TEMPLATES: dict[str, dict[str, Any]] = {
    "daily_briefing": {
        "name": "Daily briefing",
        "description": "Time, upcoming reminders, recent notes and (optionally) a watched repository, saved as a note.",
        "params": ["repo"],
        "definition": {
            "steps": [
                {"id": "time", "tool": "get_current_time", "args": {}},
                {"id": "reminders", "tool": "reminders_upcoming", "args": {"hours": 24}},
                {"id": "notes", "tool": "notes_search", "args": {"query": "", "limit": 5}},
                {
                    "id": "repo",
                    "tool": "github_repo_overview",
                    "args": {"repo": "{{param.repo}}"},
                    "continue_on_error": True,
                },
                {
                    "id": "save",
                    "tool": "notes_create",
                    "depends_on": ["time"],
                    "continue_on_error": True,
                    "args": {
                        "title": "Daily briefing",
                        "tags": ["briefing"],
                        "body": "{{steps.time.summary}}\n\nReminders: {{steps.reminders.summary}}\n"
                        "Notes: {{steps.notes.summary}}\nRepository: {{steps.repo.summary}}",
                    },
                },
            ]
        },
    },
    "repo_health": {
        "name": "Repository health check",
        "description": "Open PRs, issues and recent CI results for one repository.",
        "params": ["repo"],
        "definition": {"steps": [{"id": "repo", "tool": "github_repo_overview", "args": {"repo": "{{param.repo}}"}}]},
    },
}


def instantiate_template(key: str, params: dict[str, str]) -> tuple[str, dict[str, Any]]:
    tpl = TEMPLATES.get(key)
    if tpl is None:
        raise LookupError(f"unknown template {key}")
    import json

    raw = json.dumps(tpl["definition"])
    for p in tpl["params"]:
        value = params.get(p, "")
        raw = raw.replace("{{param." + p + "}}", json.dumps(value)[1:-1])
    definition = json.loads(raw)
    # Drop steps whose required params were not supplied (e.g. no watched repo).
    if "repo" in tpl["params"] and not params.get("repo"):
        definition["steps"] = [s for s in definition["steps"] if s["tool"] != "github_repo_overview"]
        for s in definition["steps"]:
            s["depends_on"] = [d for d in s.get("depends_on", []) if d != "repo"]
    return tpl["name"], definition
