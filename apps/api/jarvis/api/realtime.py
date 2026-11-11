from __future__ import annotations

import asyncio
import contextlib
import json

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from jarvis.config import get_settings
from jarvis.db.session import db_session
from jarvis.realtime.hub import Subscriber, hub
from jarvis.security.auth import (
    SessionContext,
    current_session,
    issue_ws_ticket,
    origin_allowed,
    redeem_ws_ticket,
    session_by_id,
)
from jarvis.services.status import system_status

router = APIRouter(tags=["realtime"])


@router.post("/api/realtime/ticket")
async def ticket(ctx: SessionContext = Depends(current_session)) -> dict:
    return {"ticket": issue_ws_ticket(ctx.session.id), "expires_in": 30}


@router.websocket("/api/ws")
async def websocket(ws: WebSocket) -> None:
    if not origin_allowed(ws.headers.get("origin")):
        await ws.close(code=4403)
        return
    session_id = redeem_ws_ticket(ws.query_params.get("ticket", ""))
    if session_id is None:
        await ws.close(code=4401)
        return
    async with db_session() as db:
        ctx = await session_by_id(db, session_id)
    if ctx is None:
        await ws.close(code=4401)
        return
    await ws.accept()
    sub = Subscriber(
        user_id=ctx.user.id,
        session_id=ctx.session.id,
        client_kind=ctx.session.client_kind,
        device_id=ctx.session.device_id,
    )
    hub.subscribe(sub)
    await ws.send_json(
        {
            "type": "hello",
            "seq": 0,
            "ts": "",
            "run_id": None,
            "conversation_id": None,
            "data": {
                "session_id": ctx.session.id,
                "client_kind": ctx.session.client_kind,
                "version": get_settings().jarvis_version,
            },
        }
    )
    # Device presence changed: tell every session of this user.
    if sub.device_id:
        hub.publish(ctx.user.id, "system.status", {"status": await system_status(ctx.user.id)})

    async def sender() -> None:
        while True:
            event = await sub.queue.get()
            await ws.send_text(json.dumps(event))

    async def receiver() -> None:
        while True:
            raw = await ws.receive_text()
            if len(raw) > 4096:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            if msg.get("type") == "ping":
                await ws.send_json({"type": "pong"})

    tasks = [asyncio.create_task(sender()), asyncio.create_task(receiver())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    except WebSocketDisconnect:
        pass
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            with contextlib.suppress(BaseException):
                await t
        hub.unsubscribe(sub)
        if sub.device_id:
            hub.publish(ctx.user.id, "system.status", {"status": await system_status(ctx.user.id)})
