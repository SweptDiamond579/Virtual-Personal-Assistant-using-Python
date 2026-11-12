"""Web Push: endpoint allow-list, real aes128gcm payload encryption, VAPID signing, expiry cleanup."""

from __future__ import annotations

import base64
import json

import http_ece
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import select

from jarvis.db.models import PushSubscription
from jarvis.db.session import db_session
from jarvis.services import push
from tests.conftest import AuthedClient


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def subscriber_keys() -> tuple[ec.EllipticCurvePrivateKey, bytes, dict[str, str]]:
    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    auth = b"0123456789abcdef"
    return priv, auth, {"p256dh": b64u(pub), "auth": b64u(auth)}


@pytest.mark.parametrize(
    ("endpoint", "ok"),
    [
        ("https://fcm.googleapis.com/fcm/send/abc", True),
        ("https://updates.push.services.mozilla.com/wpush/v2/x", True),
        ("https://web.push.apple.com/QF1", True),
        ("https://db5p.notify.windows.com/w/?token=1", True),
        ("http://fcm.googleapis.com/fcm/send/abc", False),
        ("https://fcm.googleapis.com.evil.com/x", False),
        ("https://127.0.0.1/x", False),
        ("https://user:pw@fcm.googleapis.com/x", False),
        ("https://fcm.googleapis.com:8443/x", False),
    ],
)
def test_endpoint_allowlist(endpoint: str, ok: bool) -> None:
    assert push.endpoint_allowed(endpoint) is ok


async def test_subscribe_rejects_unknown_push_service(owner: AuthedClient) -> None:
    _, _, keys = subscriber_keys()
    r = await owner.post("/api/push/subscribe", json={"endpoint": "https://attacker.example/collect", "keys": keys})
    assert r.status_code == 422


async def test_push_payload_is_encrypted_and_vapid_signed(owner: AuthedClient, monkeypatch: pytest.MonkeyPatch) -> None:
    priv, auth, keys = subscriber_keys()
    endpoint = "https://fcm.googleapis.com/fcm/send/test-device"
    assert (await owner.post("/api/push/subscribe", json={"endpoint": endpoint, "keys": keys})).status_code == 200
    captured: dict = {}

    class FakeResp:
        status_code = 201
        text = ""
        headers: dict = {}

    def fake_post(url, data=None, headers=None, timeout=None, **kw):  # noqa: ANN001, ANN202
        captured.update(url=url, data=data, headers=headers)
        return FakeResp()

    import pywebpush

    monkeypatch.setattr(pywebpush.requests, "post", fake_post)
    monkeypatch.setattr(pywebpush.requests.Session, "post", lambda self, *a, **k: fake_post(*a, **k))
    delivered = (await owner.post("/api/push/test")).json()["delivered"]
    assert delivered == 1
    assert captured["url"] == endpoint
    assert captured["headers"]["Content-Encoding"] == "aes128gcm"
    assert captured["headers"]["Authorization"].startswith("vapid t=")
    # The push service only ever sees ciphertext; the subscriber can decrypt it.
    assert b"JARVIS test notification" not in captured["data"]
    plain = http_ece.decrypt(captured["data"], private_key=priv, auth_secret=auth, version="aes128gcm")
    msg = json.loads(plain)
    assert msg["title"] == "JARVIS test notification" and msg["link"] == "/command/"
    # VAPID key is the one the browser subscribes with.
    pk = (await owner.get("/api/push/public-key")).json()["public_key"]
    assert captured["headers"]["Authorization"].endswith(f"k={pk}")


async def test_expired_subscription_removed(owner: AuthedClient, monkeypatch: pytest.MonkeyPatch) -> None:
    _, _, keys = subscriber_keys()
    endpoint = "https://updates.push.services.mozilla.com/wpush/v2/gone"
    await owner.post("/api/push/subscribe", json={"endpoint": endpoint, "keys": keys})
    monkeypatch.setattr(push, "_send_one", lambda sub, payload: 410)
    assert await push.send_to_user(owner.user_id, title="t", body="b", link=None, level="info") == 0
    async with db_session() as db:
        assert (await db.execute(select(PushSubscription))).scalars().all() == []
