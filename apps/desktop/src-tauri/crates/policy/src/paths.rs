//! Validation and resolution of caller-supplied paths.
//!
//! Every path an action receives is *relative to a policy root*. It goes
//! through two layers:
//!
//! 1. [`RelPath::parse`] — purely lexical: rejects absolute paths, `..`, NUL and
//!    control characters, drive / UNC prefixes, `:` (drive letters and NTFS
//!    alternate data streams) and, on Windows, reserved device names.
//! 2. [`resolve_existing`] / [`prepare_parent`] — touch the filesystem:
//!    canonicalize the root and the candidate (or its parent, for new files)
//!    and require the result to stay inside the canonical root, so symlinks
//!    pointing outside the root are rejected.
//!
//! Threat model note: these checks protect against a remote caller (backend /
//! web UI). A *local* process that can concurrently rewrite directories inside
//! the root could still race check-then-use; that is out of scope because such
//! a process already has the same access as the user.

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::error::ActionError;

/// Maximum length (bytes) of a relative path accepted from a caller.
pub const MAX_PATH_LEN: usize = 1024;
/// Maximum length (bytes) of a single path component.
pub const MAX_COMPONENT_LEN: usize = 255;

/// A lexically validated path relative to a root. Empty means the root itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelPath(Vec<String>);

impl RelPath {
    /// Parse using the rules of the platform we are running on.
    pub fn parse(input: &str) -> Result<Self, ActionError> {
        Self::parse_with(input, cfg!(windows))
    }

    /// Parse with explicit control over the Windows-only name rules (so they
    /// can be unit-tested on every platform). The portable rules always apply.
    pub fn parse_with(input: &str, windows_rules: bool) -> Result<Self, ActionError> {
        let bad = |msg: &str| Err(ActionError::InvalidPath(msg.to_owned()));
        if input.len() > MAX_PATH_LEN {
            return bad("path is too long");
        }
        if input.contains('\0') {
            return bad("NUL bytes are not allowed");
        }
        if input.chars().any(char::is_control) {
            return bad("control characters are not allowed");
        }
        if input.contains(':') {
            return bad("':' is not allowed (drive letters and alternate data streams are rejected)");
        }
        if input.starts_with('/') || input.starts_with('\\') {
            return bad("absolute paths are not allowed; use a path relative to the root");
        }

        let mut parts = Vec::new();
        for raw in input.split(['/', '\\']) {
            match raw {
                "" | "." => continue,
                ".." => return bad("'..' components are not allowed"),
                _ => {}
            }
            if raw.len() > MAX_COMPONENT_LEN {
                return bad("a path component is too long");
            }
            if windows_rules {
                if raw.chars().any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*')) {
                    return bad("characters <>\"|?* are not allowed");
                }
                if raw.ends_with('.') || raw.ends_with(' ') {
                    return bad("names ending in '.' or ' ' are not allowed");
                }
                if is_windows_reserved_name(raw) {
                    return bad("reserved device names (CON, NUL, COM1, ...) are not allowed");
                }
            }
            parts.push(raw.to_owned());
        }

        // Belt and braces: the joined path must consist of normal components only.
        let joined: PathBuf = parts.iter().collect();
        if joined.is_absolute() || joined.has_root() || !joined.components().all(|c| matches!(c, Component::Normal(_)))
        {
            return bad("path must be relative to the root");
        }
        Ok(RelPath(parts))
    }

    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }

    pub fn components(&self) -> &[String] {
        &self.0
    }

    pub fn to_path_buf(&self) -> PathBuf {
        self.0.iter().collect()
    }

    /// Splits into (parent, file name). `None` for the root itself.
    pub fn split_last(&self) -> Option<(RelPath, &str)> {
        let (last, parent) = self.0.split_last()?;
        Some((RelPath(parent.to_vec()), last.as_str()))
    }

    /// `/`-separated display form ("" for the root).
    pub fn display(&self) -> String {
        self.0.join("/")
    }
}

/// `true` for Windows reserved device names, with or without an extension
/// (`CON`, `nul.txt`, `COM1`, `lpt9.log`, `CONIN$`, ...). Case-insensitive.
pub fn is_windows_reserved_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" => true,
        s if s.len() == 4 && (s.starts_with("COM") || s.starts_with("LPT")) => s.as_bytes()[3].is_ascii_digit(),
        s if (s.starts_with("COM") || s.starts_with("LPT")) => {
            // Superscript digits ¹ ² ³ are also reserved.
            matches!(&s[3..], "¹" | "²" | "³")
        }
        _ => false,
    }
}

/// Canonicalize a configured root directory.
pub fn canonical_root(root_id: &str, path: &Path) -> Result<PathBuf, ActionError> {
    let canon = fs::canonicalize(path).map_err(|_| ActionError::RootUnavailable(root_id.to_owned()))?;
    if !canon.is_dir() {
        return Err(ActionError::RootUnavailable(root_id.to_owned()));
    }
    Ok(canon)
}

/// Require `candidate` (already canonical) to be `root` or inside it.
pub fn ensure_inside(root: &Path, candidate: &Path) -> Result<(), ActionError> {
    if candidate.starts_with(root) {
        Ok(())
    } else {
        Err(ActionError::OutsideRoot)
    }
}

/// Resolve an existing path inside `root` (canonical). Symlinks are followed
/// and the final target must still be inside the root.
pub fn resolve_existing(root: &Path, rel: &RelPath) -> Result<PathBuf, ActionError> {
    let candidate = root.join(rel.to_path_buf());
    let canon = fs::canonicalize(&candidate).map_err(|e| not_found_or_io(e, rel))?;
    ensure_inside(root, &canon)?;
    Ok(canon)
}

/// Make sure the directory `parent` (relative to `root`) exists inside the
/// root, optionally creating missing components one at a time, and return its
/// canonical path. Every existing component is canonicalized and checked, so a
/// symlink anywhere along the way cannot lead outside the root.
pub fn prepare_parent(root: &Path, parent: &RelPath, create: bool) -> Result<PathBuf, ActionError> {
    let mut current = root.to_path_buf();
    let mut walked = Vec::new();
    for comp in parent.components() {
        walked.push(comp.clone());
        let next = current.join(comp);
        match fs::symlink_metadata(&next) {
            Ok(_) => {
                let canon = fs::canonicalize(&next).map_err(ActionError::io)?;
                ensure_inside(root, &canon)?;
                if !canon.is_dir() {
                    return Err(ActionError::NotADirectory(walked.join("/")));
                }
                current = canon;
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                if !create {
                    return Err(ActionError::NotFound(walked.join("/")));
                }
                match fs::create_dir(&next) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(ActionError::io(e)),
                }
                let canon = fs::canonicalize(&next).map_err(ActionError::io)?;
                ensure_inside(root, &canon)?;
                current = canon;
            }
            Err(e) => return Err(ActionError::io(e)),
        }
    }
    Ok(current)
}

/// `/`-separated path of `path` relative to `root` (both canonical).
pub fn display_relative(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(rel) => rel
            .components()
            .filter_map(|c| match c {
                Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("/"),
        Err(_) => String::new(),
    }
}

fn not_found_or_io(e: io::Error, rel: &RelPath) -> ActionError {
    if e.kind() == io::ErrorKind::NotFound {
        ActionError::NotFound(rel.display())
    } else {
        ActionError::io(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> Vec<String> {
        RelPath::parse_with(s, false).unwrap().components().to_vec()
    }

    fn rejected(s: &str, windows: bool) -> bool {
        matches!(RelPath::parse_with(s, windows), Err(ActionError::InvalidPath(_)))
    }

    #[test]
    fn accepts_plain_relative_paths() {
        assert!(ok("").is_empty());
        assert!(ok(".").is_empty());
        assert!(ok("./").is_empty());
        assert_eq!(ok("a/b.txt"), vec!["a", "b.txt"]);
        assert_eq!(ok("a//b/./c"), vec!["a", "b", "c"]);
        assert_eq!(ok("a\\b"), vec!["a", "b"]);
        assert_eq!(ok("notes v2.final.md"), vec!["notes v2.final.md"]);
        assert_eq!(ok("~"), vec!["~"]);
    }

    #[test]
    fn rejects_traversal() {
        for p in ["..", "../x", "a/../../b", "a/..", "a\\..\\..\\b", "./.."] {
            assert!(rejected(p, false), "{p}");
        }
    }

    #[test]
    fn rejects_absolute_drive_and_unc() {
        for p in [
            "/etc/passwd",
            "\\Windows",
            "\\\\server\\share\\x",
            "C:\\Windows",
            "C:/x",
            "c:x",
            "//server/share",
        ] {
            assert!(rejected(p, false), "{p}");
            assert!(rejected(p, true), "{p}");
        }
    }

    #[test]
    fn rejects_nul_control_ads_and_long_paths() {
        assert!(rejected("a\0b", false));
        assert!(rejected("a\nb", false));
        assert!(rejected("file.txt:secret", false));
        assert!(rejected("file.txt::$DATA", false));
        assert!(rejected(&"a/".repeat(600), false));
        assert!(rejected(&"x".repeat(300), false));
    }

    #[test]
    fn windows_name_rules() {
        for p in [
            "CON", "con.txt", "a/NUL", "Aux.log", "COM1", "lpt9.txt", "CONIN$", "a/b.", "a/b ", "a?b", "a*b", "a<b",
        ] {
            assert!(rejected(p, true), "{p}");
        }
        // Portable rules alone accept them (they are legal names on Unix).
        assert!(!rejected("con.txt", false));
        assert!(!rejected("console.txt", true));
        assert!(!rejected("COM10", true));
        assert!(!rejected("company.txt", true));
    }

    #[test]
    fn reserved_name_detection() {
        assert!(is_windows_reserved_name("con"));
        assert!(is_windows_reserved_name("PRN.txt"));
        assert!(is_windows_reserved_name("com1.tar.gz"));
        assert!(is_windows_reserved_name("LPT³"));
        assert!(!is_windows_reserved_name("comx"));
        assert!(!is_windows_reserved_name("connect"));
        assert!(!is_windows_reserved_name(""));
    }

    #[test]
    fn split_and_display() {
        let p = RelPath::parse("a/b/c.txt").unwrap();
        let (parent, name) = p.split_last().unwrap();
        assert_eq!(parent.display(), "a/b");
        assert_eq!(name, "c.txt");
        assert!(RelPath::parse("").unwrap().split_last().is_none());
    }

    #[test]
    fn resolve_existing_stays_inside_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root("r", dir.path()).unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub/f.txt"), "x").unwrap();
        let p = resolve_existing(&root, &RelPath::parse("sub/f.txt").unwrap()).unwrap();
        assert_eq!(p, root.join("sub/f.txt"));
        assert_eq!(display_relative(&root, &p), "sub/f.txt");
        assert!(matches!(
            resolve_existing(&root, &RelPath::parse("missing").unwrap()),
            Err(ActionError::NotFound(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected() {
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "s").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root("r", dir.path()).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("escape")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), root.join("secret-link")).unwrap();
        assert_eq!(
            resolve_existing(&root, &RelPath::parse("escape/secret.txt").unwrap()),
            Err(ActionError::OutsideRoot)
        );
        assert_eq!(
            resolve_existing(&root, &RelPath::parse("secret-link").unwrap()),
            Err(ActionError::OutsideRoot)
        );
        assert_eq!(
            prepare_parent(&root, &RelPath::parse("escape/new").unwrap(), true),
            Err(ActionError::OutsideRoot)
        );
        assert!(!outside.path().join("new").exists());
    }

    #[test]
    fn prepare_parent_creates_only_inside_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root("r", dir.path()).unwrap();
        let p = prepare_parent(&root, &RelPath::parse("a/b/c").unwrap(), true).unwrap();
        assert_eq!(p, root.join("a/b/c"));
        assert!(p.is_dir());
        assert!(matches!(
            prepare_parent(&root, &RelPath::parse("x/y").unwrap(), false),
            Err(ActionError::NotFound(_))
        ));
        fs::write(root.join("file"), "x").unwrap();
        assert!(matches!(
            prepare_parent(&root, &RelPath::parse("file/sub").unwrap(), true),
            Err(ActionError::NotADirectory(_))
        ));
    }

    #[test]
    fn missing_root_is_unavailable() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            canonical_root("r", &dir.path().join("nope")),
            Err(ActionError::RootUnavailable("r".into()))
        );
    }
}
