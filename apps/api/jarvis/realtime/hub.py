"""In-process realtime event hub.

Every connected WebSocket registers a subscriber queue. Events are fanned out
to all live sessions of the owning user; `device.action.request` events go only
to sessions of the targeted desktop device.
"""

from __future__ import annotations

import asyncio
import itertools
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from pydantic import BaseModel

from jarvis.logging import get_logger
from jarvis.schemas import SERVER_EVENT_TYPES

log = get_logger("realtime")


@dataclass(eq=False)
class Subscriber:
    user_id: str
    session_id: str
    client_kind: str
    device_id: str | None
    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=lambda: asyncio.Queue(maxsize=1000))
    dropped: int = 0


def _jsonable(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json")
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_jsonable(v) for v in value]
    if isinstance(value, datetime):
        return value.isoformat()
    return value


class EventHub:
    def __init__(self) -> None:
        self._subs: set[Subscriber] = set()
        self._seq = itertools.count(1)
        self._history: list[dict[str, Any]] = []  # bounded log for tests/diagnostics

    def subscribe(self, sub: Subscriber) -> None:
        self._subs.add(sub)

    def unsubscribe(self, sub: Subscriber) -> None:
        self._subs.discard(sub)

    def online_devices(self, user_id: str) -> set[str]:
        return {s.device_id for s in self._subs if s.user_id == user_id and s.device_id}

    def connected_sessions(self, user_id: str) -> int:
        return sum(1 for s in self._subs if s.user_id == user_id)

    def publish(
        self,
        user_id: str,
        type_: str,
        data: dict[str, Any],
        *,
        run_id: str | None = None,
        conversation_id: str | None = None,
        device_id: str | None = None,
    ) -> dict[str, Any]:
        if type_ not in SERVER_EVENT_TYPES:
            raise ValueError(f"unknown event type {type_}")
        event = {
            "type": type_,
            "seq": next(self._seq),
            "ts": datetime.now(UTC).isoformat(),
            "run_id": run_id,
            "conversation_id": conversation_id,
            "data": _jsonable(data),
        }
        self._history.append({"user_id": user_id, **event})
        if len(self._history) > 2000:
            del self._history[:500]
        for sub in list(self._subs):
            if sub.user_id != user_id:
                continue
            if device_id is not None and sub.device_id != device_id:
                continue
            try:
                sub.queue.put_nowait(event)
            except asyncio.QueueFull:
                sub.dropped += 1
                log.warning("subscriber queue full; dropping event", session=sub.session_id)
        return event

    def recent(self, user_id: str, types: set[str] | None = None) -> list[dict[str, Any]]:
        return [e for e in self._history if e["user_id"] == user_id and (types is None or e["type"] in types)]


hub = EventHub()
