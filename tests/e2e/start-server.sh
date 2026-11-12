#!/usr/bin/env bash
# Starts the API serving the static web export on :8100 against a freshly reset e2e database.
# The scripted test provider stands in for the AI model so runs are deterministic.
set -euo pipefail
cd "$(dirname "$0")/../../apps/api"
export JARVIS_ENV=test
export DATABASE_URL="${E2E_DATABASE_URL:-postgresql+asyncpg://jarvis:jarvis-dev-password@127.0.0.1:5432/jarvis_e2e}"
export JARVIS_AI_PROVIDER=scripted
export JARVIS_SETUP_TOKEN=e2e-setup-token-0001
export JARVIS_SECRET_KEY=e2e-secret-key-not-for-production-000000
export JARVIS_ALLOWED_ORIGINS=http://127.0.0.1:8100,http://localhost:8100
export JARVIS_DATA_DIR="$(mktemp -d)"
uv run alembic downgrade base >/dev/null
uv run alembic upgrade head >/dev/null
exec uv run uvicorn jarvis.main:app --host 127.0.0.1 --port 8100
