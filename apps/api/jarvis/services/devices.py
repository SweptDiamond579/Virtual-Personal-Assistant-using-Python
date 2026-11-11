"""Routing of desktop actions to a paired desktop companion.

The backend never executes desktop actions itself. It publishes a
`device.action.request` to the paired desktop's own WebSocket session; the Tauri
app validates the request against its LOCAL policy (Rust) and posts the result
back to `/api/devices/actions/{request_id}/result`. Only the session bound to
that device may submit the result.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from jarvis.realtime.hub import hub


@dataclass
class PendingAction:
    request_id: str
    user_id: str
    device_id: str
    future: asyncio.Future[dict[str, Any]]


_pending: dict[str, PendingAction] = {}


class DeviceUnavailable(Exception):
    pass


def online_desktop(user_id: str) -> str | None:
    devices = sorted(d for d in hub.online_devices(user_id) if d)
    return devices[0] if devices else None


async def request_action(user_id: str, action: dict[str, Any], *, timeout_s: float = 30.0) -> dict[str, Any]:
    device_id = online_desktop(user_id)
    if device_id is None:
        raise DeviceUnavailable("No paired desktop companion is online.")
    request_id = uuid.uuid4().hex
    fut: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
    _pending[request_id] = PendingAction(request_id, user_id, device_id, fut)
    hub.publish(
        user_id,
        "device.action.request",
        {
            "request": {
                "request_id": request_id,
                "action": action,
                "expires_at": (datetime.now(UTC) + timedelta(seconds=timeout_s)).isoformat(),
            }
        },
        device_id=device_id,
    )
    try:
        return await asyncio.wait_for(fut, timeout=timeout_s)
    except TimeoutError as exc:
        raise DeviceUnavailable("The desktop companion did not respond in time.") from exc
    finally:
        _pending.pop(request_id, None)


def submit_result(request_id: str, *, user_id: str, device_id: str | None, result: dict[str, Any]) -> bool:
    pending = _pending.get(request_id)
    if pending is None or pending.user_id != user_id or pending.device_id != device_id:
        return False
    if not pending.future.done():
        pending.future.set_result(result)
    return True
