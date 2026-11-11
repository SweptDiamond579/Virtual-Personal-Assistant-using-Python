"""JARVIS OS API — application factory."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

import jarvis.tools.builtin  # noqa: F401  (registers tools)
from jarvis.api import auth, automation, chat, knowledge, realtime, system
from jarvis.config import get_settings
from jarvis.db.session import db_session, dispose_engine
from jarvis.logging import configure_logging, get_logger
from jarvis.orchestrator.engine import recover_interrupted
from jarvis.services.settings_store import load_emergency_flags
from jarvis.workflows.scheduler import release_stale_leases, scheduler_loop

log = get_logger("main")

CSP = (
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss: ipc: http://ipc.localhost; "
    "media-src 'self' blob:; "
    "worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
)


class SecurityHeaders(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        h = response.headers
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("Referrer-Policy", "no-referrer")
        h.setdefault("X-Frame-Options", "DENY")
        h.setdefault("Permissions-Policy", "microphone=(self), camera=(), geolocation=()")
        h.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        if request.url.path.startswith("/api/"):
            h.setdefault("Cache-Control", "no-store")
        else:
            h.setdefault("Content-Security-Policy", CSP)
        if get_settings().jarvis_cookie_secure:
            h.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    s = get_settings()
    configure_logging(json_logs=s.is_production)
    s.jarvis_data_dir.mkdir(parents=True, exist_ok=True)
    s.secret_key_bytes()  # fail fast in production without a secret
    async with db_session() as db:
        await load_emergency_flags(db)
    await recover_interrupted()
    await release_stale_leases()
    task = None
    if s.jarvis_scheduler_enabled:
        task = asyncio.create_task(scheduler_loop(), name="scheduler")
    if s.jarvis_setup_token is None:
        log.info("owner setup is disabled until JARVIS_SETUP_TOKEN is set")
    log.info("JARVIS API started", env=s.jarvis_env, provider=s.resolved_provider())
    yield
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    await dispose_engine()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(
        title="JARVIS OS API",
        version=s.jarvis_version,
        lifespan=lifespan,
        docs_url=None if s.is_production else "/api/docs",
        openapi_url=None if s.is_production else "/api/openapi.json",
        redoc_url=None,
    )
    app.add_middleware(SecurityHeaders)
    for r in (auth.router, realtime.router, chat.router, knowledge.router, automation.router, system.router):
        app.include_router(r)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error", path=request.url.path)
        return JSONResponse({"detail": "internal error"}, status_code=500)

    dist: Path = s.jarvis_web_dist
    if dist.is_dir():

        @app.get("/{path:path}", include_in_schema=False)
        async def web(path: str) -> Response:
            if path.startswith("api/"):
                return JSONResponse({"detail": "not found"}, status_code=404)
            root = dist.resolve()  # noqa: ASYNC240  (pure path math, no I/O)
            candidate = (root / path).resolve()
            if root not in candidate.parents and candidate != root:
                return JSONResponse({"detail": "not found"}, status_code=404)
            for option in (candidate, candidate / "index.html", candidate.with_suffix(".html")):
                if option.is_file():
                    return FileResponse(option)
            return (
                FileResponse(root / "404.html", status_code=404)
                if (root / "404.html").exists()
                else JSONResponse({"detail": "not found"}, status_code=404)
            )

    return app


app = create_app()
