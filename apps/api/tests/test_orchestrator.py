"""End-to-end orchestration through the real executor, policy engine, approvals and DB.

The model is the scripted test double (no AI); everything else is production code.
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select

from jarvis.db.models import Approval, Message, Note, Run, RunStep
from jarvis.db.session import db_session
from jarvis.orchestrator import engine
from jarvis.orchestrator.executor import execute_tool_call
from jarvis.tools.builtin.files import workspace_root
from tests.conftest import AuthedClient, events


async def wait_status(run_id: str, statuses: set[str], timeout: float = 10.0) -> Run:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        async with db_session() as db:
            run = await db.get(Run, run_id)
        if run and run.status in statuses:
            return run
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"run {run_id} stuck in {run.status if run else None}")
        await asyncio.sleep(0.05)


async def pending_approval(run_id: str, timeout: float = 10.0) -> Approval:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        async with db_session() as db:
            a = (await db.execute(select(Approval).where(Approval.run_id == run_id))).scalars().first()
        if a:
            return a
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("no approval requested")
        await asyncio.sleep(0.05)


async def test_chat_tool_call_persists_and_streams(owner: AuthedClient) -> None:
    r = await owner.post("/api/chat", json={"text": "note: Groceries | milk, eggs"})
    assert r.status_code == 200, r.text
    run_id = r.json()["run"]["id"]
    run = await wait_status(run_id, {"succeeded", "failed"})
    assert run.status == "succeeded", run.error

    async with db_session() as db:
        notes = (await db.execute(select(Note))).scalars().all()
        steps = (
            (await db.execute(select(RunStep).where(RunStep.run_id == run_id).order_by(RunStep.seq))).scalars().all()
        )
        visible = (
            (
                await db.execute(
                    select(Message)
                    .where(Message.run_id == run_id, Message.visible.is_(True))
                    .order_by(Message.created_at)
                )
            )
            .scalars()
            .all()
        )
    assert [n.title for n in notes] == ["Groceries"]
    assert notes[0].body == "milk, eggs"
    tool_steps = [s for s in steps if s.kind == "tool_call"]
    assert len(tool_steps) == 1 and tool_steps[0].status == "succeeded"
    assert tool_steps[0].output["verified"] is True
    assert [m.role for m in visible] == ["user", "assistant"]
    assert "Done (verified): Saved note" in visible[1].content

    types = [e["type"] for e in events(owner.user_id) if e["run_id"] == run_id]
    for expected in ("run.started", "tool.started", "tool.finished", "assistant.delta", "assistant.completed"):
        assert expected in types, expected
    assert types.index("tool.started") < types.index("tool.finished") < types.index("assistant.completed")

    # History persisted and listed via the API.
    convs = (await owner.get("/api/conversations")).json()
    msgs = (await owner.get(f"/api/conversations/{convs[0]['id']}/messages")).json()
    assert len(msgs) == 2


async def test_approval_flow_approved_writes_verified_file(owner: AuthedClient) -> None:
    r = await owner.post("/api/chat", json={"text": "write file reports/status.md: All systems nominal."})
    run_id = r.json()["run"]["id"]
    approval = await pending_approval(run_id)
    assert approval.tool == "files_write" and approval.status == "pending"
    await wait_status(run_id, {"waiting_approval"})
    target = workspace_root(owner.user_id) / "reports" / "status.md"
    assert not target.exists(), "must not execute before approval"

    d = await owner.post(f"/api/approvals/{approval.id}/decision", json={"approve": True})
    assert d.status_code == 200, d.text
    run = await wait_status(run_id, {"succeeded", "failed"})
    assert run.status == "succeeded"
    assert target.read_text() == "All systems nominal."
    async with db_session() as db:
        step = (
            await db.execute(select(RunStep).where(RunStep.run_id == run_id, RunStep.kind == "tool_call"))
        ).scalar_one()
    assert step.output["verified"] is True

    # Approvals are single-use.
    again = await owner.post(f"/api/approvals/{approval.id}/decision", json={"approve": True})
    assert again.status_code == 409


async def test_approval_denied_does_not_execute(owner: AuthedClient) -> None:
    r = await owner.post("/api/chat", json={"text": "write file secret.txt: nope"})
    run_id = r.json()["run"]["id"]
    approval = await pending_approval(run_id)
    await owner.post(f"/api/approvals/{approval.id}/decision", json={"approve": False})
    run = await wait_status(run_id, {"succeeded", "failed"})
    assert not (workspace_root(owner.user_id) / "secret.txt").exists()
    async with db_session() as db:
        step = (
            await db.execute(select(RunStep).where(RunStep.run_id == run_id, RunStep.kind == "tool_call"))
        ).scalar_one()
        msg = (
            await db.execute(
                select(Message).where(Message.run_id == run_id, Message.role == "assistant", Message.visible.is_(True))
            )
        ).scalar_one()
    assert step.status == "denied"
    assert "denied" in msg.content.lower()  # the model is told the truth and reports it
    assert run.status == "succeeded"  # the conversation turn completed, honestly reporting the denial


async def test_unavailable_desktop_tool_is_denied(owner: AuthedClient) -> None:
    r = await owner.post("/api/chat", json={"text": "launch calculator"})
    run_id = r.json()["run"]["id"]
    await wait_status(run_id, {"succeeded", "failed"})
    async with db_session() as db:
        step = (
            await db.execute(select(RunStep).where(RunStep.run_id == run_id, RunStep.kind == "tool_call"))
        ).scalar_one()
        approvals_ = (await db.execute(select(Approval).where(Approval.run_id == run_id))).scalars().all()
    assert step.status == "denied" and "desktop" in (step.summary or "").lower()
    assert approvals_ == []


async def test_tainted_context_escalates_side_effects(owner: AuthedClient) -> None:
    async with db_session() as db:
        run = Run(user_id=owner.user_id, kind="command", status="running", title="t")
        db.add(run)
        await db.commit()

    async def call() -> object:
        return await execute_tool_call(
            user_id=owner.user_id,
            run_id=run.id,
            conversation_id=None,
            tool_name="notes_create",
            raw_args={"title": "From a web page"},
            origin="user",
            client_kind="web",
            tainted=True,
        )

    task = asyncio.create_task(call())
    approval = await pending_approval(run.id)
    assert "Untrusted" in approval.reason
    await owner.post(f"/api/approvals/{approval.id}/decision", json={"approve": False})
    outcome = await task
    assert outcome.result.ok is False  # type: ignore[attr-defined]


async def test_invalid_tool_arguments_rejected(owner: AuthedClient) -> None:
    async with db_session() as db:
        run = Run(user_id=owner.user_id, kind="command", status="running", title="t")
        db.add(run)
        await db.commit()
    out = await execute_tool_call(
        user_id=owner.user_id,
        run_id=run.id,
        conversation_id=None,
        tool_name="notes_create",
        raw_args={"title": "x", "evil": "extra"},
        origin="user",
        client_kind="web",
        tainted=False,
    )
    assert out.result.ok is False and "Invalid arguments" in out.result.summary
    unknown = await execute_tool_call(
        user_id=owner.user_id,
        run_id=run.id,
        conversation_id=None,
        tool_name="shell_exec",
        raw_args={"cmd": "rm -rf /"},
        origin="user",
        client_kind="web",
        tainted=False,
    )
    assert unknown.result.ok is False and "Unknown tool" in unknown.result.summary


async def test_emergency_stop_blocks_and_cancels(owner: AuthedClient) -> None:
    r = await owner.post("/api/chat", json={"text": "write file a.md: hi"})
    run_id = r.json()["run"]["id"]
    await pending_approval(run_id)
    stop = await owner.post("/api/security/emergency-stop", json={"active": True})
    assert stop.json()["cancelled_runs"] >= 1
    run = await wait_status(run_id, {"cancelled", "failed", "succeeded"})
    assert run.status == "cancelled"
    cmd = await owner.post("/api/commands", json={"tool": "notes_create", "args": {"title": "blocked"}})
    run2 = await wait_status(cmd.json()["run"]["id"], {"succeeded", "failed"})
    assert run2.status == "failed" and "Emergency" in (run2.error or "")
    await owner.post("/api/security/emergency-stop", json={"active": False})


async def test_direct_command_without_model(owner: AuthedClient) -> None:
    r = await owner.post("/api/commands", json={"tool": "calculate", "args": {"expression": "6*7"}})
    run = await wait_status(r.json()["run"]["id"], {"succeeded", "failed"})
    assert run.status == "succeeded"
    detail = (await owner.get(f"/api/runs/{run.id}")).json()
    assert detail["steps"][0]["output"]["data"]["result"] == 42


async def test_desktop_approval_requires_desktop_session(owner: AuthedClient) -> None:
    from jarvis.services import approvals

    a = await approvals.request_approval(
        user_id=owner.user_id,
        run_id=None,
        step_id=None,
        tool="desktop_write_file",
        risk="high",
        arguments={"root_id": "home", "path": "x.txt", "content": "", "overwrite": False},
        reason="test",
        requires_client_kind="desktop",
    )
    r = await owner.post(f"/api/approvals/{a.id}/decision", json={"approve": True})
    assert r.status_code == 409 and "desktop" in r.json()["detail"]
    # Denying is always allowed from any session.
    r = await owner.post(f"/api/approvals/{a.id}/decision", json={"approve": False})
    assert r.status_code == 200


async def test_approval_binding_to_arguments() -> None:
    from jarvis.security.crypto import canonical_hash
    from jarvis.services.approvals import verify_binding

    a = Approval(
        tool="files_write",
        status="approved",
        arguments_hash=canonical_hash({"tool": "files_write", "args": {"path": "a.md"}}),
    )
    assert verify_binding(a, "files_write", {"path": "a.md"})
    assert not verify_binding(a, "files_write", {"path": "b.md"})
    assert not verify_binding(a, "files_read", {"path": "a.md"})


async def test_restart_recovery_never_resumes(owner: AuthedClient) -> None:
    async with db_session() as db:
        db.add(Run(user_id=owner.user_id, kind="chat", status="running", title="in flight"))
        await db.commit()
    await engine.recover_interrupted()
    async with db_session() as db:
        run = (await db.execute(select(Run).where(Run.title == "in flight"))).scalar_one()
    assert run.status == "failed" and "restart" in (run.error or "")


async def test_daily_budget_enforced(owner: AuthedClient) -> None:
    await owner.put("/api/settings/budget", json={"value": {"daily_usd": 0}})
    r = await owner.post("/api/chat", json={"text": "what time is it"})
    run = await wait_status(r.json()["run"]["id"], {"succeeded", "failed"})
    assert run.status == "failed" and "budget" in (run.error or "").lower()
