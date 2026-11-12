"""Unit tests for the security primitives: policy engine, SSRF guard, path sandbox, safe eval, crypto."""

from __future__ import annotations

from pathlib import Path

import pytest

from jarvis.security.crypto import canonical_hash, decrypt_secret, encrypt_secret
from jarvis.security.ssrf import UnsafeURLError, check_url
from jarvis.tools.base import registry
from jarvis.tools.builtin.core import safe_eval
from jarvis.tools.builtin.files import PathError, resolve_in_root
from jarvis.tools.policy import PolicyInput, decide


def pin(**kw: object) -> PolicyInput:
    base = {
        "emergency_stop": False,
        "overrides": {},
        "tainted": False,
        "unmet_requirements": [],
        "web_allowlist": ["en.wikipedia.org"],
    }
    base.update(kw)
    return PolicyInput(**base)  # type: ignore[arg-type]


def spec(name: str):  # noqa: ANN201
    s = registry.get(name)
    assert s is not None
    return s


class TestPolicy:
    def test_read_only_auto(self) -> None:
        assert decide(spec("get_current_time"), {}, pin()).decision == "auto"

    def test_high_risk_asks(self) -> None:
        d = decide(spec("email_send"), {"draft_id": "x" * 10}, pin())
        assert d.decision == "ask"

    def test_emergency_stop_denies_side_effects(self) -> None:
        assert decide(spec("notes_create"), {}, pin(emergency_stop=True)).decision == "deny"
        assert decide(spec("get_current_time"), {}, pin(emergency_stop=True)).decision == "auto"

    def test_unmet_requirement_denies(self) -> None:
        d = decide(spec("desktop_launch_app"), {"app_id": "calc"}, pin(unmet_requirements=["desktop offline"]))
        assert d.decision == "deny" and "desktop offline" in d.reason

    def test_override_deny(self) -> None:
        assert decide(spec("notes_create"), {}, pin(overrides={"notes_create": "deny"})).decision == "deny"

    def test_override_auto_cannot_unlock_high_risk(self) -> None:
        assert decide(spec("email_send"), {}, pin(overrides={"email_send": "auto"})).decision == "ask"

    def test_override_auto_for_medium(self) -> None:
        assert decide(spec("files_write"), {}, pin(overrides={"files_write": "auto"})).decision == "auto"

    def test_taint_escalates_side_effects(self) -> None:
        d = decide(spec("notes_create"), {}, pin(tainted=True))
        assert d.decision == "ask" and "Untrusted" in d.reason
        # read-only tools are unaffected by taint
        assert decide(spec("notes_search"), {}, pin(tainted=True)).decision == "auto"

    def test_domain_allowlist(self) -> None:
        assert decide(spec("web_fetch"), {"url": "https://en.wikipedia.org/wiki/X"}, pin()).decision == "auto"
        assert decide(spec("web_fetch"), {"url": "https://sub.en.wikipedia.org/x"}, pin()).decision == "auto"
        assert decide(spec("web_fetch"), {"url": "https://evil-wikipedia.org/x"}, pin()).decision == "ask"
        assert decide(spec("web_fetch"), {"url": "https://en.wikipedia.org.evil.com/"}, pin()).decision == "ask"

    def test_desktop_write_requires_desktop_approver(self) -> None:
        d = decide(spec("desktop_write_file"), {}, pin())
        assert d.decision == "ask" and d.requires_client_kind == "desktop"

    def test_registry_rejects_auto_high_risk(self) -> None:
        for t in registry.all():
            if t.risk in ("high", "critical"):
                assert t.default_policy != "auto", t.name


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost/admin",
        "http://127.0.0.1:8000/api",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://0.0.0.0/",
        "http://100.64.0.1/",
        "file:///etc/passwd",
        "gopher://example.com/",
        "http://user:pass@example.com/",
        "http://8.8.8.8:22/",
        "http://metadata.internal/",
    ],
)
async def test_ssrf_blocked(url: str, monkeypatch: pytest.MonkeyPatch) -> None:
    from jarvis.config import get_settings

    monkeypatch.setattr(get_settings(), "jarvis_allow_private_network_for_tests", False)
    with pytest.raises(UnsafeURLError):
        await check_url(url)


async def test_ssrf_public_literal_allowed() -> None:
    checked = await check_url("https://8.8.8.8/")
    assert checked.addresses == ("8.8.8.8",)


class TestPathSandbox:
    @pytest.mark.parametrize(
        "bad", ["../x", "/etc/passwd", "a/../../b", ".ssh/id_rsa", "C:\\x", "a\x00b", "sub/.hidden"]
    )
    def test_rejects(self, tmp_path: Path, bad: str) -> None:
        with pytest.raises(PathError):
            resolve_in_root(tmp_path.resolve(), bad)

    def test_symlink_escape(self, tmp_path: Path) -> None:
        root = (tmp_path / "root").resolve()
        root.mkdir()
        (root / "link").symlink_to(tmp_path)
        with pytest.raises(PathError):
            resolve_in_root(root, "link/secret.txt")

    def test_accepts_nested(self, tmp_path: Path) -> None:
        root = tmp_path.resolve()
        assert resolve_in_root(root, "docs/report.md") == root / "docs" / "report.md"


class TestSafeEval:
    def test_math(self) -> None:
        assert safe_eval("(42 * 1.5) / sqrt(9)") == 21.0
        assert round(safe_eval("sin(pi/2)"), 6) == 1.0

    @pytest.mark.parametrize(
        "attack",
        [
            "__import__('os').system('id')",
            "().__class__",
            "2**99999",
            "open('/etc/passwd')",
            "[x for x in range(10)]",
            "lambda: 1",
        ],
    )
    def test_rejects_code(self, attack: str) -> None:
        with pytest.raises((ValueError, SyntaxError)):
            safe_eval(attack)


def test_encryption_roundtrip_and_tamper() -> None:
    blob = encrypt_secret("ghp_example_token")
    assert b"ghp_example" not in blob
    assert decrypt_secret(blob) == "ghp_example_token"
    with pytest.raises(ValueError):
        decrypt_secret(blob[:-4] + b"AAAA")


def test_canonical_hash_order_independent() -> None:
    assert canonical_hash({"a": 1, "b": 2}) == canonical_hash({"b": 2, "a": 1})
    assert canonical_hash({"a": 1}) != canonical_hash({"a": 2})


async def test_pinned_transport_connects_only_to_checked_ip(monkeypatch: pytest.MonkeyPatch) -> None:
    """DNS rebinding: after the check, the connection must go to the checked IP, not a re-resolution."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    from jarvis.config import get_settings
    from jarvis.security import ssrf

    seen: dict[str, str] = {}

    class H(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            seen["host"] = self.headers.get("Host", "")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"pinned ok")

        def log_message(self, *a: object) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    monkeypatch.setattr(get_settings(), "jarvis_allow_private_network_for_tests", True)

    async def fake_check(url: str) -> ssrf.CheckedURL:
        # The check "resolves" rebinding.test to 127.0.0.1 (the checked, allowed address).
        return ssrf.CheckedURL(url=url, host="rebinding.test", addresses=("127.0.0.1",))

    monkeypatch.setattr(ssrf, "check_url", fake_check)
    try:
        res = await ssrf.safe_fetch(f"http://rebinding.test:{port}/x")
    finally:
        server.shutdown()
    # Real DNS for rebinding.test does not exist: success proves the socket went to the pinned IP,
    # while the Host header kept the original name.
    assert res.status == 200 and res.text == "pinned ok"
    assert seen["host"] == f"rebinding.test:{port}"


async def test_pinned_backend_refuses_unchecked_hosts() -> None:
    import httpcore

    from jarvis.security.ssrf import PinnedBackend

    backend = PinnedBackend({"good.example": "93.184.216.34"})
    with pytest.raises(httpcore.ConnectError):
        await backend.connect_tcp("evil.example", 80)


def test_pinned_client_wires_backend_into_pool() -> None:
    from jarvis.security.ssrf import PinnedBackend, pinned_client

    client = pinned_client({}, timeout=1)
    assert isinstance(client._transport._pool._network_backend, PinnedBackend)  # noqa: SLF001
