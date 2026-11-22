//! Who this daemon is: its version, build kind and build id.

use std::io::{self, Read};
use std::path::Path;

use ev3_contract::BuildKind;
use sha2::{Digest, Sha256};

/// The daemon's version: the repository's `package.json` version, which `build.rs` reads when the
/// binary is compiled, so a daemon and the clients packaged with it report the same version.
pub const VERSION: &str = env!("EV3_COCKPIT_VERSION");

/// The build kind, fixed when the binary is compiled: a release build only when the release
/// packaging set `EV3_COCKPIT_RELEASE_BUILD=1` for the compile (see `build.rs`), a development
/// build otherwise. No environment variable, argument or setting read at run time changes it.
pub const fn build_kind() -> BuildKind {
    if cfg!(ev3_release_build) {
        BuildKind::Release
    } else {
        BuildKind::Development
    }
}

/// The build kind the daemon reports. Only a development build can be told, on a test channel, to
/// report itself as a release build, so tests can meet a release daemon without a second build; a
/// release build has no such argument and always reports release.
pub const fn reported_build_kind(report_release: bool) -> BuildKind {
    if report_release {
        BuildKind::Release
    } else {
        build_kind()
    }
}

/// SHA-256 of the file at `path`, lowercase hex: the build id, computed from the daemon's own
/// executable when it starts.
pub fn file_sha256(path: &Path) -> io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(crate::hex(&hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_daemon_reports_the_version_of_the_repository_package_json() {
        // A release daemon on 0.0.0 while the clients were 0.2.x made every client count as newer,
        // so an old `ev3` command would replace a newer daemon that VS Code had started.
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../package.json");
        let text = std::fs::read_to_string(&path).expect("the repository's package.json");
        let json: serde_json::Value = serde_json::from_str(&text).expect("package.json is JSON");
        assert_eq!(Some(VERSION), json["version"].as_str());
    }

    #[test]
    fn asking_to_report_release_never_makes_a_build_report_development() {
        assert_eq!(reported_build_kind(true), BuildKind::Release);
        assert_eq!(reported_build_kind(false), build_kind());
    }
}
