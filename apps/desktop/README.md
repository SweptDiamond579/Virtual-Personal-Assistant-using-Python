# JARVIS OS — desktop companion

A Tauri 2 desktop app that gives JARVIS a small set of native actions on this computer: launching a few
allowlisted apps and reading, writing and organizing files inside folders you choose. Everything it may do is
set in a **local policy file that only you edit**. The backend can ask for an action, but this app decides.

## Architecture and trust boundary

```
 JARVIS backend (FastAPI, :8000)          Desktop app (this package)
 ┌───────────────────────────┐   WS/REST  ┌──────────────────────────────────────────────────────┐
 │ orchestrator proposes a   │ ─────────▶ │ WebView: JARVIS web UI (loaded from the backend)     │
 │ DeviceActionRequest       │            │   invoke("execute_action", { action })               │
 │                           │ ◀───────── │        │ Tauri IPC (ACL: main window + loopback only) │
 │ receives DeviceActionResult│  result   │        ▼                                             │
 └───────────────────────────┘            │ Rust: jarvis-desktop  ──▶  jarvis-desktop-policy     │
                                          │   10 s timeout,           local policy.json, path    │
                                          │   blocking thread         checks, allowlist, e-stop, │
                                          │                           audit log                  │
                                          └──────────────────────────────────────────────────────┘
```

- The main window loads the JARVIS web UI from the backend. The web UI notices it is running inside Tauri and
  passes along the `device.action.request` events the backend sends. It calls `execute_action`, then posts a
  `DeviceActionResult` back to the backend.
- **The backend proposes, Rust enforces.** Rust checks every action again against the *local* policy, even
  when the backend asked for it. If the backend or the web UI is compromised, it can only do what the policy
  file allows. It cannot change the policy: no command writes it.
- The checks run in this order:
  1. **Tauri capability ACL** (`src-tauri/capabilities/main.json`). The three commands are granted only to the
     `main` window, and only while that window shows a page from `http://127.0.0.1:*` or `http://localhost:*`.
     `local: false` means bundled pages, such as the offline page, get nothing. The app grants no plugin or core
     permissions: there is no shell, fs, opener or dialog plugin, and no event API. `build.rs` declares an app
     manifest, so a command that is not explicitly granted is denied.
  2. **Strict deserialization.** `DesktopAction` is a tagged enum with `deny_unknown_fields`. Unknown actions and
     extra fields, such as `args` on `launch_app`, are rejected before anything runs.
  3. **Policy engine** (`crates/policy`). It checks the emergency stop, the root and app allowlists, whether the
     root is writable, path validation and canonicalization, and size limits. It then audits the outcome.
- Navigation is pinned to the JARVIS origin. `on_navigation` blocks any other origin and `on_new_window`
  denies pop-ups.
- Devtools are only in debug builds: the `devtools` cargo feature is not enabled, and the window builder sets
  `devtools(cfg!(debug_assertions))`.
- CSP: `tauri.conf.json` sets a strict CSP (`default-src 'self'`, no `unsafe-*`, `object-src 'none'`,
  `frame-ancestors 'none'`). Tauri applies it to the bundled offline page. Pages loaded from the backend use
  the CSP headers the backend sends, so **the backend should serve the web UI with its own strict CSP**.

### Crates (`src-tauri/` is a Cargo workspace)

| Crate | Path | Purpose |
| --- | --- | --- |
| `jarvis-desktop-policy` | `src-tauri/crates/policy` | Pure Rust, no Tauri. Holds the policy model, config load and save with a safe default, path validation, the app allowlist, every action implementation, the emergency stop and the JSONL audit log with rotation. Unit-tested with temporary directories. |
| `jarvis-desktop` | `src-tauri` | The Tauri app. It resolves the URL, creates the window and tray, and connects the commands to the policy engine. |

## Which URL is loaded (dev and release)

The window loads the URL found first in this order:

1. the `JARVIS_URL` environment variable,
2. the `url` field in `policy.json`,
3. `http://127.0.0.1:8000/`.

Dev and release builds resolve the URL the same way, at runtime. `tauri.conf.json` has no `devUrl` on purpose.
In dev mode Tauri would treat a `devUrl` origin as a *local* app origin, so the web UI would get different
permissions in dev than in release. `build.frontendDist` points to `fallback/`, a static offline page with no
scripts. A release build shows it when the backend is not reachable at startup. Start the backend, then choose
**Reload JARVIS** from the tray. Only `http://127.0.0.1:*` and `http://localhost:*` URLs get the desktop
commands. Any other URL still loads, but the app prints a warning and the UI runs without native actions.

## Run in development

Prerequisites: Rust 1.80 or newer, plus the Tauri system dependencies for your OS. On Debian/Ubuntu those are
`libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libssl-dev libxdo-dev`.

```bash
# 1. Start the JARVIS backend; it serves the web UI on http://127.0.0.1:8000/
# 2. In another terminal, from the repo root:
pnpm --filter @jarvis/desktop dev            # = tauri dev
# Optional: point at another local port
JARVIS_URL=http://127.0.0.1:3000/ pnpm --filter @jarvis/desktop dev
```

Tests and lints:

```bash
cd apps/desktop/src-tauri
cargo test -p jarvis-desktop-policy          # policy and enforcement unit tests
cargo test --workspace                       # also checks the capability, CSP and URL rules of the app crate
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```

## Commands

The web UI calls these with `import { invoke } from "@tauri-apps/api/core"`.

| Command | Arguments | Returns |
| --- | --- | --- |
| `desktop_info` | none | `{ version, os, emergency_stop, policy: { apps: [{id, label}], roots: [{id, label, path, writable}], max_file_bytes } }` |
| `execute_action` | `{ action: DesktopAction }` | Resolves with the action's result object; rejects with an error string |
| `set_emergency_stop` | `{ enabled: boolean }` | the new state (`boolean`) |

`DesktopAction` matches `packages/protocol/src/index.ts`:

| `action` | Fields | Result |
| --- | --- | --- |
| `status` | none | same as `desktop_info` (allowed during an emergency stop) |
| `launch_app` | `app_id` | `{ launched: app_id, pid }`. Runs the allowlisted program with its fixed argument array, detached, with no shell and no caller-supplied arguments. |
| `list_dir` | `root_id`, `path` | `{ entries: [{ name, kind: "file"\|"dir"\|"symlink", size, modified }], truncated }`. At most 500 entries, folders first, then by name. `path` `""` or `"."` is the root. `modified` is an RFC 3339 UTC string or `null`. |
| `read_text_file` | `root_id`, `path` | `{ content, truncated, bytes }`. UTF-8 only; binary content is rejected. Reads at most `max_file_bytes`. `bytes` is the file's size on disk. |
| `write_text_file` | `root_id`, `path`, `content`, `overwrite` | `{ path, bytes, created }`. Writable roots only. Fails if the file exists and `overwrite` is false. Writes a temp file in the same folder, then renames it into place. Creates missing parent folders, but only inside the root. Never writes through a symlink. |
| `organize_by_type` | `root_id`, `path`, `dry_run` | `{ moves: [{ from, to }], skipped: [{ from, to, reason }], applied }`. Writable roots only. Not recursive: moves the files directly in that folder into `Documents`, `Images`, `Audio`, `Video`, `Archives`, `Code` or `Other` by extension. Never overwrites: conflicts are skipped and listed. Hidden files and subfolders are left alone; symlinks are skipped. With `dry_run` it only returns the plan. |

All result paths are relative to the root and use `/`. Each action runs on a blocking thread. The UI gets an
error after **10 seconds**, which prevents a hang; the work itself is not cancelled and is audited when it
finishes.

### Bridge to add in the web UI (outside this package)

```ts
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { DeviceActionRequest, DeviceActionResult } from "@jarvis/protocol";

async function handleDeviceAction(req: DeviceActionRequest): Promise<DeviceActionResult> {
  if (Date.parse(req.expires_at) < Date.now()) return { request_id: req.request_id, ok: false, error: "expired" };
  try {
    const result = await invoke("execute_action", { action: req.action });
    return { request_id: req.request_id, ok: true, result };
  } catch (e) {
    return { request_id: req.request_id, ok: false, error: String(e) };
  }
}
```

## The policy file

| OS | Policy file |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/jarvis-desktop/policy.json` (normally `~/.config/jarvis-desktop/policy.json`) |
| macOS | `~/Library/Application Support/jarvis-desktop/policy.json` |
| Windows | `%APPDATA%\jarvis-desktop\policy.json` |

If the file is missing, the first start writes a safe default:

- **one root**: `sandbox`, a writable `~/JARVIS` folder that the app creates;
- **a few harmless apps**:
  - macOS: Calculator and TextEdit, via `/usr/bin/open -a <App>`;
  - Windows: `calc.exe` and `notepad.exe` from `System32`;
  - Linux: whichever of `gnome-calculator`, `gnome-text-editor` and `gedit` are on `PATH`, stored as absolute
    paths. `xdg-open` is never added.

```json
{
  "version": 1,
  "url": "http://127.0.0.1:8000/",
  "max_file_bytes": 1048576,
  "roots": [
    { "id": "sandbox", "label": "JARVIS sandbox", "path": "/home/me/JARVIS", "writable": true },
    { "id": "docs", "label": "Documents (read-only)", "path": "/home/me/Documents" }
  ],
  "apps": [
    { "id": "calculator", "label": "Calculator", "program": "/usr/bin/gnome-calculator", "args": [] }
  ]
}
```

Rules:

- **Only you change the policy**, by editing this file and restarting the app. No command or backend message
  can modify it.
- Roots are **read-only unless `"writable": true`**. A root path must be absolute and cannot be the filesystem
  root.
- `program` must be an absolute path; there is no `PATH` lookup at launch. `args` is fixed. Shells,
  interpreters and generic launchers are refused even if you list them. That covers `sh`, `bash`, `cmd`,
  `powershell`, `python`, `node`, `osascript`, `xdg-open`, `env`, `sudo` and similar programs, plus
  `.bat`/`.cmd`/`.ps1` files.
- `max_file_bytes` must be between 1 and 16 MiB (the default is 1 MiB).
- Unknown fields, duplicate ids and invalid values make the whole file invalid. The app then **fails closed**:
  it runs with no roots and no apps, logs the reason to stderr and the audit log, and leaves your file
  untouched.

Path rules for every file action:

- The app rejects absolute paths, `..` components, NUL and control characters, drive letters and UNC paths,
  and `:`, which also blocks NTFS alternate data streams. On Windows it also rejects reserved device names
  (`CON`, `NUL`, `COM1` and so on), the characters `<>"|?*`, and names ending in a dot or a space.
- The root and the target are canonicalized. A new file's parent is canonicalized one component at a time. The
  result must stay inside the canonical root, so a symlink that points outside the root is rejected.
- Scope: these checks protect against remote callers. A local process that already has write access inside the
  root could race them, but such a process already has the user's own access.

## Audit log

The app adds one JSON line per action, emergency-stop change and policy load:
`{"ts", "action", "params", "outcome": "ok"|"denied"|"error", "error"?}`. Parameters are sanitized: file
contents are never logged, only `content_bytes`, and long strings are clipped. On Unix the file is created with
mode `0600`. The log rotates at **5 MB** to `audit.jsonl.1`, then `.2` and `.3`.

| OS | Audit log |
| --- | --- |
| Linux | `$XDG_DATA_HOME/os.jarvis.desktop/audit.jsonl` (normally `~/.local/share/os.jarvis.desktop/audit.jsonl`) |
| macOS | `~/Library/Application Support/os.jarvis.desktop/audit.jsonl` |
| Windows | `%APPDATA%\os.jarvis.desktop\audit.jsonl` |

## Emergency stop

While the emergency stop is engaged, every `execute_action` call except `status` is rejected with
`emergency stop is active: ...`. You can engage or clear it in two ways:

- the **tray menu** → **Emergency stop** (a check item). The tray is local and the web UI cannot reach it;
- the web UI, via `invoke("set_emergency_stop", { enabled })`.

`desktop_info` and `status` report the current state; the web UI should poll them. The flag lives in memory
and resets when the app restarts. Every change is audited, with its source (`ui` or `tray`).

## Building installers

Bundle targets are set in `tauri.conf.json`: `nsis` and `msi` for Windows, `app` and `dmg` for macOS, `deb`
and `appimage` for Linux. Each installer must be built on its own OS:

```bash
# Windows (needs WebView2; the installer downloads the bootstrapper if it is missing)
pnpm --filter @jarvis/desktop tauri build --bundles nsis,msi
# macOS
pnpm --filter @jarvis/desktop tauri build --bundles app,dmg
# Linux
pnpm --filter @jarvis/desktop tauri build --bundles deb,appimage
```

Code signing is not configured. For macOS, add a signing identity and notarization through the
`APPLE_SIGNING_IDENTITY` and `APPLE_ID` environment variables. For Windows, set
`bundle.windows.certificateThumbprint` or use a signing service before distributing.

Icons: `app-icon.png` (1024×1024) is the source. To regenerate the icon set:

```bash
pnpm --filter @jarvis/desktop tauri icon app-icon.png
```

## Layout

```
apps/desktop/
├── app-icon.png              # icon source (JARVIS core glyph)
├── fallback/                 # bundled offline page (frontendDist), no scripts
└── src-tauri/
    ├── Cargo.toml            # workspace root + jarvis-desktop crate
    ├── build.rs              # app manifest: generates allow-* permissions for the 3 commands
    ├── tauri.conf.json
    ├── capabilities/main.json
    ├── icons/
    ├── src/                  # main.rs (setup, window), commands.rs, tray.rs, weburl.rs
    └── crates/policy/src/    # action, config, paths, fsops, launch, audit, error
```
