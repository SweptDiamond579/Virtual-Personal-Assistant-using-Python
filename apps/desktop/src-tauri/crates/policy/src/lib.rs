//! # jarvis-desktop-policy
//!
//! The enforcement core of the JARVIS OS desktop companion. It has no Tauri
//! dependency so it can be tested in isolation.
//!
//! Trust model: the backend *proposes* actions, the web UI relays them, and
//! this crate *decides*. Every [`DesktopAction`] is checked against the local
//! [`DesktopConfig`] (edited only by the user on this computer), the emergency
//! stop flag, and the path rules in [`paths`], then audited.

pub mod action;
pub mod audit;
pub mod config;
pub mod error;
pub mod fsops;
pub mod launch;
pub mod paths;

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::{json, Value};

pub use action::DesktopAction;
pub use audit::{AuditEntry, AuditLog, Outcome};
pub use config::{load_or_create, ConfigError, DesktopConfig, LoadOutcome};
pub use error::ActionError;

use paths::{canonical_root, RelPath};

/// Payload of `desktop_info` and of the `status` action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DesktopInfo {
    pub version: String,
    pub os: String,
    pub emergency_stop: bool,
    pub policy: PolicySummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PolicySummary {
    pub apps: Vec<AppSummary>,
    pub roots: Vec<RootSummary>,
    pub max_file_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppSummary {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RootSummary {
    pub id: String,
    pub label: String,
    pub path: String,
    pub writable: bool,
}

/// Validates, executes and audits desktop actions. Cheap to share via `Arc`.
#[derive(Debug)]
pub struct Engine {
    config: DesktopConfig,
    version: String,
    emergency_stop: AtomicBool,
    audit: Option<AuditLog>,
}

impl Engine {
    /// `config` must already be validated (see [`DesktopConfig::validate`]);
    /// if it is not, the engine falls back to a locked-down policy.
    pub fn new(config: DesktopConfig, version: impl Into<String>, audit: Option<AuditLog>) -> Self {
        let config = if config.validate().is_ok() {
            config
        } else {
            DesktopConfig::locked_down()
        };
        Engine {
            config,
            version: version.into(),
            emergency_stop: AtomicBool::new(false),
            audit,
        }
    }

    pub fn config(&self) -> &DesktopConfig {
        &self.config
    }

    pub fn info(&self) -> DesktopInfo {
        DesktopInfo {
            version: self.version.clone(),
            os: std::env::consts::OS.to_owned(),
            emergency_stop: self.emergency_stop(),
            policy: PolicySummary {
                apps: self
                    .config
                    .apps
                    .iter()
                    .map(|a| AppSummary {
                        id: a.id.clone(),
                        label: a.label.clone(),
                    })
                    .collect(),
                roots: self
                    .config
                    .roots
                    .iter()
                    .map(|r| RootSummary {
                        id: r.id.clone(),
                        label: r.label.clone(),
                        path: r.path.display().to_string(),
                        writable: r.writable,
                    })
                    .collect(),
                max_file_bytes: self.config.max_file_bytes,
            },
        }
    }

    pub fn emergency_stop(&self) -> bool {
        self.emergency_stop.load(Ordering::SeqCst)
    }

    /// Engage or clear the emergency stop. `source` (e.g. "ui", "tray") is
    /// recorded in the audit log. Returns the new state.
    pub fn set_emergency_stop(&self, enabled: bool, source: &str) -> bool {
        let previous = self.emergency_stop.swap(enabled, Ordering::SeqCst);
        if previous != enabled {
            self.record(
                "set_emergency_stop",
                json!({ "enabled": enabled, "source": source }),
                Outcome::Ok,
                None,
            );
        }
        enabled
    }

    /// Record an arbitrary event (e.g. policy load problems) in the audit log.
    pub fn record(&self, action: &str, params: Value, outcome: Outcome, error: Option<String>) {
        if let Some(log) = &self.audit {
            if let Err(e) = log.record(&AuditEntry::now(action, params, outcome, error)) {
                eprintln!("jarvis-desktop: failed to write audit log: {e}");
            }
        }
    }

    /// Validate and run one action, then audit the outcome.
    pub fn execute(&self, action: DesktopAction) -> Result<Value, ActionError> {
        let name = action.name();
        let params = action.audit_params();
        let result = self.execute_inner(action);
        match &result {
            Ok(_) => self.record(name, params, Outcome::Ok, None),
            Err(e) => {
                let outcome = if e.is_denial() { Outcome::Denied } else { Outcome::Error };
                self.record(name, params, outcome, Some(e.to_string()));
            }
        }
        result
    }

    fn execute_inner(&self, action: DesktopAction) -> Result<Value, ActionError> {
        if matches!(action, DesktopAction::Status {}) {
            return to_value(self.info());
        }
        if self.emergency_stop() {
            return Err(ActionError::EmergencyStop);
        }
        let max = self.config.max_file_bytes;
        match action {
            DesktopAction::Status {} => unreachable!("handled above"),
            DesktopAction::LaunchApp { app_id } => {
                let app = self
                    .config
                    .app(&app_id)
                    .ok_or_else(|| ActionError::UnknownApp(app_id.clone()))?;
                let pid = launch::launch(app)?;
                Ok(json!({ "launched": app_id, "pid": pid }))
            }
            DesktopAction::ListDir { root_id, path } => {
                let (root, rel) = self.resolve(&root_id, &path, false)?;
                to_value(fsops::list_dir(&root, &rel)?)
            }
            DesktopAction::ReadTextFile { root_id, path } => {
                let (root, rel) = self.resolve(&root_id, &path, false)?;
                to_value(fsops::read_text_file(&root, &rel, max)?)
            }
            DesktopAction::WriteTextFile {
                root_id,
                path,
                content,
                overwrite,
            } => {
                let size = content.len() as u64;
                if size > max {
                    return Err(ActionError::TooLarge {
                        actual: size,
                        limit: max,
                    });
                }
                let (root, rel) = self.resolve(&root_id, &path, true)?;
                to_value(fsops::write_text_file(&root, &rel, &content, overwrite, max)?)
            }
            DesktopAction::OrganizeByType { root_id, path, dry_run } => {
                let (root, rel) = self.resolve(&root_id, &path, true)?;
                to_value(fsops::organize_by_type(&root, &rel, dry_run)?)
            }
        }
    }

    /// Look up the root, enforce writability, validate the path lexically and
    /// canonicalize the root.
    fn resolve(&self, root_id: &str, path: &str, write: bool) -> Result<(std::path::PathBuf, RelPath), ActionError> {
        let root = self
            .config
            .root(root_id)
            .ok_or_else(|| ActionError::UnknownRoot(root_id.to_owned()))?;
        if write && !root.writable {
            return Err(ActionError::ReadOnlyRoot(root_id.to_owned()));
        }
        let rel = RelPath::parse(path)?;
        let canonical = canonical_root(root_id, &root.path)?;
        Ok((canonical, rel))
    }
}

fn to_value<T: Serialize>(v: T) -> Result<Value, ActionError> {
    serde_json::to_value(v).map_err(|e| ActionError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AppConfig, RootConfig};
    use std::fs;
    use std::path::Path;

    struct Fixture {
        _dirs: Vec<tempfile::TempDir>,
        engine: Engine,
        rw: std::path::PathBuf,
        ro: std::path::PathBuf,
        audit: std::path::PathBuf,
    }

    fn fixture() -> Fixture {
        let rw = tempfile::tempdir().unwrap();
        let ro = tempfile::tempdir().unwrap();
        let logs = tempfile::tempdir().unwrap();
        let mut config = DesktopConfig::locked_down();
        config.max_file_bytes = 64;
        config.roots = vec![
            RootConfig {
                id: "sandbox".into(),
                label: "Sandbox".into(),
                path: rw.path().into(),
                writable: true,
            },
            RootConfig {
                id: "docs".into(),
                label: "Docs".into(),
                path: ro.path().into(),
                writable: false,
            },
        ];
        if let Some(touch) = ["/usr/bin/touch", "/bin/touch"]
            .into_iter()
            .find(|p| Path::new(p).is_file())
        {
            config.apps.push(AppConfig {
                id: "toucher".into(),
                label: "Toucher".into(),
                program: touch.into(),
                args: vec![rw.path().join("launched").to_string_lossy().into_owned()],
            });
        }
        config.validate().unwrap();
        let audit = logs.path().join("audit.jsonl");
        let engine = Engine::new(config, "9.9.9", Some(AuditLog::new(&audit)));
        Fixture {
            rw: rw.path().into(),
            ro: ro.path().into(),
            audit,
            engine,
            _dirs: vec![rw, ro, logs],
        }
    }

    fn act(v: Value) -> DesktopAction {
        serde_json::from_value(v).unwrap()
    }

    fn audit_lines(f: &Fixture) -> Vec<Value> {
        fs::read_to_string(&f.audit)
            .unwrap_or_default()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    #[test]
    fn status_matches_desktop_info_shape() {
        let f = fixture();
        let v = f.engine.execute(act(json!({"action": "status"}))).unwrap();
        assert_eq!(v["version"], "9.9.9");
        assert_eq!(v["os"], std::env::consts::OS);
        assert_eq!(v["emergency_stop"], false);
        assert_eq!(v["policy"]["max_file_bytes"], 64);
        assert_eq!(v["policy"]["roots"][0]["id"], "sandbox");
        assert_eq!(v["policy"]["roots"][0]["writable"], true);
        assert_eq!(v["policy"]["roots"][1]["writable"], false);
        assert!(v["policy"]["roots"][0]["path"].is_string());
        assert_eq!(serde_json::to_value(f.engine.info()).unwrap(), v);
        let keys: Vec<_> = v.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys.len(), 4);
    }

    #[test]
    fn write_then_read_then_list_round_trip() {
        let f = fixture();
        let w = f
            .engine
            .execute(act(json!({"action": "write_text_file", "root_id": "sandbox", "path": "a/b.txt", "content": "hi", "overwrite": false})))
            .unwrap();
        assert_eq!(w, json!({"path": "a/b.txt", "bytes": 2, "created": true}));
        let r = f
            .engine
            .execute(act(
                json!({"action": "read_text_file", "root_id": "sandbox", "path": "a/b.txt"}),
            ))
            .unwrap();
        assert_eq!(r, json!({"content": "hi", "truncated": false, "bytes": 2}));
        let l = f
            .engine
            .execute(act(json!({"action": "list_dir", "root_id": "sandbox", "path": "a"})))
            .unwrap();
        assert_eq!(l["entries"][0]["name"], "b.txt");
        assert_eq!(l["entries"][0]["kind"], "file");
        assert_eq!(l["truncated"], false);
        assert!(f.rw.join("a/b.txt").is_file());
    }

    #[test]
    fn read_only_roots_reject_writes_and_organize() {
        let f = fixture();
        fs::write(f.ro.join("x.pdf"), "x").unwrap();
        let e = f
            .engine
            .execute(act(json!({"action": "write_text_file", "root_id": "docs", "path": "n.txt", "content": "x", "overwrite": true})))
            .unwrap_err();
        assert_eq!(e, ActionError::ReadOnlyRoot("docs".into()));
        let e = f
            .engine
            .execute(act(
                json!({"action": "organize_by_type", "root_id": "docs", "path": "", "dry_run": true}),
            ))
            .unwrap_err();
        assert_eq!(e, ActionError::ReadOnlyRoot("docs".into()));
        assert!(!f.ro.join("n.txt").exists());
        // Reading is allowed.
        let r = f
            .engine
            .execute(act(
                json!({"action": "read_text_file", "root_id": "docs", "path": "x.pdf"}),
            ))
            .unwrap();
        assert_eq!(r["content"], "x");
    }

    #[test]
    fn unknown_roots_and_apps_are_rejected() {
        let f = fixture();
        assert_eq!(
            f.engine
                .execute(act(json!({"action": "list_dir", "root_id": "home", "path": ""})))
                .unwrap_err(),
            ActionError::UnknownRoot("home".into())
        );
        assert_eq!(
            f.engine
                .execute(act(json!({"action": "launch_app", "app_id": "terminal"})))
                .unwrap_err(),
            ActionError::UnknownApp("terminal".into())
        );
    }

    #[test]
    fn traversal_and_absolute_paths_are_rejected_before_touching_disk() {
        let f = fixture();
        for path in [
            "../etc/passwd",
            "/etc/passwd",
            "a/../../x",
            "C:\\Windows\\win.ini",
            "\\\\srv\\share",
            "f.txt:ads",
            "a\0b",
        ] {
            let e = f
                .engine
                .execute(DesktopAction::ReadTextFile {
                    root_id: "sandbox".into(),
                    path: path.into(),
                })
                .unwrap_err();
            assert!(matches!(e, ActionError::InvalidPath(_)), "{path}: {e}");
            let e = f
                .engine
                .execute(DesktopAction::WriteTextFile {
                    root_id: "sandbox".into(),
                    path: path.into(),
                    content: "x".into(),
                    overwrite: true,
                })
                .unwrap_err();
            assert!(matches!(e, ActionError::InvalidPath(_)), "{path}: {e}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected_end_to_end() {
        let f = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "s").unwrap();
        std::os::unix::fs::symlink(outside.path(), f.rw.join("evil")).unwrap();
        for a in [
            json!({"action": "read_text_file", "root_id": "sandbox", "path": "evil/secret"}),
            json!({"action": "list_dir", "root_id": "sandbox", "path": "evil"}),
            json!({"action": "write_text_file", "root_id": "sandbox", "path": "evil/new", "content": "x", "overwrite": true}),
            json!({"action": "organize_by_type", "root_id": "sandbox", "path": "evil", "dry_run": false}),
        ] {
            assert_eq!(f.engine.execute(act(a)).unwrap_err(), ActionError::OutsideRoot);
        }
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 1);
    }

    #[test]
    fn size_limits_apply_to_reads_and_writes() {
        let f = fixture();
        let e = f
            .engine
            .execute(DesktopAction::WriteTextFile {
                root_id: "sandbox".into(),
                path: "big.txt".into(),
                content: "x".repeat(65),
                overwrite: false,
            })
            .unwrap_err();
        assert_eq!(e, ActionError::TooLarge { actual: 65, limit: 64 });
        fs::write(f.rw.join("big.txt"), "y".repeat(100)).unwrap();
        let r = f
            .engine
            .execute(act(
                json!({"action": "read_text_file", "root_id": "sandbox", "path": "big.txt"}),
            ))
            .unwrap();
        assert_eq!(r["truncated"], true);
        assert_eq!(r["bytes"], 100);
        assert_eq!(r["content"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn overwrite_requires_explicit_flag() {
        let f = fixture();
        fs::write(f.rw.join("keep.txt"), "original").unwrap();
        let e = f
            .engine
            .execute(act(json!({"action": "write_text_file", "root_id": "sandbox", "path": "keep.txt", "content": "x", "overwrite": false})))
            .unwrap_err();
        assert_eq!(e, ActionError::AlreadyExists("keep.txt".into()));
        assert_eq!(fs::read_to_string(f.rw.join("keep.txt")).unwrap(), "original");
    }

    #[test]
    fn emergency_stop_blocks_everything_but_status() {
        let f = fixture();
        assert!(f.engine.set_emergency_stop(true, "test"));
        let all = [
            json!({"action": "launch_app", "app_id": "toucher"}),
            json!({"action": "list_dir", "root_id": "sandbox", "path": ""}),
            json!({"action": "read_text_file", "root_id": "sandbox", "path": "x"}),
            json!({"action": "write_text_file", "root_id": "sandbox", "path": "x", "content": "x", "overwrite": true}),
            json!({"action": "organize_by_type", "root_id": "sandbox", "path": "", "dry_run": true}),
        ];
        for a in &all {
            assert_eq!(
                f.engine.execute(act(a.clone())).unwrap_err(),
                ActionError::EmergencyStop
            );
        }
        assert!(!f.rw.join("x").exists());
        let s = f.engine.execute(act(json!({"action": "status"}))).unwrap();
        assert_eq!(s["emergency_stop"], true);

        assert!(!f.engine.set_emergency_stop(false, "test"));
        assert!(f.engine.execute(act(all[1].clone())).is_ok());
    }

    #[test]
    fn launch_app_uses_fixed_program_and_args() {
        let f = fixture();
        if f.engine.config().app("toucher").is_none() {
            return;
        }
        let v = f
            .engine
            .execute(act(json!({"action": "launch_app", "app_id": "toucher"})))
            .unwrap();
        assert_eq!(v["launched"], "toucher");
        assert!(v["pid"].as_u64().unwrap() > 0);
        let marker = f.rw.join("launched");
        let start = std::time::Instant::now();
        while !marker.exists() && start.elapsed().as_secs() < 5 {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(marker.exists());
    }

    #[test]
    fn every_action_is_audited_without_contents() {
        let f = fixture();
        f.engine
            .execute(act(json!({"action": "write_text_file", "root_id": "sandbox", "path": "s.txt", "content": "PASSWORD123", "overwrite": false})))
            .unwrap();
        let _ = f.engine.execute(act(json!({"action": "launch_app", "app_id": "nope"})));
        f.engine.set_emergency_stop(true, "tray");
        let _ = f
            .engine
            .execute(act(json!({"action": "list_dir", "root_id": "sandbox", "path": ""})));
        let lines = audit_lines(&f);
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0]["action"], "write_text_file");
        assert_eq!(lines[0]["outcome"], "ok");
        assert_eq!(lines[0]["params"]["content_bytes"], 11);
        assert_eq!(lines[1]["outcome"], "denied");
        assert_eq!(lines[2]["action"], "set_emergency_stop");
        assert_eq!(lines[2]["params"]["source"], "tray");
        assert_eq!(lines[3]["outcome"], "denied");
        assert!(!fs::read_to_string(&f.audit).unwrap().contains("PASSWORD123"));
    }

    #[test]
    fn invalid_config_falls_back_to_locked_down() {
        let mut c = DesktopConfig::locked_down();
        c.apps.push(AppConfig {
            id: "sh".into(),
            label: "Sh".into(),
            program: "/bin/sh".into(),
            args: vec![],
        });
        let engine = Engine::new(c, "1", None);
        assert!(engine.config().apps.is_empty());
        assert_eq!(
            engine
                .execute(act(json!({"action": "launch_app", "app_id": "sh"})))
                .unwrap_err(),
            ActionError::UnknownApp("sh".into())
        );
    }

    #[test]
    fn missing_root_directory_reports_unavailable() {
        let f = fixture();
        let mut c = f.engine.config().clone();
        c.roots[0].path = f.rw.join("gone");
        let engine = Engine::new(c, "1", None);
        assert_eq!(
            engine
                .execute(act(json!({"action": "list_dir", "root_id": "sandbox", "path": ""})))
                .unwrap_err(),
            ActionError::RootUnavailable("sandbox".into())
        );
    }
}
