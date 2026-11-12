# Engineering decisions

**D-001 — Preserve the original project in `legacy/`.** The repository held a 2021 Windows voice assistant. It is kept verbatim for provenance; its useful features (weather, Wikipedia, email) were re-implemented as permission-checked tools.

**D-002 — One API process per owner.** FastAPI serves the static web export, REST, WebSocket and the scheduler. Simplest secure deployment (one origin: no CORS, same-site cookies). In-memory hub/rate limiter are acceptable for one owner; Redis is the documented path for multi-worker deployments.

**D-003 — Next.js static export in production, dev server in development.** The UI is client-rendered with no server data needs, so `output: "export"` is served by FastAPI and loaded by Tauri. `distDir` overrides are dev-only because Next uses `distDir` as the export directory.

**D-004 — Claude integration follows current API rules.** Official `anthropic` SDK (2.x, httpx2), default `claude-opus-5-5`, thinking omitted (adaptive; disabling returns 400), depth via `output_config.effort`, no forced `tool_choice`, streaming with `eager_input_streaming` and self-validation, stop on `refusal`/`max_tokens` before running tools, server-side refusal fallback (`fallbacks: "default"`) on supporting models, automatic prompt caching. Because thinking blocks are bound to the conversation prefix, history is append-only, the system prompt is static, the tool set never changes within a conversation, and runs in a conversation are serialised.

**D-005 — Provider-neutral history blocks.** Messages store neutral blocks (`text`, `tool_call`, `tool_result`, `opaque`). Opaque blocks (e.g. Claude thinking with signatures) replay only to the provider that produced them.

**D-006 — One orchestrator, no specialist agents yet.** Specialists add cost and coordination overhead; they will be added only where measurable value is shown (ROADMAP). All delegated work would use the same executor and could not widen permissions.

**D-007 — Policy decides, not the model.** Risk levels, default policies and approval gates live in code; agents cannot alter them. High-risk tools cannot default to auto. Taint tracking escalates side effects after untrusted input.

**D-008 — Desktop actions are relayed, enforced in Rust.** The backend never executes desktop actions; it routes requests to the paired desktop's session, whose Tauri layer validates them against a local, user-edited policy file. Capabilities are scoped to localhost origins only.

**D-009 — PostgreSQL + pgvector; no Redis yet.** Jobs use `FOR UPDATE SKIP LOCKED` leases in Postgres. Redis would only be needed for multi-process fan-out.

**D-010 — Offline-first voice defaults.** PocketSphinx STT and eSpeak NG TTS run locally (no audio leaves the server); WAV playback through Web Audio lets the core react to real speech amplitude. Cloud Whisper/TTS via OpenAI-compatible endpoints and browser engines are opt-in.

**D-011 — Local hashing embedder by default.** Neural embedding models could not be downloaded in the build environment; feature hashing gives deterministic lexical retrieval with pgvector pre-selection. Swappable later (embedder name stored per memory).

**D-012 — Scripted provider as a labelled test double.** Enables deterministic E2E tests of the whole stack. Enabled only by explicit configuration and badged in the UI as "Scripted test provider".

**D-013 — Model routing heuristic.** With routing `auto`, short requests without complexity keywords use the fast model at low effort (user-requested cost control); everything else uses the primary model. Configurable to `fixed`.

**D-014 — Zustand v5 selectors.** Selectors that derive arrays must use `useShallow`; unstable references caused infinite render loops (found in browser testing).
