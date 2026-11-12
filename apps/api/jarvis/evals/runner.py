"""Runs the evaluation cases against the configured provider (one model turn each, no tool execution)."""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import jarvis.tools.builtin  # noqa: F401  (registers tools when run from the CLI)
from jarvis.config import get_settings
from jarvis.evals.cases import CASES, EvalCase
from jarvis.orchestrator.engine import tool_schemas
from jarvis.orchestrator.prompts import SYSTEM_PROMPT, context_preamble
from jarvis.providers import build_provider, estimate_cost
from jarvis.providers.base import ProviderError, ProviderMessage, TextDelta, TurnComplete, TurnRequest


@dataclass
class CaseResult:
    id: str
    category: str
    passed: bool
    tools_called: list[str]
    reason: str
    latency_ms: int
    cost_usd: float
    text: str


def score(case: EvalCase, turn: TurnComplete, text: str) -> tuple[bool, str]:
    names = [c.name for c in turn.tool_calls]
    inputs = json.dumps([c.input for c in turn.tool_calls])
    for bad in case.forbid_text:
        if bad.lower() in inputs.lower():
            return False, f"tool input contained forbidden text {bad!r}"
    forbidden = [n for n in names if n in case.forbid_tools]
    if forbidden:
        return False, f"called forbidden tool(s) {forbidden}"
    if case.expect_no_tool and names:
        return False, f"expected a direct answer but called {names}"
    if case.expect_tools and (not names or names[0] not in case.expect_tools):
        return False, f"expected one of {list(case.expect_tools)}, got {names or 'no tool'}"
    if case.expect_no_tool and not text.strip():
        return False, "empty answer"
    return True, "ok"


async def run_evals(*, max_usd: float = 1.0, case_ids: list[str] | None = None) -> dict[str, Any]:
    provider = build_provider()
    if provider is None:
        raise RuntimeError("No AI provider configured")
    tools = tool_schemas()
    available = {t.name for t in tools}
    results: list[CaseResult] = []
    spent = 0.0
    for case in CASES:
        if case_ids and case.id not in case_ids:
            continue
        if case.expect_tools and not set(case.expect_tools) & available:
            continue  # tool not installed in this deployment
        if spent >= max_usd:
            break
        preamble = context_preamble(now=datetime.now(UTC), timezone="UTC", memories=[], origin="user")
        messages = [ProviderMessage(m["role"], m["blocks"]) for m in case.prior]
        messages.append(
            ProviderMessage("user", [{"type": "text", "text": preamble}, {"type": "text", "text": case.prompt}])
        )
        model = provider.default_model()
        started = time.perf_counter()
        text, turn = "", None
        try:
            async for ev in provider.stream_turn(
                TurnRequest(system=SYSTEM_PROMPT, messages=messages, tools=tools, model=model, max_tokens=4000)
            ):
                if isinstance(ev, TextDelta):
                    text += ev.text
                else:
                    turn = ev
        except ProviderError as exc:
            results.append(CaseResult(case.id, case.category, False, [], f"provider error: {exc}", 0, 0.0, ""))
            continue
        assert turn is not None
        u = turn.usage
        cost = estimate_cost(turn.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens)
        spent += cost
        passed, reason = score(case, turn, text)
        results.append(
            CaseResult(
                case.id,
                case.category,
                passed,
                [c.name for c in turn.tool_calls],
                reason,
                int((time.perf_counter() - started) * 1000),
                round(cost, 6),
                text[:400],
            )
        )
    by_cat: dict[str, dict[str, int]] = {}
    for r in results:
        c = by_cat.setdefault(r.category, {"passed": 0, "total": 0})
        c["total"] += 1
        c["passed"] += int(r.passed)
    report = {
        "ran_at": datetime.now(UTC).isoformat(),
        "provider": provider.name,
        "model": provider.default_model(),
        "pass_rate": round(sum(r.passed for r in results) / len(results), 3) if results else 0.0,
        "passed": sum(r.passed for r in results),
        "total": len(results),
        "cost_usd": round(spent, 4),
        "by_category": by_cat,
        "results": [asdict(r) for r in results],
    }
    out = get_settings().jarvis_data_dir / "evals"
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.json").write_text(json.dumps(report, indent=2))
    return report


def latest_report() -> dict[str, Any] | None:
    out = get_settings().jarvis_data_dir / "evals"
    files = sorted(Path(out).glob("*.json")) if out.exists() else []
    return json.loads(files[-1].read_text()) if files else None
