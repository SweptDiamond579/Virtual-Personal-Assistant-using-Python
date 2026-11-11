//! System tray: show/reload the window, toggle the emergency stop, quit.
//!
//! The tray is a purely local control surface: the web UI cannot reach it.

use std::sync::Mutex;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Wry};

use crate::AppState;

const SHOW: &str = "show";
const RELOAD: &str = "reload";
const ESTOP: &str = "emergency-stop";
const QUIT: &str = "quit";

/// Handle to the tray's "Emergency stop" check item, so UI-initiated changes
/// are reflected in the tray.
#[derive(Default)]
pub struct TrayState(Mutex<Option<CheckMenuItem<Wry>>>);

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, SHOW, "Show JARVIS OS", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, RELOAD, "Reload JARVIS", true, None::<&str>)?;
    let estop = CheckMenuItem::with_id(app, ESTOP, "Emergency stop", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT, "Quit JARVIS OS", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &reload,
            &PredefinedMenuItem::separator(app)?,
            &estop,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("jarvis")
        .tooltip("JARVIS OS")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW => show_main(app),
            RELOAD => reload_main(app),
            ESTOP => {
                let state = app.state::<AppState>();
                let enabled = !state.engine.emergency_stop();
                state.engine.set_emergency_stop(enabled, "tray");
                sync_emergency_stop(app, enabled);
            }
            QUIT => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    if let Some(state) = app.try_state::<TrayState>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(estop);
    }
    Ok(())
}

/// Reflect the emergency-stop state in the tray check item.
pub fn sync_emergency_stop(app: &AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Some(item) = state.0.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            let _ = item.set_checked(enabled);
        }
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(crate::MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn reload_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(crate::MAIN_WINDOW) {
        let url = app.state::<AppState>().url.clone();
        let _ = w.navigate(url);
        let _ = w.show();
    }
}
