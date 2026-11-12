"""Web Push (RFC 8030 + VAPID RFC 8292, payloads encrypted with aes128gcm RFC 8291).

Lets approvals, reminders and failures reach a phone even when the PWA is closed.
Subscription endpoints are restricted to known browser push services so a forged
subscription cannot make the server send requests to arbitrary hosts (SSRF).
"""

from __future__ import annotations

import asyncio
import base64
import json
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from sqlalchemy import delete, select

from jarvis.config import get_settings
from jarvis.db.models import PushSubscription
from jarvis.db.session import db_session
from jarvis.logging import get_logger

log = get_logger("push")

# Push services used by Chrome/Edge (FCM), Firefox (Mozilla autopush), Safari (Apple) and Windows (WNS).
ALLOWED_PUSH_HOSTS = (
    "fcm.googleapis.com",
    "android.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
    "notify.windows.com",
)


def endpoint_allowed(endpoint: str) -> bool:
    parts = urlsplit(endpoint)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or parts.username or parts.password or parts.port not in (None, 443):
        return False
    return any(host == h or host.endswith("." + h) for h in ALLOWED_PUSH_HOSTS)


def _key_path() -> Path:
    return get_settings().jarvis_data_dir / "vapid_private.pem"


def _load_or_create_key() -> ec.EllipticCurvePrivateKey:
    s = get_settings()
    if s.jarvis_vapid_private_key and s.jarvis_vapid_private_key.get_secret_value():
        pem = s.jarvis_vapid_private_key.get_secret_value().replace("\\n", "\n").encode()
        key = serialization.load_pem_private_key(pem, password=None)
        assert isinstance(key, ec.EllipticCurvePrivateKey)
        return key
    path = _key_path()
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        key = ec.generate_private_key(ec.SECP256R1())
        path.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
            )
        )
        path.chmod(0o600)
    loaded = serialization.load_pem_private_key(path.read_bytes(), password=None)
    assert isinstance(loaded, ec.EllipticCurvePrivateKey)
    return loaded


def public_key_b64url() -> str:
    raw = (
        _load_or_create_key()
        .public_key()
        .public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    )
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _private_pem() -> str:
    return (
        _load_or_create_key()
        .private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        .decode()
    )


def _send_one(sub: PushSubscription, payload: str) -> int:
    """Blocking send; returns the push service's HTTP status."""
    from py_vapid import Vapid02
    from pywebpush import WebPushException, webpush

    vapid = Vapid02.from_pem(_private_pem().encode())
    try:
        resp = webpush(
            subscription_info={"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}},
            data=payload,
            vapid_private_key=vapid,
            vapid_claims={"sub": get_settings().jarvis_vapid_subject},
            ttl=3600,
            timeout=10,
        )
        return int(getattr(resp, "status_code", 201))
    except WebPushException as exc:
        return int(exc.response.status_code) if exc.response is not None else 0
    except Exception:  # network error, malformed keys: count as a failed delivery
        log.exception("push send error")
        return 0


async def send_to_user(user_id: str, *, title: str, body: str, link: str | None, level: str) -> int:
    """Push to every subscription of the user. Returns the number of successful deliveries."""
    async with db_session() as db:
        subs = (await db.execute(select(PushSubscription).where(PushSubscription.user_id == user_id))).scalars().all()
    if not subs:
        return 0
    payload = json.dumps({"title": title[:120], "body": body[:240], "link": link, "level": level})
    delivered = 0
    for sub in subs:
        if not endpoint_allowed(sub.endpoint):
            continue
        status = await asyncio.to_thread(_send_one, sub, payload)
        async with db_session() as db:
            row = await db.get(PushSubscription, sub.id)
            if row is None:
                continue
            if 200 <= status < 300:
                delivered += 1
                row.last_success_at = datetime.now(UTC)
                row.failures = 0
            elif status in (404, 410):
                await db.execute(delete(PushSubscription).where(PushSubscription.id == sub.id))  # expired
            else:
                row.failures += 1
                if row.failures >= 5:
                    await db.execute(delete(PushSubscription).where(PushSubscription.id == sub.id))
            await db.commit()
        if not 200 <= status < 300:
            log.info("push delivery failed", status=status)
    return delivered
