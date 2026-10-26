fn main() {
    // The dialog plugin imports comctl32!TaskDialogIndirect, which exists only in
    // Common Controls v6. tauri-build embeds the manifest that selects v6 into
    // the app binary only, so `cargo test` binaries failed to load
    // (STATUS_ENTRYPOINT_NOT_FOUND). Embed it through the linker for every
    // binary instead, and stop tauri-build adding a second copy.
    let mut attrs = tauri_build::Attributes::new();
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        let manifest = std::env::current_dir().unwrap().join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attrs = attrs.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attrs).expect("failed to run tauri-build");
}
