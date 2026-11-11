fn main() {
    // Declaring the app commands in an app manifest makes Tauri generate
    // `allow-<command>` permissions for them. Once an app manifest exists,
    // a command is callable ONLY from windows/origins granted that permission
    // by a capability file (see capabilities/main.json).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "desktop_info",
            "execute_action",
            "set_emergency_stop",
        ])),
    )
    .expect("failed to run tauri-build");
}
