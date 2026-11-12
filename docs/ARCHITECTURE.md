# Architecture

```
 Browser / PWA / Tauri webview ──HTTPS (cookie + CSRF)──▶ FastAPI (apps/api)
        ▲   │                                           │  auth · REST · static export
        │   └──── WebSocket (single-use ticket) ◀────────┤  realtime event hub
        │                                                │
  Tauri Rust policy ◀── device.action.request (relay) ───┤  Orchestrator ─▶ Model providers
  (apps/desktop)    ──▶ POST result (desktop session) ──▶│     │              (Anthropic · OpenAI-compatible · scripted)
                                                         │     ▼
                                                         │  Executor: validate → policy → approval → run → verify → audit
                                                         │     │
                                                         │     ▼
                                                         │  Tools: notes · reminders · memory · files · web · browser
                                                         │         GitHub · email · desktop · calculator · time …
                                                         │
                                                         ├─ Scheduler (DB-backed) ─▶ reminders · workflows · agent tasks · health
                                                         └─ PostgreSQL + pgvector (Alembic migrations)
```

## Processes
One API process per owner. It serves the static Next.js export, the REST API, the WebSocket, and runs the scheduler loop. In development, `next dev` (port 3000) proxies `/api/*` to the API and the browser connects its WebSocket to port 8000 directly. The single-process model is a deliberate beta simplification (D-002); the hub and rate limiter are in-memory and would move to Redis for multi-worker deployments.

## Backend modules (`apps/api/jarvis`)
| Module | Responsibility |
|---|---|
| `config.py` | Settings from environment; secrets never serialised to clients |
| `db/` | SQLAlchemy 2 async models; Alembic migrations in `apps/api/alembic` |
| `security/` | Argon2 passwords, sessions, CSRF, WS tickets, Fernet credential encryption, SSRF guard, rate limiter, audit log |
| `providers/` | Provider-neutral turn interface; Anthropic (official SDK), OpenAI-compatible, scripted test double; pricing and routing |
| `orchestrator/` | `engine.py` (runs, agent loop, budgets, cancellation, recovery, per-conversation serialisation), `executor.py` (the single tool-call path), `prompts.py` |
| `tools/` | Tool framework, policy engine, 27 built-in tools |
| `services/` | Approvals, notifications, user settings, device routing, system status |
| `memory/` | Proposal/approval pipeline, conflict detection, hybrid retrieval (pgvector pre-selection + keyword re-rank) |
| `voice/` | Offline STT (PocketSphinx) / TTS (eSpeak NG) and OpenAI-compatible engines |
| `workflows/` | Job creation, DB-backed scheduler, bounded workflow engine and templates |
| `integrations/` | GitHub REST, SMTP, Playwright browser |
| `realtime/` | In-process event hub (per-user fan-out, device-targeted events) |
| `api/` | Routers: auth, realtime, chat/runs/tools/approvals, knowledge, automation, system |

## A chat turn, end to end
1. `POST /api/chat` stores the visible user message, creates a `Run` (status `queued`) and spawns the run task. Runs in one conversation take a per-conversation lock, so turns never interleave.
2. The run retrieves approved, model-shareable memories, builds a context preamble (time, memories) and **persists** the exact user turn it sends, so history stays append-only.
3. The provider streams the turn; text deltas fan out as `assistant.delta`; the final turn (including opaque thinking blocks) is persisted with usage/cost.
4. Each tool call goes through `execute_tool_call`: Pydantic validation (`extra="forbid"`) → policy decision → optional approval (bound to an argument hash, expiring, possibly requiring a desktop session) → execution with timeout and bounded retry for idempotent tools → outcome verification → step record → `tool.started/finished` events → audit for side effects.
5. Results return to the model; untrusted results are fenced and taint the run. The loop ends on a final answer, the step limit, the daily budget, cancellation, emergency stop or a provider error — each reported honestly to the user.

## Frontend (`apps/web`)
- `lib/store.ts` — zustand store reducing server events; `lib/realtime.ts` — ticketed WebSocket with reconnect and query invalidation; `lib/core-machine.ts` — pure core-state derivation.
- `components/core` — React Three Fiber scene (nucleus shader, rings, instanced particles, neural network with travelling pulses, filaments, selective bloom), adaptive quality, 2D fallback, mini indicator, stats probe.
- `components/shell` — navigation, command bar (cmdk), notifications, toasts; `components/approvals.tsx` — approval cards and dock.
- `app/(app)/*` — the ten workspaces; `app/login` — sign-in and first-run setup; `app/dev/core` — visual review harness.
- `lib/voice.ts` — push-to-talk capture (AudioWorklet → 16 kHz WAV), analysers for real input/output levels, server or browser STT/TTS.
- `lib/desktop-bridge.ts` — relays device actions to Tauri `invoke("execute_action")` and mirrors the emergency stop.

## Desktop (`apps/desktop`)
The Tauri window loads the JARVIS server URL. Three commands (`desktop_info`, `execute_action`, `set_emergency_stop`) are granted only to the main window on `http://127.0.0.1:*`/`http://localhost:*`. All enforcement lives in the pure-Rust `jarvis-desktop-policy` crate (path sandboxing, app allow-list with fixed argv, size limits, timeouts, JSONL audit). See `apps/desktop/README.md`.

## Data model highlights
`runs`/`run_steps` (execution traces), `approvals` (argument-bound), `messages.blocks` (provider-neutral replay blocks), `memories` (pgvector `vector` column + provenance, conflicts, privacy), `scheduled_jobs`/`job_runs`, `integrations` (encrypted tokens), `audit_logs`, `usage_records`, `user_settings`, `feedback`.
