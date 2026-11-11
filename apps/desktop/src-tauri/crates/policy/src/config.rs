//! The local desktop policy (`policy.json`).
//!
//! The policy is the single source of truth for what the desktop companion may
//! do. It is only ever changed by the user editing the file on this computer;
//! no command exposed to the web UI or backend can modify it.

use std::collections::HashSet;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Default URL of the JARVIS web UI (served by the FastAPI backend).
pub const DEFAULT_URL: &str = "http://127.0.0.1:8000/";
/// Default cap for reads and writes.
pub const DEFAULT_MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Hard upper bound for `max_file_bytes`, whatever the file says.
pub const MAX_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// Name of the default sandbox folder created in the user's home directory.
pub const SANDBOX_DIR_NAME: &str = "JARVIS";
/// Current policy schema version.
pub const POLICY_VERSION: u32 = 1;

/// Programs that would turn `launch_app` into arbitrary code execution. They
/// are refused even if the user lists them, as defense in depth against
/// "paste this into your policy" social engineering.
const DENIED_PROGRAMS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "fish",
    "dash",
    "ksh",
    "csh",
    "tcsh",
    "nu",
    "env",
    "sudo",
    "su",
    "doas",
    "pkexec",
    "cmd",
    "powershell",
    "pwsh",
    "wscript",
    "cscript",
    "mshta",
    "rundll32",
    "regsvr32",
    "msiexec",
    "python",
    "python3",
    "perl",
    "ruby",
    "node",
    "deno",
    "bun",
    "osascript",
    "xdg-open",
    "gio",
    "busybox",
    "nohup",
    "xargs",
    "find",
    "curl",
    "wget",
    "ssh",
];

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("cannot read or write policy file: {0}")]
    Io(#[from] io::Error),
    #[error("policy file is not valid JSON for this schema: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("policy is invalid: {0}")]
    Invalid(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    /// URL of the JARVIS web UI. `JARVIS_URL` overrides it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Maximum bytes read from or written to a file in one action.
    #[serde(default = "default_max_file_bytes")]
    pub max_file_bytes: u64,
    /// Folders the assistant may touch. Nothing outside them is reachable.
    #[serde(default)]
    pub roots: Vec<RootConfig>,
    /// Programs the assistant may launch, each with a fixed argument list.
    #[serde(default)]
    pub apps: Vec<AppConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootConfig {
    pub id: String,
    pub label: String,
    pub path: PathBuf,
    /// Read-only unless explicitly `true`.
    #[serde(default)]
    pub writable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    pub id: String,
    pub label: String,
    /// Absolute path of the executable. No `PATH` lookup happens at launch.
    pub program: PathBuf,
    /// Fixed arguments. Callers can never add or change arguments.
    #[serde(default)]
    pub args: Vec<String>,
}

fn default_version() -> u32 {
    POLICY_VERSION
}

fn default_max_file_bytes() -> u64 {
    DEFAULT_MAX_FILE_BYTES
}

impl DesktopConfig {
    /// A policy that allows nothing. Used when the policy file is broken, so
    /// the app fails closed instead of guessing.
    pub fn locked_down() -> Self {
        DesktopConfig {
            version: POLICY_VERSION,
            url: None,
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            roots: Vec::new(),
            apps: Vec::new(),
        }
    }

    /// The safe default for this OS: one writable sandbox `~/JARVIS` and a
    /// small set of harmless apps that exist on this machine.
    pub fn default_for(home: &Path) -> Self {
        Self::default_with(home, std::env::consts::OS, find_on_path)
    }

    /// [`default_for`](Self::default_for) with the OS and program lookup injected (for tests).
    pub fn default_with(home: &Path, os: &str, lookup: impl Fn(&str) -> Option<PathBuf>) -> Self {
        let app = |id: &str, label: &str, program: PathBuf, args: &[&str]| AppConfig {
            id: id.into(),
            label: label.into(),
            program,
            args: args.iter().map(|s| (*s).to_owned()).collect(),
        };
        let apps = match os {
            "macos" => vec![
                app(
                    "calculator",
                    "Calculator",
                    PathBuf::from("/usr/bin/open"),
                    &["-a", "Calculator"],
                ),
                app(
                    "textedit",
                    "TextEdit",
                    PathBuf::from("/usr/bin/open"),
                    &["-a", "TextEdit"],
                ),
            ],
            "windows" => {
                let system_root = std::env::var_os("SystemRoot")
                    .map(PathBuf::from)
                    .filter(|p| p.is_absolute())
                    .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
                let sys32 = system_root.join("System32");
                vec![
                    app("calculator", "Calculator", sys32.join("calc.exe"), &[]),
                    app("notepad", "Notepad", sys32.join("notepad.exe"), &[]),
                ]
            }
            _ => [
                ("calculator", "Calculator", "gnome-calculator"),
                ("text-editor", "Text Editor", "gnome-text-editor"),
                ("gedit", "gedit", "gedit"),
            ]
            .into_iter()
            .filter_map(|(id, label, bin)| lookup(bin).map(|p| app(id, label, p, &[])))
            .collect(),
        };
        DesktopConfig {
            version: POLICY_VERSION,
            url: Some(DEFAULT_URL.to_owned()),
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            roots: vec![RootConfig {
                id: "sandbox".into(),
                label: "JARVIS sandbox".into(),
                path: home.join(SANDBOX_DIR_NAME),
                writable: true,
            }],
            apps,
        }
    }

    /// Check the whole policy. Any problem invalidates the whole file (fail closed).
    pub fn validate(&self) -> Result<(), ConfigError> {
        let invalid = |m: String| Err(ConfigError::Invalid(m));
        if self.version != POLICY_VERSION {
            return invalid(format!(
                "unsupported version {} (expected {POLICY_VERSION})",
                self.version
            ));
        }
        if self.max_file_bytes == 0 || self.max_file_bytes > MAX_MAX_FILE_BYTES {
            return invalid(format!("max_file_bytes must be between 1 and {MAX_MAX_FILE_BYTES}"));
        }
        let mut ids = HashSet::new();
        for root in &self.roots {
            check_id("root", &root.id)?;
            check_label("root", &root.id, &root.label)?;
            if !ids.insert(&root.id) {
                return invalid(format!("duplicate root id '{}'", root.id));
            }
            if !root.path.is_absolute() {
                return invalid(format!("root '{}' path must be absolute", root.id));
            }
            if root.path.parent().is_none() {
                return invalid(format!("root '{}' must not be the filesystem root", root.id));
            }
        }
        let mut ids = HashSet::new();
        for app in &self.apps {
            check_id("app", &app.id)?;
            check_label("app", &app.id, &app.label)?;
            if !ids.insert(&app.id) {
                return invalid(format!("duplicate app id '{}'", app.id));
            }
            if !app.program.is_absolute() {
                return invalid(format!("app '{}' program must be an absolute path", app.id));
            }
            if is_denied_program(&app.program) {
                return invalid(format!(
                    "app '{}' uses a shell, interpreter or generic launcher, which is not allowed",
                    app.id
                ));
            }
            if app.args.iter().any(|a| a.contains('\0')) {
                return invalid(format!("app '{}' has an argument containing NUL", app.id));
            }
        }
        Ok(())
    }

    pub fn root(&self, id: &str) -> Option<&RootConfig> {
        self.roots.iter().find(|r| r.id == id)
    }

    pub fn app(&self, id: &str) -> Option<&AppConfig> {
        self.apps.iter().find(|a| a.id == id)
    }
}

fn check_id(kind: &str, id: &str) -> Result<(), ConfigError> {
    let ok =
        !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if ok {
        Ok(())
    } else {
        Err(ConfigError::Invalid(format!(
            "{kind} id '{id}' must be 1-64 characters of A-Z, a-z, 0-9, '-' or '_'"
        )))
    }
}

fn check_label(kind: &str, id: &str, label: &str) -> Result<(), ConfigError> {
    if label.trim().is_empty() || label.len() > 128 || label.chars().any(char::is_control) {
        return Err(ConfigError::Invalid(format!(
            "{kind} '{id}' needs a label of 1-128 printable characters"
        )));
    }
    Ok(())
}

/// `true` if the program's file name is a shell / interpreter / generic launcher.
pub fn is_denied_program(program: &Path) -> bool {
    let Some(name) = program.to_str().and_then(|s| s.rsplit(['/', '\\']).next()) else {
        return true;
    };
    if name.is_empty() {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    let stem = lower
        .strip_suffix(".exe")
        .or_else(|| lower.strip_suffix(".com"))
        .or_else(|| lower.strip_suffix(".bat"))
        .or_else(|| lower.strip_suffix(".cmd"))
        .unwrap_or(&lower);
    if lower.ends_with(".bat") || lower.ends_with(".cmd") || lower.ends_with(".ps1") || lower.ends_with(".vbs") {
        return true;
    }
    // python3.12, perl5.36, ...
    let base = stem.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.');
    DENIED_PROGRAMS.contains(&stem) || DENIED_PROGRAMS.contains(&base)
}

/// Find an executable on `PATH`, returning its absolute path.
pub fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

/// What [`load_or_create`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoadOutcome {
    Loaded,
    CreatedDefault,
}

/// Load and validate the policy at `policy_path`. If the file does not exist,
/// write the safe default (creating the `~/JARVIS` sandbox) and return it.
/// An existing but invalid file is never overwritten; the error is returned
/// so the caller can fall back to [`DesktopConfig::locked_down`].
pub fn load_or_create(policy_path: &Path, home: &Path) -> Result<(DesktopConfig, LoadOutcome), ConfigError> {
    match fs::read(policy_path) {
        Ok(bytes) => {
            let config: DesktopConfig = serde_json::from_slice(&bytes)?;
            config.validate()?;
            Ok((config, LoadOutcome::Loaded))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let config = DesktopConfig::default_for(home);
            for root in &config.roots {
                fs::create_dir_all(&root.path)?;
            }
            config.validate()?;
            save(policy_path, &config)?;
            Ok((config, LoadOutcome::CreatedDefault))
        }
        Err(e) => Err(e.into()),
    }
}

/// Atomically write the policy (temp file in the same directory + rename).
pub fn save(policy_path: &Path, config: &DesktopConfig) -> Result<(), ConfigError> {
    let dir = policy_path
        .parent()
        .ok_or_else(|| ConfigError::Invalid("policy path has no parent directory".into()))?;
    fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    let mut json = serde_json::to_vec_pretty(config)?;
    json.push(b'\n');
    tmp.write_all(&json)?;
    tmp.as_file().sync_all()?;
    tmp.persist(policy_path).map_err(|e| ConfigError::Io(e.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(home: &Path) -> DesktopConfig {
        DesktopConfig::default_with(home, "linux", |_| None)
    }

    #[test]
    fn default_is_sandbox_only() {
        let home = Path::new("/home/test");
        let c = DesktopConfig::default_with(home, "linux", |_| None);
        assert_eq!(c.roots.len(), 1);
        assert_eq!(c.roots[0].path, home.join("JARVIS"));
        assert!(c.roots[0].writable);
        assert!(c.apps.is_empty());
        assert_eq!(c.url.as_deref(), Some(DEFAULT_URL));
        c.validate().unwrap();
    }

    #[test]
    fn linux_defaults_only_include_programs_found_on_path() {
        let c = DesktopConfig::default_with(Path::new("/h"), "linux", |name| {
            (name == "gnome-calculator").then(|| PathBuf::from("/usr/bin/gnome-calculator"))
        });
        assert_eq!(c.apps.len(), 1);
        assert_eq!(c.apps[0].id, "calculator");
        assert!(c.apps.iter().all(|a| !a.program.ends_with("xdg-open")));
        c.validate().unwrap();
    }

    #[test]
    fn macos_and_windows_defaults() {
        let mac = DesktopConfig::default_with(Path::new("/Users/t"), "macos", |_| None);
        assert_eq!(mac.apps.len(), 2);
        assert_eq!(mac.apps[0].program, PathBuf::from("/usr/bin/open"));
        assert_eq!(mac.apps[0].args, vec!["-a", "Calculator"]);
        mac.validate().unwrap();
        let win = DesktopConfig::default_with(Path::new("/h"), "windows", |_| None);
        let names: Vec<_> = win
            .apps
            .iter()
            .map(|a| a.program.file_name().unwrap().to_owned())
            .collect();
        assert_eq!(names, vec!["calc.exe", "notepad.exe"]);
    }

    #[test]
    fn validation_rejects_bad_policies() {
        let home = Path::new("/home/t");
        let mut c = sample(home);
        c.roots[0].path = PathBuf::from("relative/dir");
        assert!(c.validate().is_err());

        let mut c = sample(home);
        c.roots[0].path = PathBuf::from("/");
        assert!(c.validate().is_err());

        let mut c = sample(home);
        c.roots.push(c.roots[0].clone());
        assert!(c.validate().is_err(), "duplicate id");

        let mut c = sample(home);
        c.roots[0].id = "bad id!".into();
        assert!(c.validate().is_err());

        let mut c = sample(home);
        c.max_file_bytes = MAX_MAX_FILE_BYTES + 1;
        assert!(c.validate().is_err());

        let mut c = sample(home);
        c.version = 99;
        assert!(c.validate().is_err());

        for prog in [
            "/bin/sh",
            "/usr/bin/python3.12",
            "C:\\Windows\\System32\\cmd.exe",
            "/usr/bin/xdg-open",
            "/x/run.bat",
        ] {
            let mut c = sample(home);
            c.apps.push(AppConfig {
                id: "x".into(),
                label: "X".into(),
                program: prog.into(),
                args: vec![],
            });
            assert!(c.validate().is_err(), "{prog} should be denied");
        }

        let mut c = sample(home);
        c.apps.push(AppConfig {
            id: "x".into(),
            label: "X".into(),
            program: "calc".into(),
            args: vec![],
        });
        assert!(c.validate().is_err(), "relative program");
    }

    #[test]
    fn denied_program_detection() {
        assert!(is_denied_program(Path::new("/bin/bash")));
        assert!(is_denied_program(Path::new("/usr/bin/perl5.36")));
        assert!(is_denied_program(Path::new("C:\\x\\PowerShell.EXE")));
        assert!(!is_denied_program(Path::new("/usr/bin/gnome-calculator")));
        assert!(!is_denied_program(Path::new("/usr/bin/open")));
        assert!(!is_denied_program(Path::new("C:\\Windows\\System32\\notepad.exe")));
    }

    #[test]
    fn unknown_fields_are_rejected() {
        let json = r#"{"version":1,"roots":[],"apps":[],"allow_everything":true}"#;
        assert!(serde_json::from_str::<DesktopConfig>(json).is_err());
        let json = r#"{"roots":[{"id":"a","label":"A","path":"/tmp/a"}]}"#;
        let c: DesktopConfig = serde_json::from_str(json).unwrap();
        assert!(!c.roots[0].writable, "roots are read-only unless stated");
        assert_eq!(c.max_file_bytes, DEFAULT_MAX_FILE_BYTES);
    }

    #[test]
    fn load_or_create_writes_default_then_reloads() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        fs::create_dir(&home).unwrap();
        let policy = tmp.path().join("config/jarvis-desktop/policy.json");

        let (created, outcome) = load_or_create(&policy, &home).unwrap();
        assert_eq!(outcome, LoadOutcome::CreatedDefault);
        assert!(policy.is_file());
        assert!(home.join("JARVIS").is_dir(), "sandbox created");
        assert_eq!(created.roots.len(), 1);

        let (loaded, outcome) = load_or_create(&policy, &home).unwrap();
        assert_eq!(outcome, LoadOutcome::Loaded);
        assert_eq!(loaded, created);
    }

    #[test]
    fn invalid_policy_file_is_an_error_and_is_not_overwritten() {
        let tmp = tempfile::tempdir().unwrap();
        let policy = tmp.path().join("policy.json");
        fs::write(&policy, "{ not json").unwrap();
        assert!(matches!(
            load_or_create(&policy, tmp.path()),
            Err(ConfigError::Parse(_))
        ));
        assert_eq!(fs::read_to_string(&policy).unwrap(), "{ not json");

        fs::write(&policy, r#"{"apps":[{"id":"sh","label":"Shell","program":"/bin/sh"}]}"#).unwrap();
        assert!(matches!(
            load_or_create(&policy, tmp.path()),
            Err(ConfigError::Invalid(_))
        ));
    }

    #[test]
    fn locked_down_allows_nothing() {
        let c = DesktopConfig::locked_down();
        assert!(c.roots.is_empty() && c.apps.is_empty());
        c.validate().unwrap();
    }
}
