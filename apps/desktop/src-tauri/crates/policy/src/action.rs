//! The `DesktopAction` union, mirroring `DesktopAction` in
//! `packages/protocol/src/index.ts`:
//!
//! ```ts
//! export type DesktopAction =
//!   | { action: "status" }
//!   | { action: "launch_app"; app_id: string }
//!   | { action: "list_dir"; root_id: string; path: string }
//!   | { action: "read_text_file"; root_id: string; path: string }
//!   | { action: "write_text_file"; root_id: string; path: string; content: string; overwrite: boolean }
//!   | { action: "organize_by_type"; root_id: string; path: string; dry_run: boolean };
//! ```

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Longest string kept verbatim in an audit entry.
const AUDIT_MAX_STR: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum DesktopAction {
    Status {},
    LaunchApp {
        app_id: String,
    },
    ListDir {
        root_id: String,
        path: String,
    },
    ReadTextFile {
        root_id: String,
        path: String,
    },
    WriteTextFile {
        root_id: String,
        path: String,
        content: String,
        overwrite: bool,
    },
    OrganizeByType {
        root_id: String,
        path: String,
        dry_run: bool,
    },
}

impl DesktopAction {
    /// The wire name of the action (the `action` tag).
    pub fn name(&self) -> &'static str {
        match self {
            DesktopAction::Status {} => "status",
            DesktopAction::LaunchApp { .. } => "launch_app",
            DesktopAction::ListDir { .. } => "list_dir",
            DesktopAction::ReadTextFile { .. } => "read_text_file",
            DesktopAction::WriteTextFile { .. } => "write_text_file",
            DesktopAction::OrganizeByType { .. } => "organize_by_type",
        }
    }

    /// Parameters safe to persist in the audit log: never file contents, and
    /// long strings are clipped.
    pub fn audit_params(&self) -> Value {
        match self {
            DesktopAction::Status {} => json!({}),
            DesktopAction::LaunchApp { app_id } => json!({ "app_id": clip(app_id) }),
            DesktopAction::ListDir { root_id, path } | DesktopAction::ReadTextFile { root_id, path } => {
                json!({ "root_id": clip(root_id), "path": clip(path) })
            }
            DesktopAction::WriteTextFile {
                root_id,
                path,
                content,
                overwrite,
            } => json!({
                "root_id": clip(root_id),
                "path": clip(path),
                "overwrite": overwrite,
                "content_bytes": content.len(),
            }),
            DesktopAction::OrganizeByType { root_id, path, dry_run } => {
                json!({ "root_id": clip(root_id), "path": clip(path), "dry_run": dry_run })
            }
        }
    }
}

fn clip(s: &str) -> String {
    if s.len() <= AUDIT_MAX_STR {
        return s.to_owned();
    }
    let mut end = AUDIT_MAX_STR;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(v: Value) -> Result<DesktopAction, serde_json::Error> {
        serde_json::from_value(v)
    }

    #[test]
    fn parses_every_variant_from_protocol_shapes() {
        assert_eq!(parse(json!({"action": "status"})).unwrap(), DesktopAction::Status {});
        assert_eq!(
            parse(json!({"action": "launch_app", "app_id": "calculator"})).unwrap(),
            DesktopAction::LaunchApp {
                app_id: "calculator".into()
            }
        );
        assert_eq!(
            parse(json!({"action": "list_dir", "root_id": "sandbox", "path": ""})).unwrap(),
            DesktopAction::ListDir {
                root_id: "sandbox".into(),
                path: "".into()
            }
        );
        assert_eq!(
            parse(json!({"action": "read_text_file", "root_id": "r", "path": "a.txt"})).unwrap(),
            DesktopAction::ReadTextFile {
                root_id: "r".into(),
                path: "a.txt".into()
            }
        );
        assert_eq!(
            parse(json!({"action": "write_text_file", "root_id": "r", "path": "a.txt", "content": "hi", "overwrite": false}))
                .unwrap(),
            DesktopAction::WriteTextFile {
                root_id: "r".into(),
                path: "a.txt".into(),
                content: "hi".into(),
                overwrite: false
            }
        );
        assert_eq!(
            parse(json!({"action": "organize_by_type", "root_id": "r", "path": ".", "dry_run": true})).unwrap(),
            DesktopAction::OrganizeByType {
                root_id: "r".into(),
                path: ".".into(),
                dry_run: true
            }
        );
    }

    #[test]
    fn serializes_back_to_protocol_shape() {
        let v = serde_json::to_value(DesktopAction::Status {}).unwrap();
        assert_eq!(v, json!({"action": "status"}));
        let v = serde_json::to_value(DesktopAction::OrganizeByType {
            root_id: "r".into(),
            path: "p".into(),
            dry_run: false,
        })
        .unwrap();
        assert_eq!(
            v,
            json!({"action": "organize_by_type", "root_id": "r", "path": "p", "dry_run": false})
        );
    }

    #[test]
    fn rejects_unknown_actions_fields_and_missing_fields() {
        assert!(parse(json!({"action": "run_shell", "cmd": "rm -rf /"})).is_err());
        assert!(parse(json!({"action": "launch_app", "app_id": "calc", "args": ["--evil"]})).is_err());
        assert!(parse(json!({"action": "status", "extra": 1})).is_err());
        assert!(parse(json!({"action": "write_text_file", "root_id": "r", "path": "a"})).is_err());
        assert!(parse(json!({"app_id": "calc"})).is_err());
        assert!(parse(json!({"action": "LaunchApp", "app_id": "calc"})).is_err());
    }

    #[test]
    fn audit_params_never_contain_file_content() {
        let a = DesktopAction::WriteTextFile {
            root_id: "r".into(),
            path: "notes.txt".into(),
            content: "top secret".into(),
            overwrite: true,
        };
        let p = a.audit_params();
        assert!(!p.to_string().contains("top secret"));
        assert_eq!(p["content_bytes"], 10);
        let long = "x".repeat(1000);
        let p = DesktopAction::LaunchApp { app_id: long }.audit_params();
        assert!(p["app_id"].as_str().unwrap().len() < 300);
    }
}
