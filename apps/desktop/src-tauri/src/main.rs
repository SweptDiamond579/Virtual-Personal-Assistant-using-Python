//! JARVIS OS desktop companion.
//!
//! The main window loads the JARVIS web UI from the local backend. The web UI
//! relays action requests from the backend to [`commands::execute_action`],
//! where the local policy (`jarvis-desktop-policy`) is the final authority:
//! the backend proposes, this process decides.

// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod tray;
mod weburl;

use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{App, Manager, Url, WebviewUrl, WebviewWindowBuilder};

use jarvis_desktop_policy::{load_or_create, AuditLog, DesktopConfig, Engine, LoadOutcome, Outcome};

pub const MAIN_WINDOW: &str = "main";
/// Near-black JARVIS background (#010309), shown before the page paints.
const BACKGROUND: Color = Color(0x01, 0x03, 0x09, 0xff);

/// Shared state for commands and the tray.
pub struct AppState {
    pub engine: Arc<Engine>,
    /// The JARVIS web UI URL the main window loads.
    pub url: Url,
}

/// Location of the user-editable policy: `<OS config dir>/jarvis-desktop/policy.json`.
fn policy_path(app: &App) -> tauri::Result<PathBuf> {
    Ok(app.path().config_dir()?.join("jarvis-desktop").join("policy.json"))
}

/// Location of the audit log: `<app data dir>/audit.jsonl`.
fn audit_path(app: &App) -> tauri::Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("audit.jsonl"))
}

fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    let policy_file = policy_path(app)?;
    let home = app.path().home_dir()?;
    let audit = AuditLog::new(audit_path(app)?);

    let (config, load_error) = match load_or_create(&policy_file, &home) {
        Ok((config, outcome)) => {
            if outcome == LoadOutcome::CreatedDefault {
                eprintln!("jarvis-desktop: wrote default policy to {}", policy_file.display());
            }
            (config, None)
        }
        Err(e) => {
            eprintln!(
                "jarvis-desktop: policy {} rejected ({e}); running with a locked-down policy (no roots, no apps)",
                policy_file.display()
            );
            (DesktopConfig::locked_down(), Some(e.to_string()))
        }
    };
    let config_url = config.url.clone();
    let engine = Arc::new(Engine::new(config, env!("CARGO_PKG_VERSION"), Some(audit)));
    engine.record(
        "policy_load",
        json!({ "roots": engine.config().roots.len(), "apps": engine.config().apps.len() }),
        if load_error.is_some() {
            Outcome::Error
        } else {
            Outcome::Ok
        },
        load_error,
    );

    let env_url = std::env::var(weburl::URL_ENV).ok();
    let (url, warnings) = weburl::resolve(env_url.as_deref(), config_url.as_deref());
    for w in warnings {
        eprintln!("jarvis-desktop: {w}");
    }

    app.manage(AppState {
        engine,
        url: url.clone(),
    });
    app.manage(tray::TrayState::default());

    create_main_window(app, &url)?;

    if let Err(e) = tray::setup(app.handle()) {
        // A missing tray (e.g. no StatusNotifier host on Linux) is not fatal.
        eprintln!("jarvis-desktop: tray unavailable: {e}");
    }
    Ok(())
}

fn create_main_window(app: &App, url: &Url) -> tauri::Result<()> {
    // In release builds show the bundled offline page if the backend is not
    // reachable yet; "Reload JARVIS" in the tray retries.
    let start = if cfg!(debug_assertions) || backend_reachable(url) {
        WebviewUrl::External(url.clone())
    } else {
        WebviewUrl::App("index.html".into())
    };
    let home = url.clone();
    WebviewWindowBuilder::new(app, MAIN_WINDOW, start)
        .title("JARVIS OS")
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 640.0)
        .center()
        .background_color(BACKGROUND)
        .devtools(cfg!(debug_assertions))
        .on_navigation(move |target| {
            let allowed = weburl::navigation_allowed(target, &home);
            if !allowed {
                eprintln!("jarvis-desktop: blocked navigation to {target}");
            }
            allowed
        })
        .on_new_window(|target, _features| {
            eprintln!("jarvis-desktop: blocked new window for {target}");
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

fn backend_reachable(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let Some(port) = url.port_or_known_default() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs
        .into_iter()
        .any(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::desktop_info,
            commands::execute_action,
            commands::set_emergency_stop
        ])
        .setup(setup)
        .run(tauri::generate_context!())
        .expect("error while running JARVIS OS");
}

#[cfg(test)]
mod capability_tests {
    //! Guard the security-relevant configuration files against regressions.

    use std::str::FromStr;

    use serde_json::Value;
    use tauri::Url;
    use tauri_utils::acl::RemoteUrlPattern;

    fn load(path: &str) -> Value {
        let full = concat!(env!("CARGO_MANIFEST_DIR"), "/").to_owned() + path;
        serde_json::from_str(&std::fs::read_to_string(full).unwrap()).unwrap()
    }

    #[test]
    fn capability_grants_only_our_commands_to_main_window_on_loopback() {
        let cap = load("capabilities/main.json");
        assert_eq!(cap["windows"], serde_json::json!(["main"]));
        assert_eq!(cap["local"], false);
        let perms: Vec<&str> = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.as_str().unwrap())
            .collect();
        assert_eq!(
            perms,
            vec!["allow-desktop-info", "allow-execute-action", "allow-set-emergency-stop"]
        );
        assert!(perms.iter().all(|p| !p.contains(':')), "no plugin or core permissions");

        let patterns: Vec<RemoteUrlPattern> = cap["remote"]["urls"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| RemoteUrlPattern::from_str(u.as_str().unwrap()).unwrap())
            .collect();
        let allowed = |u: &str| patterns.iter().any(|p| p.test(&Url::parse(u).unwrap()));
        assert!(allowed("http://127.0.0.1:8000/"));
        assert!(allowed("http://127.0.0.1:8000/chat/abc?x=1#y"));
        assert!(allowed("http://localhost:3000/"));
        assert!(!allowed("https://127.0.0.1:8000/"));
        assert!(!allowed("http://127.0.0.2:8000/"));
        assert!(!allowed("http://localhost.evil.com:8000/"));
        assert!(!allowed("http://evil.com/?http://127.0.0.1:8000/"));
        assert!(!allowed("tauri://localhost/index.html"));
    }

    #[test]
    fn config_has_no_plugins_and_a_strict_csp() {
        let conf = load("tauri.conf.json");
        assert_eq!(conf["identifier"], "os.jarvis.desktop");
        assert_eq!(conf["productName"], "JARVIS OS");
        assert_eq!(conf["app"]["withGlobalTauri"], false);
        assert!(conf.get("plugins").is_none());
        let csp = &conf["app"]["security"]["csp"];
        assert_eq!(csp["default-src"], "'self'");
        assert_eq!(csp["object-src"], "'none'");
        assert!(!csp.to_string().contains("unsafe"));
    }
}
