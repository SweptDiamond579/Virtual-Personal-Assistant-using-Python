"""Runtime configuration. Every value comes from the environment (or `.env`).

Secrets (API keys, the master secret) live only here, on the server. Nothing in
this module is ever serialised to a client; `public_summary()` is the only view
the API exposes.
"""

from __future__ import annotations

import secrets
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

API_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = API_ROOT.parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="",
        env_file=(str(REPO_ROOT / ".env"), str(API_ROOT / ".env")),
        extra="ignore",
    )

    # --- core -----------------------------------------------------------
    jarvis_env: Literal["development", "test", "production"] = "development"
    jarvis_version: str = "0.1.0-beta"
    database_url: str = "postgresql+asyncpg://jarvis:jarvis-dev-password@127.0.0.1:5432/jarvis"
    # Master secret: derives the credential-encryption key. MUST be set in production.
    jarvis_secret_key: SecretStr = Field(default_factory=lambda: SecretStr(""))
    # One-time token required to create the owner account on first run.
    jarvis_setup_token: SecretStr | None = None
    jarvis_allowed_origins: str = (
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:8000,http://127.0.0.1:8000"
    )
    jarvis_cookie_secure: bool = False
    jarvis_session_ttl_hours: int = 24 * 7
    jarvis_data_dir: Path = API_ROOT / "data"
    jarvis_web_dist: Path = REPO_ROOT / "apps" / "web" / "out"

    # --- AI providers ---------------------------------------------------
    jarvis_ai_provider: Literal["anthropic", "openai_compatible", "scripted", "none"] | None = None
    anthropic_api_key: SecretStr | None = None
    anthropic_model: str = "claude-opus-5-5"
    anthropic_fast_model: str = "claude-haiku-5-5"
    anthropic_effort: Literal["low", "medium", "high", "xhigh", "max"] = "medium"
    anthropic_refusal_fallback: bool = True
    openai_compat_base_url: str | None = None
    openai_compat_api_key: SecretStr | None = None
    openai_compat_model: str | None = None
    jarvis_model_routing: Literal["fixed", "auto"] = "auto"

    # --- budgets ----------------------------------------------------------
    jarvis_daily_budget_usd: float = 5.0
    jarvis_max_steps_per_run: int = 8
    jarvis_max_output_tokens: int = 16000
    jarvis_tool_timeout_s: float = 30.0
    jarvis_approval_timeout_s: int = 600

    # --- voice ------------------------------------------------------------
    jarvis_stt_engine: Literal["pocketsphinx", "openai_compatible", "none"] = "pocketsphinx"
    jarvis_tts_engine: Literal["espeak", "openai_compatible", "none"] = "espeak"
    openai_compat_stt_model: str = "whisper-1"
    openai_compat_tts_model: str = "tts-1"
    openai_compat_tts_voice: str = "alloy"

    # --- integrations -----------------------------------------------------
    github_api_url: str = "https://api.github.com"
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_username: str | None = None
    smtp_password: SecretStr | None = None
    smtp_from: str | None = None
    smtp_starttls: bool = True

    # --- browser / web ------------------------------------------------------
    jarvis_browser_enabled: bool = True
    # Only honoured when jarvis_env == "test": lets tests hit local fixture servers.
    jarvis_allow_private_network_for_tests: bool = False

    # --- web push ---------------------------------------------------------
    # PEM private key (P-256). If unset, one is generated in the data dir on first use.
    jarvis_vapid_private_key: SecretStr | None = None
    # Contact for push services (RFC 8292): a mailto: or https: URL you control.
    jarvis_vapid_subject: str = "mailto:jarvis-owner@localhost"

    # --- scheduler --------------------------------------------------------
    jarvis_scheduler_enabled: bool = True
    jarvis_scheduler_poll_s: float = 2.0

    @field_validator("jarvis_data_dir", "jarvis_web_dist", mode="after")
    @classmethod
    def _abs(cls, v: Path) -> Path:
        return v if v.is_absolute() else (API_ROOT / v).resolve()

    # ------------------------------------------------------------------
    @property
    def is_production(self) -> bool:
        return self.jarvis_env == "production"

    @property
    def allowed_origins(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.jarvis_allowed_origins.split(",") if o.strip()]

    @property
    def private_network_allowed(self) -> bool:
        return self.jarvis_env == "test" and self.jarvis_allow_private_network_for_tests

    def secret_key_bytes(self) -> bytes:
        raw = self.jarvis_secret_key.get_secret_value()
        if raw:
            return raw.encode()
        if self.is_production:
            raise RuntimeError("JARVIS_SECRET_KEY must be set in production")
        # Development: persist a generated key so encrypted credentials survive restarts.
        path = self.jarvis_data_dir / "dev-secret.key"
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(secrets.token_urlsafe(48))
            path.chmod(0o600)
        return path.read_text().strip().encode()

    def resolved_provider(self) -> str:
        if self.jarvis_ai_provider:
            return self.jarvis_ai_provider
        if self.anthropic_api_key and self.anthropic_api_key.get_secret_value():
            return "anthropic"
        if self.openai_compat_base_url and self.openai_compat_model:
            return "openai_compatible"
        return "none"


@lru_cache
def get_settings() -> Settings:
    return Settings()
