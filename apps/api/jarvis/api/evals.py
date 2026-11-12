"""Evaluation runs (spend real API credit; started explicitly by the owner)."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from jarvis.evals.cases import CASES
from jarvis.evals.runner import latest_report, run_evals
from jarvis.security.audit import audit
from jarvis.security.auth import SessionContext, current_session

router = APIRouter(prefix="/api/evals", tags=["evals"])
_state: dict[str, object] = {"running": False, "error": None}


class RunBody(BaseModel):
    max_usd: float = Field(default=0.5, gt=0, le=10)
    confirm_spend: bool = False


@router.get("")
async def evals(ctx: SessionContext = Depends(current_session)) -> dict:
    return {
        "cases": [{"id": c.id, "category": c.category, "prompt": c.prompt} for c in CASES],
        "latest": latest_report(),
        "running": _state["running"],
        "error": _state["error"],
    }


@router.post("/run")
async def run(body: RunBody, ctx: SessionContext = Depends(current_session)) -> dict:
    if not body.confirm_spend:
        raise HTTPException(400, "evaluations spend API credit; set confirm_spend=true")
    if _state["running"]:
        raise HTTPException(409, "an evaluation is already running")

    async def go() -> None:
        _state.update(running=True, error=None)
        try:
            await run_evals(max_usd=body.max_usd)
        except Exception as exc:  # surfaced in GET /api/evals
            _state["error"] = str(exc)
        finally:
            _state["running"] = False

    asyncio.create_task(go())
    await audit("evals.started", actor=ctx.actor, details={"max_usd": body.max_usd})
    return {"started": True}
