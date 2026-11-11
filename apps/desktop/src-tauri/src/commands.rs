//! Tauri commands exposed to the JARVIS web UI.
//!
//! Only the main window, and only while it shows a page from
//! `http://127.0.0.1:*` or `http://localhost:*`, may call these
//! (see `capabilities/main.json` and `build.rs`).
//!
//! From the web UI:
//! ```js
//! import { invoke } from "@tauri-apps/api/core";
//! const info = await invoke("desktop_info");
//! const result = await invoke("execute_action", { action: { action: "list_dir", root_id: "sandbox", path: "" } });
//! const stopped = await invoke("set_emergency_stop", { enabled: true });
//! ```

use std::time::Duration;

use serde_json::Value;
use tauri::{AppHandle, State};

use jarvis_desktop_policy::{DesktopAction, DesktopInfo};

use crate::AppState;

/// Upper bound for one action. The UI gets an error after this; the blocking
/// work itself is not cancelled (it is audited when it finishes).
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(10);

#[tauri::command]
pub fn desktop_info(state: State<'_, AppState>) -> DesktopInfo {
    state.engine.info()
}

#[tauri::command]
pub async fn execute_action(state: State<'_, AppState>, action: DesktopAction) -> Result<Value, String> {
    let engine = state.engine.clone();
    let task = tauri::async_runtime::spawn_blocking(move || engine.execute(action));
    match tokio::time::timeout(ACTION_TIMEOUT, task).await {
        Ok(Ok(result)) => result.map_err(|e| e.to_string()),
        Ok(Err(_join_error)) => Err("desktop action failed unexpectedly".into()),
        Err(_elapsed) => Err(format!(
            "desktop action timed out after {} seconds",
            ACTION_TIMEOUT.as_secs()
        )),
    }
}

#[tauri::command]
pub fn set_emergency_stop(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> bool {
    let now = state.engine.set_emergency_stop(enabled, "ui");
    crate::tray::sync_emergency_stop(&app, now);
    now
}
