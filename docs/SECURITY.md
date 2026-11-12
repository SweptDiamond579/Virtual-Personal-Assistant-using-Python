# Security model

## Trust boundaries
| Boundary | Trusted side | Untrusted side | Enforcement |
|---|---|---|---|
| Browser ↔ API | API | Any HTTP client | Session cookie (HttpOnly, SameSite=Lax), CSRF header on every unsafe request, rate limits, Pydantic validation |
| WebSocket | API | Any WS client | Single-use 30 s ticket from an authenticated request; Origin allow-list |
| Model ↔ tools | Executor/policy | The model's tool calls | Schema validation (`extra="forbid"`), policy engine, approvals, timeouts, audit; no shell tool exists |
| External content ↔ model | System prompt | Web pages, repos, emails | `<untrusted_content>` fencing, run taint → approval for side effects, prompt rules |
| Server ↔ internet | API | Model-chosen URLs | SSRF guard: http(s) only, no credentials, standard ports, public IPs only, re-checked per redirect and per browser sub-request |
| Backend ↔ desktop | Desktop Rust policy | Backend requests | Rust validates every action against the local policy file; paths sandboxed; app allow-list with fixed argv |
| Remote client ↔ desktop privileges | Desktop session | Web/mobile sessions | High-risk desktop actions can only be approved from the paired desktop session |

## Authentication & sessions
- Single owner account created with a one-time `JARVIS_SETUP_TOKEN`; Argon2id hashes; constant-time failure path (no username enumeration).
- Sessions: 256-bit random token in an HttpOnly cookie, only its SHA-256 stored; expiry; revocation per session; password change revokes all other sessions.
- CSRF: per-session token, required in `X-CSRF-Token` for all non-GET requests.
- Rate limits: login (per IP and per username), setup, chat, commands, voice, GitHub connect, pairing.
- Security headers: CSP for pages, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, COOP, HSTS when secure cookies are on; API responses are `no-store`.

## Permission engine (`apps/api/jarvis/tools/policy.py`)
Evaluation order: emergency stop → unmet requirement → user deny → critical always asks → user override (`auto` honoured only up to medium risk) → tool default → taint escalation → web domain allow-list. Agents cannot modify policy: overrides, allow-list and budgets are only writable by authenticated, CSRF-protected user requests, and the registry refuses high-risk tools that default to `auto`.

## Approvals
Bound to the SHA-256 of the canonical tool name + arguments, expiring (default 10 min), single-use, optionally restricted to a client kind (`desktop`), audited. After approval the executor re-checks the binding and the emergency stop before running.

## Prompt injection & exfiltration
- Untrusted tool output is fenced and labelled; the static system prompt forbids following embedded instructions or putting user data into URLs.
- Taint tracking: once untrusted content enters a run, every side-effecting tool in that run requires approval.
- Network tools to domains outside the allow-list require approval, which shows the exact URL.
- Memory proposals that look like credentials are refused; private memories are never sent to the model.

## Credentials
- API keys: server environment only, never sent to the browser.
- Integration tokens: Fernet (AES-128-CBC + HMAC) with a key derived by HKDF-SHA256 from `JARVIS_SECRET_KEY`; destroyed on revocation; never returned by the API.

## Emergency stop
Cancels all active runs and pending approvals, blocks side-effecting tools, defers scheduled jobs, and is mirrored to paired desktops' local kill switch. The desktop also has its own local stop (tray / UI) independent of the server.

## Audit
`audit_logs` records authentication, approvals, side-effecting and denied tool calls (with redacted arguments), policy and allow-list changes, memory changes, integrations, devices and emergency stops. The desktop keeps its own JSONL audit log.

## Known limitations (beta)
- **DNS rebinding:** the SSRF guard resolves then connects separately; a rebinding host could switch addresses between check and connect. Mitigation planned: pin resolved IPs in a custom transport.
- **Desktop pairing proof:** pairing proves possession of a session plus a short-lived code, not that the caller is the Tauri app. A browser that pairs could receive action requests and forge results, but cannot execute anything locally (execution only happens in Rust). Planned: device key pair generated in Rust and signed results.
- **Single process:** rate limits and the event hub are in-memory.
- **Browser STT:** choosing the browser speech engine sends audio to the browser vendor (Google in Chrome); the default is the offline server engine.
- **No multi-user support:** the system is designed for one owner.
- **Desktop dependency notices:** `cargo audit` reports no vulnerabilities, but two informational advisories in Tauri's Linux GTK stack: `proc-macro-error` unmaintained (RUSTSEC-2024-0370) and `glib` 0.18 `VariantStrIter` unsoundness (RUSTSEC-2024-0429, an API JARVIS does not call). They clear when Tauri moves to newer gtk-rs releases.
