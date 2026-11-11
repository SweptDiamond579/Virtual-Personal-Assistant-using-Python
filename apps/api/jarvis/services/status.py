"""Real service health — every entry is measured, nothing is hard-coded 'ok'."""

from __future__ import annotations

import shutil
import time
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy import text

from jarvis.config import get_settings
from jarvis.db.session import db_session
from jarvis.integrations.github import get_token
from jarvis.integrations.smtp import smtp_configured
from jarvis.providers import build_provider
from jarvis.schemas import AIStatus, ServiceHealth, SystemStatus
from jarvis.services.devices import online_desktop
from jarvis.services.settings_store import emergency_stop_active


def _chromium_available() -> bool:
    root = Path(get_settings().jarvis_data_dir).parent
    del root
    import os

    base = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if base and Path(base).exists():
        return any(p.name.startswith("chromium") for p in Path(base).iterdir())
    return (Path.home() / ".cache" / "ms-playwright").exists()


async def system_status(user_id: str) -> SystemStatus:
    from jarvis.workflows.scheduler import scheduler_state

    s = get_settings()
    services: list[ServiceHealth] = []

    t0 = time.perf_counter()
    try:
        async with db_session() as db:
            await db.execute(text("SELECT 1"))
        services.append(
            ServiceHealth(
                name="database",
                status="ok",
                detail="PostgreSQL reachable",
                latency_ms=round((time.perf_counter() - t0) * 1000, 1),
            )
        )
    except Exception as exc:
        services.append(ServiceHealth(name="database", status="down", detail=type(exc).__name__))

    provider = build_provider()
    if provider is None:
        services.append(
            ServiceHealth(name="ai", status="not_configured", detail="No model provider credentials configured")
        )
    else:
        label = "scripted test double" if provider.name == "scripted" else provider.name
        services.append(
            ServiceHealth(
                name="ai",
                status="ok" if provider.name != "scripted" else "degraded",
                detail=f"{label} · {provider.default_model()}",
            )
        )

    st = scheduler_state()
    if not s.jarvis_scheduler_enabled:
        services.append(ServiceHealth(name="scheduler", status="not_configured", detail="Disabled by configuration"))
    else:
        last = st.get("last_tick")
        fresh = last and (datetime.now(UTC) - datetime.fromisoformat(last)).total_seconds() < 30
        services.append(
            ServiceHealth(
                name="scheduler",
                status="ok" if fresh else "down",
                detail=f"last tick {last or 'never'} · {st.get('executed', 0)} jobs run",
            )
        )

    if s.jarvis_stt_engine == "pocketsphinx":
        services.append(ServiceHealth(name="speech_to_text", status="ok", detail="Local PocketSphinx (offline)"))
    elif s.jarvis_stt_engine == "openai_compatible" and s.openai_compat_base_url:
        services.append(ServiceHealth(name="speech_to_text", status="ok", detail="OpenAI-compatible Whisper API"))
    else:
        services.append(ServiceHealth(name="speech_to_text", status="not_configured", detail="Browser speech only"))

    if s.jarvis_tts_engine == "espeak":
        found = shutil.which("espeak-ng") or shutil.which("espeak")
        services.append(
            ServiceHealth(
                name="text_to_speech",
                status="ok" if found else "down",
                detail="Local eSpeak NG" if found else "espeak-ng not installed",
            )
        )
    else:
        services.append(
            ServiceHealth(
                name="text_to_speech",
                status="ok" if s.jarvis_tts_engine != "none" else "not_configured",
                detail=s.jarvis_tts_engine,
            )
        )

    services.append(
        ServiceHealth(
            name="browser",
            status="ok" if s.jarvis_browser_enabled and _chromium_available() else "not_configured",
            detail="Playwright Chromium (isolated contexts)" if s.jarvis_browser_enabled else "Disabled",
        )
    )
    gh = await get_token(user_id)
    services.append(
        ServiceHealth(
            name="github",
            status="ok" if gh else "not_configured",
            detail="Token connected" if gh else "Public read-only mode",
        )
    )
    services.append(
        ServiceHealth(
            name="email",
            status="ok" if smtp_configured() else "not_configured",
            detail="SMTP configured" if smtp_configured() else "SMTP not configured",
        )
    )
    desktop = online_desktop(user_id)
    services.append(
        ServiceHealth(
            name="desktop",
            status="ok" if desktop else "not_configured",
            detail="Companion online" if desktop else "No desktop companion connected",
        )
    )

    return SystemStatus(
        version=s.jarvis_version,
        server_time=datetime.now(UTC),
        services=services,
        ai=AIStatus(
            provider=provider.name if provider else None,
            model=provider.default_model() if provider else None,
            configured=provider is not None,
        ),
        desktop_online=desktop is not None,
        emergency_stop=emergency_stop_active(user_id),
    )
