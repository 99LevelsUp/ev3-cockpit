//! Link settings and the build kind of the daemon binary.
//!
//! On Windows with the MSVC linker, the binary's static imports are resolved from System32 only
//! (`/DEPENDENTLOADFLAG:0x800`, the value of `LOAD_LIBRARY_SEARCH_SYSTEM32`), so a DLL planted
//! beside the executable under an imported name is never loaded. Runtime loads are restricted the
//! same way by `SetDefaultDllDirectories` at the start of `main`.
//!
//! The build kind is fixed here, when the binary is compiled. A build is a release build only when
//! the release packaging marks it by setting `EV3_COCKPIT_RELEASE_BUILD=1` for the compile; every
//! other build, debug or optimised, is a development build. The mark becomes the compile-time cfg
//! `ev3_release_build`; nothing the binary reads at run time can change it.
//!
//! The version is the repository's `package.json` version, the one the extension, the `ev3`
//! command and the npm packages carry, exported as `EV3_COCKPIT_VERSION`. Clients compare it with
//! their own to decide whether a daemon is older than they are, so the daemon must not report a
//! version of its own. The build fails when the file cannot be read.

use std::env;
use std::fs;
use std::path::Path;

/// The variable the release packaging sets, to `1`, for the compile of a published binary.
const RELEASE_MARK: &str = "EV3_COCKPIT_RELEASE_BUILD";

/// The repository's `package.json`, relative to this crate.
const PACKAGE_JSON: &str = "../../../package.json";

/// The `version` of the repository's `package.json`; rebuilds when it changes.
fn package_version() -> String {
    let dir = env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR");
    let path = Path::new(&dir).join(PACKAGE_JSON);
    println!("cargo:rerun-if-changed={}", path.display());
    let text = fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "the daemon takes its version from {}, which cannot be read: {error}",
            path.display()
        )
    });
    let json: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()));
    match json.get("version").and_then(|version| version.as_str()) {
        Some(version) if !version.is_empty() => version.to_owned(),
        _ => panic!("{} has no version", path.display()),
    }
}

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed={RELEASE_MARK}");
    println!("cargo:rustc-env=EV3_COCKPIT_VERSION={}", package_version());
    println!("cargo::rustc-check-cfg=cfg(ev3_release_build)");
    if env::var(RELEASE_MARK).as_deref() == Ok("1") {
        println!("cargo::rustc-cfg=ev3_release_build");
    }

    let os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if os == "windows" && target_env == "msvc" {
        println!("cargo:rustc-link-arg-bins=/DEPENDENTLOADFLAG:0x800");
    }
}
