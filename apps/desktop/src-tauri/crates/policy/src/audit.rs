//! Append-only JSONL audit log with size-based rotation.
//!
//! One line per event: `{"ts", "action", "params", "outcome", "error"?}`.
//! Parameters are sanitized by the caller (no file contents). When the file
//! would grow past `max_bytes` it is rotated to `audit.jsonl.1`, `.1` to `.2`,
//! and so on, keeping `keep` old files.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

/// Rotate at 5 MB.
pub const DEFAULT_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// Number of rotated files kept.
pub const DEFAULT_KEEP: usize = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The action ran successfully.
    Ok,
    /// The local policy (or emergency stop) refused the action.
    Denied,
    /// The action was allowed but failed while running.
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub ts: String,
    pub action: String,
    pub params: Value,
    pub outcome: Outcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl AuditEntry {
    pub fn now(action: impl Into<String>, params: Value, outcome: Outcome, error: Option<String>) -> Self {
        AuditEntry {
            ts: now_rfc3339(),
            action: action.into(),
            params,
            outcome,
            error,
        }
    }
}

pub(crate) fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

#[derive(Debug)]
pub struct AuditLog {
    path: PathBuf,
    max_bytes: u64,
    keep: usize,
    lock: Mutex<()>,
}

impl AuditLog {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self::with_limits(path, DEFAULT_MAX_BYTES, DEFAULT_KEEP)
    }

    pub fn with_limits(path: impl Into<PathBuf>, max_bytes: u64, keep: usize) -> Self {
        AuditLog {
            path: path.into(),
            max_bytes,
            keep: keep.max(1),
            lock: Mutex::new(()),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append one entry (thread-safe).
    pub fn record(&self, entry: &AuditEntry) -> io::Result<()> {
        let mut line = serde_json::to_vec(entry).map_err(io::Error::other)?;
        line.push(b'\n');
        let _guard = self.lock.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let current = fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        if current > 0 && current + line.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        let mut opts = OpenOptions::new();
        opts.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&self.path)?;
        file.write_all(&line)?;
        file.flush()
    }

    fn rotated(&self, n: usize) -> PathBuf {
        let mut name = self.path.file_name().unwrap_or_default().to_os_string();
        name.push(format!(".{n}"));
        self.path.with_file_name(name)
    }

    fn rotate(&self) -> io::Result<()> {
        let oldest = self.rotated(self.keep);
        if oldest.exists() {
            fs::remove_file(&oldest)?;
        }
        for n in (1..self.keep).rev() {
            let from = self.rotated(n);
            if from.exists() {
                fs::rename(&from, self.rotated(n + 1))?;
            }
        }
        fs::rename(&self.path, self.rotated(1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn appends_one_json_line_per_entry() {
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(dir.path().join("logs/audit.jsonl"));
        log.record(&AuditEntry::now(
            "list_dir",
            json!({"root_id": "r", "path": ""}),
            Outcome::Ok,
            None,
        ))
        .unwrap();
        log.record(&AuditEntry::now(
            "launch_app",
            json!({"app_id": "x"}),
            Outcome::Denied,
            Some("no".into()),
        ))
        .unwrap();
        let text = fs::read_to_string(log.path()).unwrap();
        let lines: Vec<Value> = text.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["action"], "list_dir");
        assert_eq!(lines[0]["outcome"], "ok");
        assert!(lines[0].get("error").is_none());
        assert_eq!(lines[1]["outcome"], "denied");
        assert_eq!(lines[1]["error"], "no");
        assert!(lines[1]["ts"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn rotates_when_size_limit_is_reached() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit.jsonl");
        let log = AuditLog::with_limits(&path, 300, 2);
        for i in 0..20 {
            log.record(&AuditEntry::now("status", json!({ "i": i }), Outcome::Ok, None))
                .unwrap();
        }
        assert!(fs::metadata(&path).unwrap().len() <= 300);
        assert!(dir.path().join("audit.jsonl.1").exists());
        assert!(dir.path().join("audit.jsonl.2").exists());
        assert!(
            !dir.path().join("audit.jsonl.3").exists(),
            "only `keep` rotations retained"
        );
        // The newest entry is in the live file.
        let live = fs::read_to_string(&path).unwrap();
        assert!(live.contains("\"i\":19"));
    }

    #[cfg(unix)]
    #[test]
    fn log_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let log = AuditLog::new(dir.path().join("audit.jsonl"));
        log.record(&AuditEntry::now("status", json!({}), Outcome::Ok, None))
            .unwrap();
        let mode = fs::metadata(log.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
