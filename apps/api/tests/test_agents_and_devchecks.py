"""Specialist delegation and sandboxed project checks."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest
from sqlalchemy import select

from jarvis.agents.specialists import SPECIALISTS, parse_report, specialist_tools
from jarvis.db.models import Run, RunStep
from jarvis.db.session import db_session
from jarvis.tools.base import ToolContext, registry
from jarvis.tools.builtin.devchecks import CheckInput, available_checks, dev_run_checks, run_check, scrubbed_env
from tests.conftest import AuthedClient
from tests.test_orchestrator import pending_approval, wait_status


def test_specialist_toolsets_are_restricted() -> None:
    for spec in SPECIALISTS.values():
        names = {t.name for t in specialist_tools(spec)}
        assert "delegate_task" not in names  # no recursion
        assert names <= set(spec.tools)
        for n in names:  # specialists never get tools that bypass approval for high-risk effects
            t = registry.get(n)
            assert t is not None and not (t.risk in ("high", "critical") and t.default_policy == "auto")
    assert "dev_run_checks" in {t.name for t in specialist_tools(SPECIALISTS["development"])}


def test_report_parsing() -> None:
    ok, structured = parse_report('noise {"summary": "S", "findings": ["a"], "sources": [], "confidence": 0.9}')
    assert structured and ok.summary == "S" and ok.confidence == 0.9
    bad, structured = parse_report('{"summary": 5, "confidence": 7}')
    assert not structured and bad.confidence == 0.3


async def test_delegation_end_to_end(owner: AuthedClient) -> None:
    await owner.post("/api/notes", json={"title": "Quarterly plan", "body": "ship beta"})
    r = await owner.post("/api/chat", json={"text": "delegate productivity: what time is it"})
    run_id = r.json()["run"]["id"]
    run = await wait_status(run_id, {"succeeded", "failed"})
    assert run.status == "succeeded", run.error
    async with db_session() as db:
        steps = (
            (await db.execute(select(RunStep).where(RunStep.run_id == run_id).order_by(RunStep.seq))).scalars().all()
        )
    names = [(s.kind, s.name) for s in steps]
    assert ("tool_call", "delegate_task") in names
    assert ("model_call", "agent:productivity") in names
    assert ("tool_call", "get_current_time") in names  # the specialist's own tool call, via the executor
    delegate = next(s for s in steps if s.name == "delegate_task")
    assert delegate.output["verified"] is True and delegate.output["data"]["structured"] is True
    assert "get_current_time" in delegate.output["data"]["tools_used"]


async def test_specialist_cannot_use_tools_outside_its_set(owner: AuthedClient) -> None:
    # The productivity specialist asked to write a file: the scripted model tries files_write,
    # which is not in its toolset, so it is refused without executing or asking for approval.
    r = await owner.post("/api/chat", json={"text": "delegate productivity: write file x.md: nope"})
    run = await wait_status(r.json()["run"]["id"], {"succeeded", "failed"})
    async with db_session() as db:
        steps = (await db.execute(select(RunStep).where(RunStep.run_id == run.id))).scalars().all()
    assert "files_write" not in {s.name for s in steps}


def make_project(tmp_path: Path, passing: bool) -> Path:
    proj = tmp_path / "proj"
    (proj / "tests").mkdir(parents=True)
    (proj / "pyproject.toml").write_text("[project]\nname='demo'\nversion='0'\n")
    (proj / "tests" / "test_demo.py").write_text(
        "import os\n\ndef test_env_is_scrubbed():\n    assert 'ANTHROPIC_API_KEY' not in os.environ\n\n"
        f"def test_value():\n    assert {passing!r}\n"
    )
    (proj / ".venv" / "bin").mkdir(parents=True)
    shim = proj / ".venv" / "bin" / "python"  # a project venv whose interpreter has pytest available
    shim.write_text(f'#!/bin/sh\nexec "{sys.executable}" "$@"\n')
    shim.chmod(0o755)
    return proj


async def test_run_check_scrubs_env_and_reports(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-never-leak")
    assert "ANTHROPIC_API_KEY" not in scrubbed_env()
    proj = make_project(tmp_path, passing=False)
    assert "pytest" in available_checks(proj) and "cargo_test" not in available_checks(proj)
    from jarvis.tools.builtin.devchecks import check_argv

    code, out, _ = await run_check(check_argv("pytest", proj) or [], proj)
    assert code == 1 and "1 failed, 1 passed" in out


async def test_run_check_timeout_kills_process_group(tmp_path: Path) -> None:
    code, _, seconds = await run_check([sys.executable, "-c", "import time; time.sleep(30)"], tmp_path, timeout_s=1)
    assert code is None and seconds < 10


async def test_dev_run_checks_requires_approval_and_registration(owner: AuthedClient, tmp_path: Path) -> None:
    proj = make_project(tmp_path, passing=True)
    bad = await owner.put("/api/settings/dev_projects", json={"value": [{"id": "root", "path": "/"}]})
    assert bad.status_code == 422
    ok = await owner.put("/api/settings/dev_projects", json={"value": [{"id": "demo", "path": str(proj)}]})
    assert ok.status_code == 200
    r = await owner.post("/api/chat", json={"text": "run pytest in demo"})
    run_id = r.json()["run"]["id"]
    approval = await pending_approval(run_id)
    assert approval.tool == "dev_run_checks" and approval.risk == "high"
    await owner.post(f"/api/approvals/{approval.id}/decision", json={"approve": True})
    await wait_status(run_id, {"succeeded", "failed"})
    async with db_session() as db:
        step = (
            await db.execute(select(RunStep).where(RunStep.run_id == run_id, RunStep.name == "dev_run_checks"))
        ).scalar_one()
    assert step.status == "succeeded"
    assert step.summary.startswith("pytest in demo: passed")
    # Unregistered projects are refused by the tool itself.
    res = await dev_run_checks(
        CheckInput(project_id="other", check="pytest"), ToolContext(user_id=owner.user_id, run_id=None)
    )
    assert not res.ok and "Unknown project" in res.summary
    _ = (Run, asyncio, os)
