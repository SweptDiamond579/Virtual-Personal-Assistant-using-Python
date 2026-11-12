from __future__ import annotations

import httpx

from tests.conftest import PASSWORD, make_owner


async def test_setup_requires_valid_token(anon: httpx.AsyncClient) -> None:
    r = await anon.post(
        "/api/auth/setup", json={"setup_token": "wrong-token-xx", "username": "tony", "password": PASSWORD}
    )
    assert r.status_code == 403
    state = (await anon.get("/api/auth/state")).json()
    assert state["setup_required"] is True and state["authenticated"] is False


async def test_setup_once_then_conflict(anon: httpx.AsyncClient) -> None:
    await make_owner(anon)
    r = await anon.post(
        "/api/auth/setup", json={"setup_token": "test-setup-token-123", "username": "eve", "password": PASSWORD}
    )
    assert r.status_code == 409


async def test_weak_password_rejected(anon: httpx.AsyncClient) -> None:
    r = await anon.post(
        "/api/auth/setup", json={"setup_token": "test-setup-token-123", "username": "tony", "password": "short"}
    )
    assert r.status_code == 422


async def test_login_logout_and_cookie_flags(anon: httpx.AsyncClient) -> None:
    await make_owner(anon)
    anon.cookies.clear()
    bad = await anon.post("/api/auth/login", json={"username": "tony", "password": "nope-nope-nope"})
    assert bad.status_code == 401
    unknown = await anon.post("/api/auth/login", json={"username": "ghost", "password": "nope-nope-nope"})
    assert unknown.status_code == 401 and unknown.json() == bad.json()  # no username enumeration
    ok = await anon.post("/api/auth/login", json={"username": "tony", "password": PASSWORD})
    assert ok.status_code == 200
    cookie = ok.headers.get_list("set-cookie")
    session_cookie = next(c for c in cookie if c.startswith("jarvis_session="))
    assert "HttpOnly" in session_cookie and "SameSite=lax" in session_cookie
    csrf = ok.json()["csrf_token"]
    assert (await anon.get("/api/system/status")).status_code == 200
    out = await anon.post("/api/auth/logout", headers={"X-CSRF-Token": csrf})
    assert out.status_code == 200
    assert (await anon.get("/api/system/status")).status_code == 401


async def test_unauthenticated_requests_rejected(anon: httpx.AsyncClient) -> None:
    for path in ("/api/system/status", "/api/conversations", "/api/memories", "/api/audit", "/api/tools"):
        assert (await anon.get(path)).status_code == 401, path
    assert (await anon.post("/api/chat", json={"text": "hi"})).status_code == 401


async def test_csrf_required_for_mutations(anon: httpx.AsyncClient) -> None:
    owner = await make_owner(anon)
    r = await anon.post("/api/notes", json={"title": "x"})  # no CSRF header
    assert r.status_code == 403
    r = await anon.post("/api/notes", json={"title": "x"}, headers={"X-CSRF-Token": "forged"})
    assert r.status_code == 403
    r = await owner.post("/api/notes", json={"title": "x"})
    assert r.status_code == 200


async def test_login_rate_limited(anon: httpx.AsyncClient) -> None:
    await make_owner(anon)
    codes = [
        (await anon.post("/api/auth/login", json={"username": "tony", "password": "bad-password-1"})).status_code
        for _ in range(12)
    ]
    assert codes[:10] == [401] * 10
    assert codes[-1] == 429


async def test_session_revocation(anon: httpx.AsyncClient) -> None:
    owner = await make_owner(anon)
    sessions = (await owner.get("/api/auth/sessions")).json()
    assert len(sessions) == 1 and sessions[0]["current"]
    r = await owner.post(f"/api/auth/sessions/{sessions[0]['id']}/revoke")
    assert r.status_code == 200
    assert (await anon.get("/api/system/status")).status_code == 401


async def test_security_headers(anon: httpx.AsyncClient) -> None:
    r = await anon.get("/api/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["cache-control"] == "no-store"


async def test_static_export_served_for_get_and_head(tmp_path, monkeypatch) -> None:  # noqa: ANN001
    import httpx as _httpx

    from jarvis.config import get_settings
    from jarvis.main import create_app

    (tmp_path / "command").mkdir()
    (tmp_path / "command" / "index.html").write_text("<html>core</html>")
    monkeypatch.setattr(get_settings(), "jarvis_web_dist", tmp_path)
    app = create_app()
    async with _httpx.AsyncClient(transport=_httpx.ASGITransport(app=app), base_url="http://t") as c:
        assert (await c.get("/command/")).text == "<html>core</html>"
        head = await c.head("/command/")
        assert head.status_code == 200  # Next.js prefetches with HEAD
        assert "Content-Security-Policy" in head.headers
        assert (await c.get("/../../etc/passwd")).status_code == 404
        assert (await c.get("/api/nope")).status_code == 404
