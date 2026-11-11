//! Launching allowlisted programs.
//!
//! The program path and its argument array come only from the local policy.
//! `std::process::Command` executes the program directly (no shell), so no
//! argument is ever interpreted.

use std::process::{Command, Stdio};

use crate::config::{is_denied_program, AppConfig};
use crate::error::ActionError;

/// Spawn `app` detached from this process and return its PID.
pub fn launch(app: &AppConfig) -> Result<u32, ActionError> {
    let fail = |reason: &str| ActionError::Launch {
        id: app.id.clone(),
        reason: reason.to_owned(),
    };
    // Re-check at launch time; the policy was validated at load, but be strict.
    if !app.program.is_absolute() || is_denied_program(&app.program) {
        return Err(fail("program is not allowed"));
    }
    if !app.program.is_file() {
        return Err(fail("program not found on this computer"));
    }

    let mut cmd = Command::new(&app.program);
    cmd.args(&app.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Own process group: not killed with us, not tied to our terminal.
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    if let Some(home) = home_dir() {
        cmd.current_dir(home);
    }

    let mut child = cmd.spawn().map_err(|e| fail(&e.to_string()))?;
    let pid = child.id();
    // Reap the child when it exits so it never lingers as a zombie.
    let _ = std::thread::Builder::new()
        .name("jarvis-app-reaper".into())
        .spawn(move || {
            let _ = child.wait();
        });
    Ok(pid)
}

fn home_dir() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    let var = std::env::var_os("USERPROFILE");
    #[cfg(not(windows))]
    let var = std::env::var_os("HOME");
    var.map(std::path::PathBuf::from).filter(|p| p.is_dir())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    fn app(program: &str, args: &[&str]) -> AppConfig {
        AppConfig {
            id: "t".into(),
            label: "T".into(),
            program: PathBuf::from(program),
            args: args.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    fn wait_for(p: &Path) -> bool {
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if p.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn arguments_are_passed_literally_without_a_shell() {
        let Some(touch) = ["/usr/bin/touch", "/bin/touch"]
            .into_iter()
            .find(|p| Path::new(p).is_file())
        else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let literal = dir.path().join("a; touch pwned $(id)");
        let pid = launch(&app(touch, &[literal.to_str().unwrap()])).unwrap();
        assert!(pid > 0);
        assert!(wait_for(&literal), "file with the literal name is created");
        assert!(!dir.path().join("pwned").exists());
        assert!(!Path::new("pwned").exists());
    }

    #[test]
    fn refuses_missing_relative_and_denied_programs() {
        assert!(matches!(
            launch(&app("/nonexistent/prog", &[])),
            Err(ActionError::Launch { .. })
        ));
        assert!(matches!(launch(&app("touch", &[])), Err(ActionError::Launch { .. })));
        assert!(matches!(
            launch(&app("/bin/sh", &["-c", "true"])),
            Err(ActionError::Launch { .. })
        ));
    }
}
