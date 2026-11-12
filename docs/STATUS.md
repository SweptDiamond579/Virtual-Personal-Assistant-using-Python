# Status — JARVIS OS beta (2026-11-12)

Legend: ✅ verified working · 🟡 implemented, partially verified or limited · ⛔ not implemented / deferred.
"Verified" means exercised by an automated test or an observed browser run in this environment — not just written.

## Mandatory verification checklist
| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | Dashboard starts | ✅ | E2E against the production build (FastAPI serving the static export) |
| 2 | Navigation works | ✅ | E2E visits all 10 workspaces; mobile bottom nav tested |
| 3 | Three.js scene renders without critical errors | ✅ | E2E reads `__JARVIS_CORE_STATS__` (38 draw calls, ~69k triangles); zero console errors |
| 4 | State transitions follow real events | ✅ | Unit-tested `deriveCoreState`; E2E observes Listening (live mic), Awaiting approval, Complete |
| 5 | AI conversation with valid credentials | 🟡 | **No Anthropic key was available in the build environment.** The Anthropic adapter is verified against recorded SSE wire formats (streaming text, tool use, thinking-block preservation, refusal, max_tokens, fallback beta, error mapping) and `api.anthropic.com` is reachable. A live call needs `ANTHROPIC_API_KEY`. The full loop is verified end to end with the labelled scripted test provider. |
| 6 | Conversation history persists | ✅ | pytest (messages persisted, listed and replayed via the API); the console restores the latest conversation on load (observed in browser runs) |
| 7 | Voice capture and output | ✅ / 🟡 | Mic capture → 16 kHz WAV → offline PocketSphinx → message verified in E2E with a fake audio device; eSpeak NG TTS returns real WAV (pytest). PocketSphinx accuracy is low (e.g. "hello world" → "that i will"); use a Whisper-compatible endpoint for quality. Not tested on physical devices. |
| 8 | Tool permissions enforced | ✅ | 11 policy unit tests; approve/deny/taint/emergency/client-kind tests; E2E |
| 9 | Real tool action with verified result | ✅ | `files_write` after approval: SHA-256 re-read verification (pytest + E2E); notes re-read; GitHub issue re-fetch |
| 10 | Unauthorised actions denied | ✅ | Unknown tools, extra arguments, unavailable desktop, emergency stop, wrong approver kind (pytest + E2E) |
| 11 | Desktop and mobile usable | ✅ / 🟡 | Mobile viewport E2E (no overflow, nav, core framed). Tauri app built and run under Xvfb with invoke round-trips; Windows/macOS installers configured but not built here |
| 12 | Credentials not exposed | ✅ | E2E checks HttpOnly session and that no secret appears in page HTML; tokens encrypted at rest (pytest) |
| 13 | Critical tests pass | ✅ | Backend 94 passed (+1 live-network test, passing when enabled); web unit 42; E2E 15; desktop 60 |

## Capabilities
### ✅ Verified
- Owner setup gated by one-time token; login/logout; session list/revoke; password change; CSRF; rate limits; security headers.
- Streaming orchestrator: model turns, tool loop, step limit, daily budget, cancellation, restart recovery (never resumes in-flight work), per-conversation serialisation, usage and cost tracking.
- Policy engine, approvals (bound, expiring, single-use, desktop-only for high-risk desktop actions), taint escalation, emergency stop.
- Tools verified by tests: time, calculator (safe AST), notes, reminders, upcoming reminders, memory propose/search, findings, email draft, workspace files (list/read/write with sandboxing), GitHub repo overview (live against the real GitHub API), headless browser snapshot (JS rendering, screenshot, private-network block).
- Memory: proposal → approval, conflict detection + supersede, private memories excluded from prompts, deletion and delete-all, retention purge for conversations.
- Scheduler: one-off and cron jobs, minimum interval, claim/lease, job history, retries only for idempotent kinds; workflows with dependencies, templating, failure propagation; daily briefing template.
- Realtime: ticketed WebSocket, origin check, event contract shared with TypeScript (contract test).
- Dashboard: 10 workspaces, command bar with direct tool commands, notifications, toasts, approval dock, PWA manifest + service worker, mobile layout.
- 3D core: 9 distinct states, audio-reactive listening/speaking, adaptive quality, 2D fallback, reduced motion, keyboard orbit/zoom, interactive nodes with DOM alternatives, stats probe. See `docs/screenshots/`.
- Desktop policy crate: 54 tests (traversal, symlink escape, overwrite refusal, size limits, read-only roots, emergency stop, fixed argv); app crate 6 tests (capability scoping, CSP, navigation rules).

### 🟡 Implemented, limited or not live-verified
- **Anthropic live responses** — needs `ANTHROPIC_API_KEY` (see #5). OpenAI-compatible adapter verified against a recorded stream only.
- **Email sending** — SMTP path implemented with approval and no-resend protection; not exercised against a real mail server.
- **GitHub write (create issue)** and **listing private repos** — implemented; need a user token to verify.
- **Weather, Wikipedia, web fetch to public sites** — implemented; outbound internet to those hosts is blocked in the build sandbox, so only SSRF/policy behaviour and local fixtures were verified.
- **Desktop app on Windows/macOS** — configured; compiled and cross-checked for Windows (cargo check); macOS compile needs Apple's toolchain. Pairing proof is code-based (see SECURITY.md).
- **3D performance** — measured only under software rendering (SwiftShader, ~1 FPS at high quality, 38 draw calls). 60 FPS on GPU hardware is a design target that was **not measured** here. Adaptive quality and DPR limits are implemented.
- **Semantic memory** — the default embedder is local feature hashing (lexical, not semantic). Retrieval uses pgvector pre-selection + keyword re-ranking. A neural embedding model was not available offline.
- **Browser speech engines** — Web Speech API / speechSynthesis options exist; they cannot be verified headlessly. The speaking animation with browser TTS is approximated from word boundaries (labelled in Settings).
- **Notifications** — in-app + browser notifications while a tab is open; Web Push to a closed PWA is not implemented.

### ⛔ Deferred
- Google (Gmail, Calendar, Drive), Microsoft 365, Notion, Slack connectors — shown as "planned" in Integrations, no fake toggles.
- Wake word, streaming (incremental) server STT and streaming TTS; barge-in is supported for playback only.
- Specialist sub-agents (research/development/productivity); a single orchestrator is used (see D-006).
- Sandboxed code execution / automated patch proposals in isolated branches.
- Multi-user, multi-process deployment (Redis for hub/rate limits).
- Signed desktop builds and auto-update.

## Blockers needing the owner
1. `ANTHROPIC_API_KEY` (or an OpenAI-compatible endpoint) to enable real AI conversations.
2. Optional: SMTP credentials, a GitHub fine-grained token, OAuth client credentials for future connectors.
3. Code-signing certificates (Apple Developer ID, Windows) for distributable desktop installers.

## Next steps
See [ROADMAP.md](ROADMAP.md).
