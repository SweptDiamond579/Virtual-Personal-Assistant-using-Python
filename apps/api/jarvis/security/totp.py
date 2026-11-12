"""TOTP (RFC 6238) second factor with single-use recovery codes.

- The secret is Fernet-encrypted at rest; it is shown to the user once during enrolment.
- Codes are accepted within ±1 time step; a code's time step can be used only once.
- Ten recovery codes are generated on enable; only their SHA-256 hashes are stored and
  each works once.
"""

from __future__ import annotations

import hashlib
import io
import secrets
import time

import pyotp
import segno

from jarvis.db.models import User
from jarvis.security.crypto import constant_time_eq, decrypt_secret, encrypt_secret

ISSUER = "JARVIS OS"
RECOVERY_CODES = 10


def new_secret() -> str:
    return pyotp.random_base32()


def provisioning_uri(secret: str, username: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=username, issuer_name=ISSUER)


def qr_svg(uri: str) -> str:
    buf = io.BytesIO()
    segno.make(uri, error="m").save(buf, kind="svg", scale=5, dark="#e6f4ff", light=None, xmldecl=False)
    return buf.getvalue().decode()


def store_pending_secret(user: User, secret: str) -> None:
    user.totp_secret_encrypted = encrypt_secret(secret)
    user.totp_enabled = False
    user.totp_last_step = None


def _hash_code(code: str) -> str:
    return hashlib.sha256(code.replace("-", "").strip().lower().encode()).hexdigest()


def make_recovery_codes(user: User) -> list[str]:
    codes = [f"{secrets.token_hex(3)}-{secrets.token_hex(3)}" for _ in range(RECOVERY_CODES)]
    user.totp_recovery_hashes = [_hash_code(c) for c in codes]
    return codes


def verify_totp(user: User, code: str, *, now: float | None = None) -> bool:
    """Verify a 6-digit code, rejecting reuse of an already-accepted time step."""
    if not user.totp_secret_encrypted or not code or not code.strip().isdigit():
        return False
    totp = pyotp.TOTP(decrypt_secret(user.totp_secret_encrypted))
    t = now if now is not None else time.time()
    current = int(t // totp.interval)
    for step in (current - 1, current, current + 1):
        if constant_time_eq(totp.at(step * totp.interval), code.strip()):
            if user.totp_last_step is not None and step <= user.totp_last_step:
                return False  # replayed or older code
            user.totp_last_step = step
            return True
    return False


def use_recovery_code(user: User, code: str) -> bool:
    h = _hash_code(code)
    remaining = list(user.totp_recovery_hashes or [])
    for stored in remaining:
        if constant_time_eq(stored, h):
            remaining.remove(stored)
            user.totp_recovery_hashes = remaining
            return True
    return False


def verify_second_factor(user: User, code: str | None) -> bool:
    if not code:
        return False
    return verify_totp(user, code) or use_recovery_code(user, code)
