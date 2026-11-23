//! Which daemon this `ev3` carries, and which channel it talks to.
//!
//! - The daemon lies beside `ev3`, with its manifest: `daemon/target/<profile>/` in a development
//!   build (written by `npm run daemon:build`), the package directory in a release.
//! - Only a development build honours `EV3_COCKPIT_CHANNEL`, which puts it on a test channel of
//!   its own. Nothing in the environment changes which daemon a release build starts.

use std::path::{Path, PathBuf};

use ev3_channel::paths::{Paths, default_state_root, valid_channel_name};

use crate::error::{CliError, Failure, Result};
use ev3_client::launch::{LaunchSpec, manifest_launch};

/// This binary's version: the repository's `package.json` version at build time.
pub const VERSION: &str = env!("EV3_COCKPIT_VERSION");

/// This binary's build kind, fixed when it was compiled.
pub const BUILD_KIND: &str = if cfg!(ev3_release_build) {
    "release"
} else {
    "development"
};

/// The environment variable that names a test channel, for development builds.
pub const CHANNEL_ENV: &str = "EV3_COCKPIT_CHANNEL";

pub fn is_development() -> bool {
    BUILD_KIND == "development"
}

/// The directory `ev3` runs from.
fn own_dir() -> ev3_client::Result<PathBuf> {
    let exe = std::env::current_exe().map_err(|error| {
        ev3_client::ClientError::start(
            Failure::MissingBinary,
            format!("ev3 cannot tell where it runs from ({error})."),
        )
    })?;
    Ok(exe.parent().map(Path::to_path_buf).unwrap_or_default())
}

/// The daemon this installation carries.
pub fn daemon() -> ev3_client::Result<LaunchSpec> {
    let hint = if is_development() {
        "Build it with npm run daemon:build."
    } else {
        "Reinstall EVƎ Cockpit."
    };
    manifest_launch(&own_dir()?, hint)
}

/// The test channel `EV3_COCKPIT_CHANNEL` names, in a development build only.
pub fn channel() -> Result<Option<String>> {
    if !is_development() {
        return Ok(None);
    }
    match std::env::var(CHANNEL_ENV) {
        Ok(name) if !name.trim().is_empty() => {
            let name = name.trim().to_owned();
            if !valid_channel_name(&name) {
                return Err(CliError::usage(format!(
                    "\"{name}\" is not a usable channel name: use lowercase letters, digits and dashes."
                )));
            }
            Ok(Some(name))
        }
        _ => Ok(None),
    }
}

/// The files of the channel this `ev3` talks to.
pub fn paths(channel: Option<&str>) -> Result<Paths> {
    let root = default_state_root().map_err(|message| CliError::start(Failure::Failed, message))?;
    Ok(Paths::new(&root, channel))
}
