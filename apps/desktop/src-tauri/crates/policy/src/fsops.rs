//! File-system actions. Every function receives an already canonicalized
//! root and a lexically validated [`RelPath`].

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::Path;
use std::time::SystemTime;

use serde::Serialize;

use crate::error::ActionError;
use crate::paths::{display_relative, ensure_inside, prepare_parent, resolve_existing, RelPath};

/// Maximum entries returned by `list_dir`.
pub const MAX_LIST_ENTRIES: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    /// RFC 3339 UTC timestamp, or `null` if unavailable.
    pub modified: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ListDirResult {
    pub entries: Vec<DirEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReadResult {
    pub content: String,
    pub truncated: bool,
    /// Size of the file on disk in bytes (may exceed `content.len()` when truncated).
    pub bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WriteResult {
    /// Path written, relative to the root, `/`-separated.
    pub path: String,
    pub bytes: u64,
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Move {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Skipped {
    pub from: String,
    pub to: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OrganizeResult {
    pub moves: Vec<Move>,
    pub skipped: Vec<Skipped>,
    pub applied: bool,
}

fn rfc3339(t: SystemTime) -> Option<String> {
    time::OffsetDateTime::from(t)
        .format(&time::format_description::well_known::Rfc3339)
        .ok()
}

pub fn list_dir(root: &Path, rel: &RelPath) -> Result<ListDirResult, ActionError> {
    let dir = resolve_existing(root, rel)?;
    if !dir.is_dir() {
        return Err(ActionError::NotADirectory(rel.display()));
    }
    let mut entries = Vec::new();
    for item in fs::read_dir(&dir).map_err(ActionError::io)? {
        let item = item.map_err(ActionError::io)?;
        let name = item.file_name().to_string_lossy().into_owned();
        // symlink_metadata: report links as links, never follow them here.
        let meta = match fs::symlink_metadata(item.path()) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let ft = meta.file_type();
        let kind = if ft.is_symlink() {
            EntryKind::Symlink
        } else if ft.is_dir() {
            EntryKind::Dir
        } else {
            EntryKind::File
        };
        entries.push(DirEntry {
            name,
            kind,
            size: if kind == EntryKind::File { meta.len() } else { 0 },
            modified: meta.modified().ok().and_then(rfc3339),
        });
    }
    // Directories first, then case-insensitive by name (stable tiebreak on exact name).
    entries.sort_by(|a, b| {
        (a.kind != EntryKind::Dir)
            .cmp(&(b.kind != EntryKind::Dir))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    let truncated = entries.len() > MAX_LIST_ENTRIES;
    entries.truncate(MAX_LIST_ENTRIES);
    Ok(ListDirResult { entries, truncated })
}

pub fn read_text_file(root: &Path, rel: &RelPath, max_bytes: u64) -> Result<ReadResult, ActionError> {
    if rel.is_root() {
        return Err(ActionError::NotAFile(String::new()));
    }
    let path = resolve_existing(root, rel)?;
    let file = File::open(&path).map_err(ActionError::io)?;
    let meta = file.metadata().map_err(ActionError::io)?;
    if !meta.is_file() {
        return Err(ActionError::NotAFile(rel.display()));
    }
    let mut buf = Vec::new();
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut buf)
        .map_err(ActionError::io)?;
    let truncated = buf.len() as u64 > max_bytes;
    if truncated {
        buf.truncate(max_bytes as usize);
    }
    if buf.contains(&0) {
        return Err(ActionError::NotText);
    }
    let content = match String::from_utf8(buf) {
        Ok(s) => s,
        Err(e) => {
            let err = e.utf8_error();
            // A multi-byte character cut by the size cap is fine; anything else is binary.
            if truncated && err.error_len().is_none() {
                let mut bytes = e.into_bytes();
                bytes.truncate(err.valid_up_to());
                String::from_utf8(bytes).map_err(|_| ActionError::NotText)?
            } else {
                return Err(ActionError::NotText);
            }
        }
    };
    Ok(ReadResult {
        content,
        truncated,
        bytes: meta.len(),
    })
}

pub fn write_text_file(
    root: &Path,
    rel: &RelPath,
    content: &str,
    overwrite: bool,
    max_bytes: u64,
) -> Result<WriteResult, ActionError> {
    let size = content.len() as u64;
    if size > max_bytes {
        return Err(ActionError::TooLarge {
            actual: size,
            limit: max_bytes,
        });
    }
    let (parent_rel, name) = rel
        .split_last()
        .ok_or_else(|| ActionError::InvalidPath("a file name is required".into()))?;
    let parent = prepare_parent(root, &parent_rel, true)?;
    let target = parent.join(name);
    ensure_inside(root, &target)?;

    let existing = match fs::symlink_metadata(&target) {
        Ok(m) => Some(m),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(e) => return Err(ActionError::io(e)),
    };
    if let Some(meta) = &existing {
        if meta.file_type().is_symlink() {
            return Err(ActionError::Symlink(rel.display()));
        }
        if !meta.is_file() {
            return Err(ActionError::NotAFile(rel.display()));
        }
        if !overwrite {
            return Err(ActionError::AlreadyExists(rel.display()));
        }
    }

    let mut tmp = tempfile::Builder::new()
        .prefix(".jarvis-write-")
        .tempfile_in(&parent)
        .map_err(ActionError::io)?;
    tmp.write_all(content.as_bytes()).map_err(ActionError::io)?;
    tmp.as_file().sync_all().map_err(ActionError::io)?;
    if let Some(meta) = &existing {
        // Keep the permissions of the file being replaced.
        let _ = fs::set_permissions(tmp.path(), meta.permissions());
    }
    if existing.is_some() {
        tmp.persist(&target).map_err(|e| ActionError::io(e.error))?;
    } else {
        // No-clobber: if something appeared at the target meanwhile, refuse.
        tmp.persist_noclobber(&target).map_err(|e| {
            if e.error.kind() == io::ErrorKind::AlreadyExists {
                ActionError::AlreadyExists(rel.display())
            } else {
                ActionError::io(e.error)
            }
        })?;
    }
    Ok(WriteResult {
        path: display_relative(root, &target),
        bytes: size,
        created: existing.is_none(),
    })
}

/// Category folders used by `organize_by_type`.
pub const CATEGORIES: &[&str] = &["Documents", "Images", "Audio", "Video", "Archives", "Code", "Other"];

/// Category folder for a file name, by (lower-cased) extension.
pub fn category_for(name: &str) -> &'static str {
    let ext = match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext.to_ascii_lowercase(),
        _ => return "Other",
    };
    match ext.as_str() {
        "pdf" | "doc" | "docx" | "odt" | "rtf" | "txt" | "md" | "markdown" | "tex" | "xls" | "xlsx" | "ods" | "csv"
        | "tsv" | "ppt" | "pptx" | "odp" | "epub" | "pages" | "numbers" | "key" => "Documents",
        "jpg" | "jpeg" | "png" | "gif" | "bmp" | "tif" | "tiff" | "webp" | "svg" | "heic" | "heif" | "ico" | "avif"
        | "raw" | "cr2" | "nef" | "psd" => "Images",
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "oga" | "m4a" | "wma" | "opus" | "aiff" | "mid" | "midi" => "Audio",
        "mp4" | "mkv" | "mov" | "avi" | "wmv" | "webm" | "flv" | "m4v" | "mpg" | "mpeg" | "3gp" => "Video",
        "zip" | "tar" | "gz" | "tgz" | "bz2" | "xz" | "7z" | "rar" | "zst" | "lz" | "lzma" | "cab" | "iso" | "dmg" => {
            "Archives"
        }
        "py" | "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" | "rs" | "go" | "java" | "kt" | "swift" | "c" | "h"
        | "cc" | "cpp" | "hpp" | "cs" | "rb" | "php" | "sh" | "ps1" | "html" | "htm" | "css" | "scss" | "json"
        | "yaml" | "yml" | "toml" | "xml" | "sql" | "ipynb" | "lua" | "r" | "dart" | "vue" | "svelte" => "Code",
        _ => "Other",
    }
}

pub fn organize_by_type(root: &Path, rel: &RelPath, dry_run: bool) -> Result<OrganizeResult, ActionError> {
    let dir = resolve_existing(root, rel)?;
    if !dir.is_dir() {
        return Err(ActionError::NotADirectory(rel.display()));
    }
    let base = display_relative(root, &dir);
    let show = |name: &str| {
        if base.is_empty() {
            name.to_owned()
        } else {
            format!("{base}/{name}")
        }
    };

    let mut names = Vec::new();
    for item in fs::read_dir(&dir).map_err(ActionError::io)? {
        let item = item.map_err(ActionError::io)?;
        names.push(item.file_name());
    }
    names.sort();

    let mut moves = Vec::new();
    let mut skipped = Vec::new();
    for os_name in names {
        let Some(name) = os_name.to_str() else {
            skipped.push(Skipped {
                from: show(&os_name.to_string_lossy()),
                to: None,
                reason: "file name is not valid UTF-8".into(),
            });
            continue;
        };
        if name.starts_with('.') {
            continue; // hidden files are left alone
        }
        let source = dir.join(name);
        let meta = match fs::symlink_metadata(&source) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            skipped.push(Skipped {
                from: show(name),
                to: None,
                reason: "symlinks are not moved".into(),
            });
            continue;
        }
        if !meta.is_file() {
            continue; // directories (including category folders) stay put
        }
        let category = category_for(name);
        let dest_dir = dir.join(category);
        let dest = dest_dir.join(name);
        let to = show(&format!("{category}/{name}"));
        match fs::symlink_metadata(&dest_dir) {
            Ok(m) if m.file_type().is_symlink() || !m.is_dir() => {
                skipped.push(Skipped {
                    from: show(name),
                    to: Some(to),
                    reason: format!("'{category}' exists and is not a plain folder"),
                });
                continue;
            }
            _ => {}
        }
        if fs::symlink_metadata(&dest).is_ok() {
            skipped.push(Skipped {
                from: show(name),
                to: Some(to),
                reason: "destination already exists".into(),
            });
            continue;
        }
        if !dry_run {
            if let Err(reason) = move_no_clobber(&source, &dest_dir, &dest) {
                skipped.push(Skipped {
                    from: show(name),
                    to: Some(to),
                    reason,
                });
                continue;
            }
        }
        moves.push(Move { from: show(name), to });
    }
    Ok(OrganizeResult {
        moves,
        skipped,
        applied: !dry_run,
    })
}

/// Move `source` to `dest` (inside `dest_dir`, created if missing) without
/// ever replacing an existing file.
fn move_no_clobber(source: &Path, dest_dir: &Path, dest: &Path) -> Result<(), String> {
    match fs::create_dir(dest_dir) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            let m = fs::symlink_metadata(dest_dir).map_err(|e| e.to_string())?;
            if m.file_type().is_symlink() || !m.is_dir() {
                return Err("category folder is not a plain folder".into());
            }
        }
        Err(e) => return Err(e.to_string()),
    }
    // A hard link fails atomically if `dest` exists, so nothing is overwritten.
    match fs::hard_link(source, dest) {
        Ok(()) => fs::remove_file(source).map_err(|e| e.to_string()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Err("destination already exists".into()),
        Err(_) => {
            // Filesystems without hard links (FAT, some network shares): best effort.
            if fs::symlink_metadata(dest).is_ok() {
                return Err("destination already exists".into());
            }
            fs::rename(source, dest).map_err(|e| e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::canonical_root;

    fn setup() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = canonical_root("r", dir.path()).unwrap();
        (dir, root)
    }

    fn rel(s: &str) -> RelPath {
        RelPath::parse(s).unwrap()
    }

    #[test]
    fn list_dir_sorts_and_classifies() {
        let (_d, root) = setup();
        fs::write(root.join("b.txt"), "hello").unwrap();
        fs::write(root.join("A.txt"), "").unwrap();
        fs::create_dir(root.join("zdir")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc", root.join("link")).unwrap();
        let out = list_dir(&root, &rel("")).unwrap();
        let names: Vec<_> = out.entries.iter().map(|e| e.name.as_str()).collect();
        #[cfg(unix)]
        assert_eq!(names, vec!["zdir", "A.txt", "b.txt", "link"]);
        #[cfg(not(unix))]
        assert_eq!(names, vec!["zdir", "A.txt", "b.txt"]);
        assert!(!out.truncated);
        let b = out.entries.iter().find(|e| e.name == "b.txt").unwrap();
        assert_eq!(b.kind, EntryKind::File);
        assert_eq!(b.size, 5);
        assert!(b.modified.is_some());
        #[cfg(unix)]
        assert_eq!(
            out.entries.iter().find(|e| e.name == "link").unwrap().kind,
            EntryKind::Symlink
        );
        assert_eq!(list_dir(&root, &rel(".")).unwrap(), out);
    }

    #[test]
    fn list_dir_truncates_at_limit() {
        let (_d, root) = setup();
        for i in 0..(MAX_LIST_ENTRIES + 5) {
            fs::write(root.join(format!("f{i:04}")), "").unwrap();
        }
        let out = list_dir(&root, &rel("")).unwrap();
        assert_eq!(out.entries.len(), MAX_LIST_ENTRIES);
        assert!(out.truncated);
        assert_eq!(out.entries[0].name, "f0000");
    }

    #[test]
    fn list_dir_on_file_fails() {
        let (_d, root) = setup();
        fs::write(root.join("f"), "").unwrap();
        assert!(matches!(list_dir(&root, &rel("f")), Err(ActionError::NotADirectory(_))));
    }

    #[test]
    fn read_text_file_reads_and_caps() {
        let (_d, root) = setup();
        fs::write(root.join("a.txt"), "hello world").unwrap();
        let r = read_text_file(&root, &rel("a.txt"), 1024).unwrap();
        assert_eq!(
            r,
            ReadResult {
                content: "hello world".into(),
                truncated: false,
                bytes: 11
            }
        );
        let r = read_text_file(&root, &rel("a.txt"), 5).unwrap();
        assert_eq!(r.content, "hello");
        assert!(r.truncated);
        assert_eq!(r.bytes, 11);
    }

    #[test]
    fn read_text_file_handles_multibyte_cut_and_rejects_binary() {
        let (_d, root) = setup();
        fs::write(root.join("u.txt"), "aé").unwrap(); // 'é' is 2 bytes
        let r = read_text_file(&root, &rel("u.txt"), 2).unwrap();
        assert_eq!(r.content, "a");
        assert!(r.truncated);
        fs::write(root.join("bin"), [0x89, b'P', b'N', b'G', 0, 1, 2]).unwrap();
        assert_eq!(read_text_file(&root, &rel("bin"), 1024), Err(ActionError::NotText));
        fs::write(root.join("latin1"), [b'a', 0xE9, b'b']).unwrap();
        assert_eq!(read_text_file(&root, &rel("latin1"), 1024), Err(ActionError::NotText));
        fs::create_dir(root.join("d")).unwrap();
        assert!(matches!(
            read_text_file(&root, &rel("d"), 10),
            Err(ActionError::NotAFile(_))
        ));
        assert!(matches!(
            read_text_file(&root, &rel(""), 10),
            Err(ActionError::NotAFile(_))
        ));
    }

    #[test]
    fn write_creates_parents_and_refuses_overwrite() {
        let (_d, root) = setup();
        let w = write_text_file(&root, &rel("notes/day/1.md"), "# hi", false, 1024).unwrap();
        assert_eq!(
            w,
            WriteResult {
                path: "notes/day/1.md".into(),
                bytes: 4,
                created: true
            }
        );
        assert_eq!(fs::read_to_string(root.join("notes/day/1.md")).unwrap(), "# hi");

        let err = write_text_file(&root, &rel("notes/day/1.md"), "new", false, 1024).unwrap_err();
        assert!(matches!(err, ActionError::AlreadyExists(_)));
        assert_eq!(fs::read_to_string(root.join("notes/day/1.md")).unwrap(), "# hi");

        let w = write_text_file(&root, &rel("notes/day/1.md"), "new", true, 1024).unwrap();
        assert!(!w.created);
        assert_eq!(fs::read_to_string(root.join("notes/day/1.md")).unwrap(), "new");

        // No temp files left behind.
        let leftovers: Vec<_> = fs::read_dir(root.join("notes/day")).unwrap().collect();
        assert_eq!(leftovers.len(), 1);
    }

    #[test]
    fn write_enforces_size_limit_and_needs_a_name() {
        let (_d, root) = setup();
        let err = write_text_file(&root, &rel("big.txt"), &"x".repeat(11), false, 10).unwrap_err();
        assert_eq!(err, ActionError::TooLarge { actual: 11, limit: 10 });
        assert!(!root.join("big.txt").exists());
        assert!(matches!(
            write_text_file(&root, &rel(""), "x", false, 10),
            Err(ActionError::InvalidPath(_))
        ));
        fs::create_dir(root.join("dir")).unwrap();
        assert!(matches!(
            write_text_file(&root, &rel("dir"), "x", true, 10),
            Err(ActionError::NotAFile(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn write_refuses_symlinks_and_escapes() {
        let outside = tempfile::tempdir().unwrap();
        let (_d, root) = setup();
        std::os::unix::fs::symlink(outside.path(), root.join("out")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("t.txt"), root.join("t.txt")).unwrap();
        assert_eq!(
            write_text_file(&root, &rel("out/x.txt"), "x", true, 10),
            Err(ActionError::OutsideRoot)
        );
        assert!(matches!(
            write_text_file(&root, &rel("t.txt"), "x", true, 10),
            Err(ActionError::Symlink(_))
        ));
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn categories() {
        assert_eq!(category_for("Report.PDF"), "Documents");
        assert_eq!(category_for("photo.jpeg"), "Images");
        assert_eq!(category_for("song.flac"), "Audio");
        assert_eq!(category_for("clip.mkv"), "Video");
        assert_eq!(category_for("backup.tar.gz"), "Archives");
        assert_eq!(category_for("main.rs"), "Code");
        assert_eq!(category_for("README"), "Other");
        assert_eq!(category_for("weird.xyz"), "Other");
        assert_eq!(category_for(".bashrc"), "Other");
        assert!(CATEGORIES.contains(&category_for("x.mp3")));
    }

    #[test]
    fn organize_dry_run_plans_without_touching_files() {
        let (_d, root) = setup();
        fs::create_dir(root.join("Downloads")).unwrap();
        for f in ["a.pdf", "b.png", "c.zip", "notes"] {
            fs::write(root.join("Downloads").join(f), f).unwrap();
        }
        fs::write(root.join("Downloads/.hidden"), "").unwrap();
        fs::create_dir(root.join("Downloads/sub")).unwrap();
        let out = organize_by_type(&root, &rel("Downloads"), true).unwrap();
        assert!(!out.applied);
        let pairs: Vec<_> = out.moves.iter().map(|m| (m.from.as_str(), m.to.as_str())).collect();
        assert_eq!(
            pairs,
            vec![
                ("Downloads/a.pdf", "Downloads/Documents/a.pdf"),
                ("Downloads/b.png", "Downloads/Images/b.png"),
                ("Downloads/c.zip", "Downloads/Archives/c.zip"),
                ("Downloads/notes", "Downloads/Other/notes"),
            ]
        );
        assert!(root.join("Downloads/a.pdf").exists());
        assert!(!root.join("Downloads/Documents").exists());
    }

    #[test]
    fn organize_applies_and_never_overwrites() {
        let (_d, root) = setup();
        fs::write(root.join("a.pdf"), "new").unwrap();
        fs::write(root.join("b.mp3"), "song").unwrap();
        fs::create_dir(root.join("Documents")).unwrap();
        fs::write(root.join("Documents/a.pdf"), "old").unwrap();
        let out = organize_by_type(&root, &rel(""), false).unwrap();
        assert!(out.applied);
        assert_eq!(
            out.moves,
            vec![Move {
                from: "b.mp3".into(),
                to: "Audio/b.mp3".into()
            }]
        );
        assert_eq!(out.skipped.len(), 1);
        assert_eq!(out.skipped[0].from, "a.pdf");
        assert_eq!(out.skipped[0].reason, "destination already exists");
        assert_eq!(fs::read_to_string(root.join("Documents/a.pdf")).unwrap(), "old");
        assert_eq!(fs::read_to_string(root.join("a.pdf")).unwrap(), "new");
        assert_eq!(fs::read_to_string(root.join("Audio/b.mp3")).unwrap(), "song");
        assert!(!root.join("b.mp3").exists());
        // Running again is a no-op for already organized files.
        let again = organize_by_type(&root, &rel(""), false).unwrap();
        assert!(again.moves.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn organize_skips_symlinks_and_symlinked_category_folders() {
        let outside = tempfile::tempdir().unwrap();
        let (_d, root) = setup();
        std::os::unix::fs::symlink(outside.path(), root.join("Images")).unwrap();
        fs::write(root.join("p.png"), "img").unwrap();
        std::os::unix::fs::symlink(root.join("p.png"), root.join("l.txt")).unwrap();
        let out = organize_by_type(&root, &rel(""), false).unwrap();
        assert!(out.moves.is_empty());
        // "Images" (symlink), "l.txt" (symlink) and "p.png" (category folder is a symlink).
        let reasons: Vec<_> = out.skipped.iter().map(|s| s.from.as_str()).collect();
        assert_eq!(reasons, vec!["Images", "l.txt", "p.png"]);
        assert!(root.join("p.png").exists());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    }
}
