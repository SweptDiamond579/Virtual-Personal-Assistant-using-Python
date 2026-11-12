"""Per-user preferences stored in `user_settings`.

Security-relevant keys (tool_policies, web_allowlist) are validated here and can
only be written through the authenticated settings API — tools never call `set_setting`.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from jarvis.db.models import UserSetting
from jarvis.tools.policy import DEFAULT_WEB_ALLOWLIST

DEFAULTS: dict[str, Any] = {
    "tool_policies": {},
    "web_allowlist": DEFAULT_WEB_ALLOWLIST,
    "voice": {"stt": "server", "tts": "server", "voice": "en-gb", "rate": 1.0, "auto_speak": True},
    "interface": {"quality": "high", "render_mode": "3d", "reduced_motion": False, "show_stats": False},
    "notifications": {"desktop": True, "sound": False, "push": True},
    "privacy": {"conversation_retention_days": 0, "memory_auto_propose": True},
    "budget": {"daily_usd": None},
    "watched_repos": [],
    "dev_projects": [],
    "timezone": "UTC",
}

# In-memory emergency stop flag (also persisted under the "system" pseudo-user key).
_emergency: dict[str, bool] = {}


async def get_setting(db: AsyncSession, user_id: str, key: str) -> Any:
    row = await db.get(UserSetting, (user_id, key))
    if row is None:
        return DEFAULTS.get(key)
    value = row.value.get("v")
    default = DEFAULTS.get(key)
    if isinstance(default, dict) and isinstance(value, dict):
        return {**default, **value}
    return value


async def get_all(db: AsyncSession, user_id: str) -> dict[str, Any]:
    rows = (await db.execute(select(UserSetting).where(UserSetting.user_id == user_id))).scalars().all()
    out = dict(DEFAULTS)
    for r in rows:
        v = r.value.get("v")
        out[r.key] = {**DEFAULTS[r.key], **v} if isinstance(DEFAULTS.get(r.key), dict) and isinstance(v, dict) else v
    return out


async def set_setting(db: AsyncSession, user_id: str, key: str, value: Any) -> None:
    row = await db.get(UserSetting, (user_id, key))
    if row is None:
        db.add(UserSetting(user_id=user_id, key=key, value={"v": value}))
    else:
        row.value = {"v": value}
        row.updated_at = datetime.now(UTC)
    await db.flush()


async def load_emergency_flags(db: AsyncSession) -> None:
    rows = (await db.execute(select(UserSetting).where(UserSetting.key == "emergency_stop"))).scalars().all()
    for r in rows:
        _emergency[r.user_id] = bool(r.value.get("v"))


def emergency_stop_active(user_id: str) -> bool:
    return _emergency.get(user_id, False)


async def set_emergency_stop(db: AsyncSession, user_id: str, active: bool) -> None:
    _emergency[user_id] = active
    await set_setting(db, user_id, "emergency_stop", active)
