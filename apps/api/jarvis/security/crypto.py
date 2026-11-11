"""Password hashing, token hashing and credential encryption."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from jarvis.config import get_settings

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


# A fixed dummy hash lets failed lookups cost the same as real verifications
# (prevents username enumeration through timing).
_DUMMY_HASH = _hasher.hash("jarvis-dummy-password-for-timing")


def burn_password_check(password: str) -> None:
    verify_password(_DUMMY_HASH, password)


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def token_hash(token: str) -> str:
    """Session/pairing tokens are stored only as SHA-256 hashes."""
    return hashlib.sha256(token.encode()).hexdigest()


def constant_time_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


def canonical_hash(data: Any) -> str:
    """Stable hash of JSON-compatible data (approvals bind to exact arguments)."""
    raw = json.dumps(data, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


def _fernet() -> Fernet:
    key = HKDF(algorithm=hashes.SHA256(), length=32, salt=b"jarvis-os/credentials/v1", info=b"fernet").derive(
        get_settings().secret_key_bytes()
    )
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_secret(plaintext: str) -> bytes:
    return _fernet().encrypt(plaintext.encode())


def decrypt_secret(ciphertext: bytes) -> str:
    try:
        return _fernet().decrypt(ciphertext).decode()
    except InvalidToken as exc:  # key rotated or data tampered
        raise ValueError("stored credential cannot be decrypted with the current secret key") from exc
