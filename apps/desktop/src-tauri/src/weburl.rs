//! Which URL the main window loads, and where it may navigate.

use tauri::Url;

use jarvis_desktop_policy::config::DEFAULT_URL;

/// Environment variable that overrides the policy's `url` field.
pub const URL_ENV: &str = "JARVIS_URL";

/// Resolve the JARVIS web UI URL: `JARVIS_URL`, else the policy's `url`,
/// else [`DEFAULT_URL`]. Invalid values are skipped with a warning.
pub fn resolve(env: Option<&str>, config: Option<&str>) -> (Url, Vec<String>) {
    let mut warnings = Vec::new();
    for (source, value) in [(URL_ENV, env), ("policy url", config)] {
        let Some(raw) = value.map(str::trim).filter(|v| !v.is_empty()) else {
            continue;
        };
        match parse(raw) {
            Ok(url) => {
                if !is_loopback(&url) {
                    warnings.push(format!(
                        "{source} '{url}' is not a loopback address; native desktop commands are only granted to \
                         http://127.0.0.1:* and http://localhost:* and will be unavailable"
                    ));
                }
                return (url, warnings);
            }
            Err(e) => warnings.push(format!("ignoring {source} '{raw}': {e}")),
        }
    }
    (Url::parse(DEFAULT_URL).expect("default URL is valid"), warnings)
}

fn parse(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http and https URLs are allowed".into());
    }
    if url.host_str().is_none() {
        return Err("URL has no host".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials in the URL are not allowed".into());
    }
    Ok(url)
}

/// `true` for hosts covered by the capability's remote URL patterns.
pub fn is_loopback(url: &Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
}

/// Navigation policy for the main window: stay on the JARVIS origin, or the
/// bundled offline page. Everything else (external links, file://, data:,
/// javascript:) is blocked; the app has no opener to hand links to.
pub fn navigation_allowed(target: &Url, home: &Url) -> bool {
    if target.origin() == home.origin() {
        return true;
    }
    is_bundled_asset(target) || target.as_str() == "about:blank"
}

/// The URL of bundled assets (the offline page): `tauri://localhost` on
/// Linux/macOS, `http(s)://tauri.localhost` on Windows.
pub fn is_bundled_asset(url: &Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_beats_config_beats_default() {
        let (u, w) = resolve(Some("http://localhost:3000/"), Some("http://127.0.0.1:9000/"));
        assert_eq!(u.as_str(), "http://localhost:3000/");
        assert!(w.is_empty());
        let (u, _) = resolve(None, Some("http://127.0.0.1:9000/app"));
        assert_eq!(u.as_str(), "http://127.0.0.1:9000/app");
        let (u, _) = resolve(None, None);
        assert_eq!(u.as_str(), DEFAULT_URL);
        let (u, _) = resolve(Some("  "), None);
        assert_eq!(u.as_str(), DEFAULT_URL);
    }

    #[test]
    fn invalid_urls_fall_through_with_warnings() {
        let (u, w) = resolve(Some("file:///etc/passwd"), Some("javascript:alert(1)"));
        assert_eq!(u.as_str(), DEFAULT_URL);
        assert_eq!(w.len(), 2);
        let (u, w) = resolve(Some("http://user:pw@127.0.0.1:8000/"), None);
        assert_eq!(u.as_str(), DEFAULT_URL);
        assert_eq!(w.len(), 1);
    }

    #[test]
    fn non_loopback_is_allowed_but_warned() {
        let (u, w) = resolve(Some("https://jarvis.example.com/"), None);
        assert_eq!(u.host_str(), Some("jarvis.example.com"));
        assert_eq!(w.len(), 1);
        assert!(!is_loopback(&u));
    }

    #[test]
    fn navigation_stays_on_origin() {
        let home = Url::parse("http://127.0.0.1:8000/").unwrap();
        let ok = |s: &str| navigation_allowed(&Url::parse(s).unwrap(), &home);
        assert!(ok("http://127.0.0.1:8000/chat?x=1"));
        assert!(ok("tauri://localhost/index.html"));
        assert!(ok("http://tauri.localhost/index.html"));
        assert!(!ok("http://127.0.0.1:8001/"));
        assert!(!ok("http://localhost:8000/"));
        assert!(!ok("https://evil.example/"));
        assert!(!ok("file:///etc/passwd"));
        assert!(!ok("data:text/html,hi"));
    }
}
