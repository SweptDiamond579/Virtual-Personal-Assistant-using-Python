from __future__ import annotations

import asyncio

from jarvis.db.models import Notification
from jarvis.db.session import db_session
from jarvis.realtime.hub import hub
from jarvis.schemas import NotificationDTO
from jarvis.services.settings_store import get_setting


async def notify(
    user_id: str, title: str, body: str = "", *, level: str = "info", link: str | None = None
) -> Notification:
    async with db_session() as db:
        n = Notification(user_id=user_id, title=title[:200], body=body, level=level, link=link)
        db.add(n)
        await db.commit()
        await db.refresh(n)
    hub.publish(user_id, "notification.created", {"notification": NotificationDTO.model_validate(n)})
    _schedule_push(user_id, n)
    return n


_push_tasks: set[asyncio.Task[int]] = set()


def _schedule_push(user_id: str, n: Notification) -> None:
    """Deliver to closed PWAs in the background; failures never affect the caller."""
    from jarvis.services import push

    async def _send() -> int:
        try:
            async with db_session() as db:
                prefs = await get_setting(db, user_id, "notifications")
            if not (prefs or {}).get("push", True):
                return 0
            return await push.send_to_user(user_id, title=n.title, body=n.body, link=n.link, level=n.level)
        except Exception:
            return 0

    task = asyncio.create_task(_send())
    _push_tasks.add(task)
    task.add_done_callback(_push_tasks.discard)
