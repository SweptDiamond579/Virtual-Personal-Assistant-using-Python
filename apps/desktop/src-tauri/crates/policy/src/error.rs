//! Error type returned by every desktop action.
//!
//! Messages are deliberately free of absolute paths: they are sent back to the
//! web UI and, from there, to the backend.

use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ActionError {
    #[error("emergency stop is active: desktop actions are disabled until it is cleared on this computer")]
    EmergencyStop,
    #[error("unknown app id '{0}': it is not in the local allowlist")]
    UnknownApp(String),
    #[error("unknown root id '{0}': it is not in the local policy")]
    UnknownRoot(String),
    #[error("root '{0}' is read-only in the local policy")]
    ReadOnlyRoot(String),
    #[error("root '{0}' is unavailable (missing or not a directory)")]
    RootUnavailable(String),
    #[error("invalid path: {0}")]
    InvalidPath(String),
    #[error("path resolves outside the allowed root")]
    OutsideRoot,
    #[error("not found: {0}")]
    NotFound(String),
    #[error("'{0}' already exists (set overwrite to true to replace it)")]
    AlreadyExists(String),
    #[error("content is {actual} bytes, which exceeds the {limit}-byte limit")]
    TooLarge { actual: u64, limit: u64 },
    #[error("file is not UTF-8 text")]
    NotText,
    #[error("not a directory: {0}")]
    NotADirectory(String),
    #[error("not a regular file: {0}")]
    NotAFile(String),
    #[error("refusing to operate through a symlink: {0}")]
    Symlink(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("failed to launch app '{id}': {reason}")]
    Launch { id: String, reason: String },
    #[error("I/O error: {0}")]
    Io(String),
}

impl ActionError {
    /// `true` when the action was refused by policy (as opposed to failing
    /// while being carried out). Used for the audit `outcome` field.
    pub fn is_denial(&self) -> bool {
        !matches!(self, ActionError::Io(_) | ActionError::Launch { .. })
    }

    pub(crate) fn io(err: std::io::Error) -> Self {
        // `std::io::Error`'s Display never includes the path it was opened with.
        ActionError::Io(err.to_string())
    }
}
