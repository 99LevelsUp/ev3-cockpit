//! What every `ev3` integration test needs to find, also when a cross build runs on another
//! machine than the one that built it (a Linux build copied into WSL or onto a board).

// Each test file uses its own part of this module.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

/// The `ev3` cargo built; beside this test's own folder when the build path does not exist here.
pub fn ev3() -> PathBuf {
    let built = PathBuf::from(env!("CARGO_BIN_EXE_ev3"));
    if built.exists() {
        return built;
    }
    let exe = std::env::current_exe().expect("test path");
    // The build path may be another OS's: its last part, by either separator, is the name. The
    // binary lies next to or above the test, by cargo's build layout (since 1.100 the tests sit
    // under target/<profile>/build/<crate>/<hash>/).
    let built = built.to_string_lossy().into_owned();
    let name = built.rsplit(['/', '\\']).next().expect("name");
    exe.ancestors()
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

/// The daemon cargo built beside `ev3`, when it was built and would run for this process: never
/// elevated (as administrator or root), as GitHub's Windows runners run every step.
pub fn daemon_beside_ev3() -> Option<PathBuf> {
    if ev3_channel::security::is_elevated().unwrap_or(false) {
        eprintln!("skipped: this process runs elevated, and the cockpit daemon refuses to run so");
        return None;
    }
    let name = if cfg!(windows) {
        "ev3-cockpitd.exe"
    } else {
        "ev3-cockpitd"
    };
    let daemon = ev3().parent()?.join(name);
    daemon.exists().then_some(daemon)
}

/// A recording; `EV3_FIXTURES` names their folder where the source tree is not at its build path.
pub fn fixture(scenario: &str) -> PathBuf {
    std::env::var_os("EV3_FIXTURES")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures"))
        .join(scenario)
}
