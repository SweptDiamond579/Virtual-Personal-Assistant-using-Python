from __future__ import annotations

from sqlalchemy import func, select

from jarvis.db.models import RunStep
from jarvis.db.session import db_session
from jarvis.evals.cases import CASES, EvalCase
from jarvis.evals.runner import latest_report, run_evals, score
from jarvis.providers.base import ToolCall, TurnComplete, TurnUsage
from tests.conftest import AuthedClient


def turn(*calls: tuple[str, dict]) -> TurnComplete:
    tc = [ToolCall(id=f"t{i}", name=n, input=a) for i, (n, a) in enumerate(calls)]
    return TurnComplete(
        blocks=[], tool_calls=tc, stop_reason="tool_use" if tc else "end_turn", usage=TurnUsage(), model="m"
    )


def case(cid: str) -> EvalCase:
    return next(c for c in CASES if c.id == cid)


def test_scoring_rules() -> None:
    assert score(case("calc-percent"), turn(("calculate", {"expression": "0.17*2340"})), "")[0]
    assert not score(case("calc-percent"), turn(), "about 398")[0]
    assert score(case("chit-chat"), turn(), "You're welcome.")[0]
    assert not score(case("chit-chat"), turn(("notes_create", {"title": "x"})), "")[0]
    inj = case("injection-email")
    assert score(inj, turn(), "Boil water first.")[0]
    ok, why = score(inj, turn(("email_draft", {"to": "attacker@evil.example"})), "")
    assert not ok and "forbidden" in why
    ok, _ = score(case("secret-memory"), turn(("memory_propose", {"content": "password is Hunter2-Blue!"})), "")
    assert not ok


async def test_harness_runs_without_executing_tools(owner: AuthedClient) -> None:
    report = await run_evals(max_usd=1.0)
    assert report["provider"] == "scripted" and report["total"] >= 9
    assert set(report["by_category"]) >= {"tool_selection", "no_tool", "injection", "privacy"}
    assert latest_report() == report
    async with db_session() as db:
        assert (await db.execute(select(func.count()).select_from(RunStep))).scalar() == 0  # nothing executed
    api = (await owner.get("/api/evals")).json()
    assert api["latest"]["total"] == report["total"]
    assert (await owner.post("/api/evals/run", json={"max_usd": 0.5})).status_code == 400  # must confirm spend
