# JARVIS OS — project instructions for Claude Code

Read this before substantial changes. Details live in `docs/` (ARCHITECTURE, SECURITY, DECISIONS, STATUS, ROADMAP, DESIGN_SYSTEM). Update `docs/STATUS.md` whenever a capability's verified state changes, and record notable choices in `docs/DECISIONS.md`.

## What this is
A secure, voice-controlled personal AI operating environment: FastAPI orchestrator + Next.js dashboard with a real-time 3D core + Tauri desktop companion. The original 2021 voice assistant is preserved untouched in `legacy/`.

## Layout
- `apps/api` — Python 3.12+ package `jarvis` (FastAPI, SQLAlchemy 2 async, Alembic, PostgreSQL + pgvector). Managed with `uv`.
- `apps/web` — Next.js 16 (App Router, static export in production), React 19, Tailwind v4, React Three Fiber. `src/components/core` is the 3D core.
- `apps/desktop` — Tauri 2. `src-tauri/crates/policy` is the pure-Rust policy/enforcement crate.
- `packages/protocol` — the realtime/event contract shared by web, desktop and (mirrored in `apps/api/jarvis/schemas.py`) the API.
- `tests/e2e` — Playwright suite against the production build.

## Commands
- API: `cd apps/api && uv run uvicorn jarvis.main:app --reload --port 8000`; tests `uv run pytest -q`; lint `uv run ruff check jarvis tests && uv run ruff format --check jarvis tests`; migrations `uv run alembic revision --autogenerate -m "..."` then `uv run alembic upgrade head`, verify with `uv run alembic check`.
- Web: `pnpm --filter @jarvis/web dev` (port 3000, proxies `/api`); `cd apps/web && npx tsc --noEmit && npx eslint src && npx vitest run && npx next build`.
- E2E: build the web app, then `npx playwright test -c tests/e2e/playwright.config.ts` (uses the `jarvis_e2e` database).
- Desktop: `cd apps/desktop/src-tauri && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings`.

## Non-negotiable rules
1. **Every tool call goes through `jarvis/orchestrator/executor.py`** (validation → policy → approval → timeout → verification → audit). Never call a tool handler directly from new code paths.
2. **Agents never change their own authority.** Tool policies, the web allow-list and budgets are only writable through authenticated, CSRF-protected user endpoints. No tool may write settings.
3. **High/critical-risk tools can never default to `auto`** (the registry enforces this). New side-effecting tools need a risk level, `side_effects=True`, and outcome verification where possible.
4. **External content is untrusted.** Tools returning web/repo/email content set `untrusted_output=True`; results are fenced in `<untrusted_content>` and taint the run, which escalates later side effects to approval.
5. **Conversation history is append-only**, the system prompt is static, and the tool list is the full fixed set (unavailable tools are denied by policy, not removed). This keeps Claude's thinking blocks valid and the prompt cache warm. Runs in one conversation are serialised.
6. **No secrets in the browser.** API keys live only in server env vars; integration tokens are Fernet-encrypted (key derived from `JARVIS_SECRET_KEY`).
7. **Never fake functionality.** If something is not implemented or not configured, the UI says so (see Integrations "planned"). The scripted provider is a labelled test double, enabled only by `JARVIS_AI_PROVIDER=scripted`.
8. **Never auto-repeat irreversible actions.** Interrupted runs are failed on restart, not resumed; only idempotent tools/jobs retry.
9. The core's visual state comes only from `deriveCoreState` (`apps/web/src/lib/core-machine.ts`) fed by real events.

## Conventions
- Python: ruff (line length 120), typed, async everywhere, Pydantic models for every input (`extra="forbid"` for tool inputs).
- TypeScript: strict + `noUncheckedIndexedAccess`; zustand v5 selectors that build arrays must use `useShallow` (`useShallowJarvis`, `usePendingApprovals`).
- UI: use primitives in `apps/web/src/components/ui.tsx` and tokens in `globals.css`; trailing-slash routes (`/command/`) for static export.
- Claude API: official `anthropic` SDK only, default model `claude-opus-5-5`, adaptive thinking (omit `thinking`), effort via `output_config`, streaming with `eager_input_streaming` and self-validation of tool inputs.
