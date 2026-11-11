from __future__ import annotations

from jarvis.db.models import Notification
from jarvis.db.session import db_session
from jarvis.realtime.hub import hub
from jarvis.schemas import NotificationDTO


async def notify(
    user_id: str, title: str, body: str = "", *, level: str = "info", link: str | None = None
) -> Notification:
    async with db_session() as db:
        n = Notification(user_id=user_id, title=title[:200], body=body, level=level, link=link)
        db.add(n)
        await db.commit()
        await db.refresh(n)
    hub.publish(user_id, "notification.created", {"notification": NotificationDTO.model_validate(n)})
    return n
