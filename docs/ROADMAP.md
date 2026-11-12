# Roadmap

## Sprint (5-day target) — delivered in this beta
- [x] Day 1 — monorepo, design system, real Three.js core, responsive workspaces, typed state machine, backend/desktop scaffolds, test tooling
- [x] Day 2 — authenticated backend, provider abstraction, streaming conversations, persistence, memory retrieval, usage monitoring *(live Claude call pending an API key)*
- [x] Day 3 — push-to-talk, offline STT/TTS, audio-reactive core, tool registry, permissions, approvals, verified tool execution
- [x] Day 4 — bounded workflows, DB-backed scheduler, GitHub integration, Tauri desktop actions, PWA, task monitoring, notifications
- [x] Day 5 — E2E suite, security checks, CI, docs, mobile pass *(GPU performance profiling and signed installers outstanding)*

## Next milestones
1. **Live AI verification** — run the E2E suite against Claude with a real key; add an eval set (tool selection accuracy, refusal of injected instructions, cost per task).
2. **Security hardening** — DNS-pinned transport for the SSRF guard; desktop device keys and signed action results; optional TOTP second factor; per-tool rate limits.
3. **Voice quality** — Whisper-compatible STT by default when configured; streaming transcription and streaming TTS; optional on-device wake word with explicit opt-in.
4. **Connectors** — Google Calendar/Gmail/Drive and Microsoft 365 via OAuth (minimal scopes, refresh, revocation); calendar view in Personal Assistant; Web Push for closed PWAs.
5. **Semantic memory** — pluggable embedding providers with re-embedding migration.
6. **Specialist agents** — research and development agents with structured I/O through the same executor, adopted only if evaluations show gains.
7. **Self-improvement loop** — evaluation runs on feedback-flagged traces; development agent proposes patches on isolated branches with tests, never auto-deployed.
8. **Distribution** — signed Windows/macOS desktop builds, auto-update, GPU performance profiling on reference hardware.
