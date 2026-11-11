"""Test fixtures. Tests run against a real PostgreSQL database (`jarvis_test`)."""

from __future__ import annotations

import os
import tempfile
from collections.abc import AsyncIterator

os.environ.update(
    {
        "JARVIS_ENV": "test",
        "DATABASE_URL": os.environ.get(
            "TEST_DATABASE_URL", "postgresql+asyncpg://jarvis:jarvis-dev-password@127.0.0.1:5432/jarvis_test"
        ),
        "JARVIS_AI_PROVIDER": "scripted",
        "JARVIS_SETUP_TOKEN": "test-setup-token-123",
        "JARVIS_SECRET_KEY": "test-secret-key-for-encryption-0123456789",
        "JARVIS_SCHEDULER_ENABLED": "false",
        "JARVIS_DATA_DIR": tempfile.mkdtemp(prefix="jarvis-test-"),
        "JARVIS_APPROVAL_TIMEOUT_S": "20",
        "JARVIS_WEB_DIST": "/nonexistent",
    }
)

import httpx  # noqa: E402
import pytest  # noqa: E402
from sqlalchemy import text  # noqa: E402

from jarvis.db.models import Base  # noqa: E402
from jarvis.db.session import get_engine  # noqa: E402
from jarvis.main import app  # noqa: E402
from jarvis.realtime.hub import hub  # noqa: E402
from jarvis.security.ratelimit import limiter  # noqa: E402

PASSWORD = "correct-horse-battery-staple"


@pytest.fixture(scope="session", autouse=True)
async def database() -> AsyncIterator[None]:
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield


@pytest.fixture(autouse=True)
async def clean_tables() -> AsyncIterator[None]:
    limiter.clear()
    engine = get_engine()
    async with engine.begin() as conn:
        tables = ", ".join(t.name for t in reversed(Base.metadata.sorted_tables))
        await conn.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    from jarvis.services import settings_store

    settings_store._emergency.clear()
    yield


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver")


@pytest.fixture
async def anon() -> AsyncIterator[httpx.AsyncClient]:
    async with _client() as c:
        yield c


class AuthedClient:
    """Wraps an httpx client and sends the CSRF header on unsafe methods."""

    def __init__(self, client: httpx.AsyncClient, csrf: str, user_id: str) -> None:
        self.c = client
        self.csrf = csrf
        self.user_id = user_id

    async def get(self, url: str, **kw: object) -> httpx.Response:
        return await self.c.get(url, **kw)  # type: ignore[arg-type]

    async def post(self, url: str, **kw: object) -> httpx.Response:
        return await self.c.post(url, headers={"X-CSRF-Token": self.csrf}, **kw)  # type: ignore[arg-type]

    async def put(self, url: str, **kw: object) -> httpx.Response:
        return await self.c.put(url, headers={"X-CSRF-Token": self.csrf}, **kw)  # type: ignore[arg-type]

    async def patch(self, url: str, **kw: object) -> httpx.Response:
        return await self.c.patch(url, headers={"X-CSRF-Token": self.csrf}, **kw)  # type: ignore[arg-type]

    async def delete(self, url: str, **kw: object) -> httpx.Response:
        return await self.c.delete(url, headers={"X-CSRF-Token": self.csrf}, **kw)  # type: ignore[arg-type]


async def make_owner(client: httpx.AsyncClient) -> AuthedClient:
    r = await client.post(
        "/api/auth/setup",
        json={"setup_token": "test-setup-token-123", "username": "tony", "password": PASSWORD, "display_name": "T"},
    )
    assert r.status_code == 200, r.text
    return AuthedClient(client, r.json()["csrf_token"], r.json()["user"]["id"])


@pytest.fixture
async def owner() -> AsyncIterator[AuthedClient]:
    async with _client() as c:
        yield await make_owner(c)


def events(user_id: str, types: set[str] | None = None) -> list[dict]:
    return hub.recent(user_id, types)
