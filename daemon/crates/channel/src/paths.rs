//! Where the daemon keeps its files.
//!
//! The state root is the platform's state directory, then `ev3-cockpit/native`: Windows
//! `%LOCALAPPDATA%`, macOS `~/Library/Application Support`, Linux `$XDG_STATE_HOME` or
//! `~/.local/state`. The key lives in the root and is shared by every channel; a channel's own
//! files live in the root for the user's channel, or in `channels/<name>/` for a test channel.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The platform's state root for the native daemon, from the environment.
pub fn default_state_root() -> Result<PathBuf, String> {
    state_root_from(&|name| std::env::var_os(name))
}

/// The state root from environment variables `var` gives: the rule the clients follow too,
/// checked on both sides against `contract/vectors/channel.json`.
pub fn state_root_from(var: &dyn Fn(&str) -> Option<OsString>) -> Result<PathBuf, String> {
    let set = |name: &str| var(name).filter(|value| !value.is_empty());
    Ok(platform_state_dir(&set)?.join("ev3-cockpit").join("native"))
}

#[cfg(windows)]
fn platform_state_dir(set: &dyn Fn(&str) -> Option<OsString>) -> Result<PathBuf, String> {
    if let Some(dir) = set("LOCALAPPDATA") {
        return Ok(PathBuf::from(dir));
    }
    let home = set("USERPROFILE").ok_or(
        "Neither LOCALAPPDATA nor USERPROFILE is set; the daemon cannot find its state directory.",
    )?;
    Ok(PathBuf::from(home).join("AppData").join("Local"))
}

#[cfg(target_os = "macos")]
fn platform_state_dir(set: &dyn Fn(&str) -> Option<OsString>) -> Result<PathBuf, String> {
    Ok(home(set)?.join("Library").join("Application Support"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_state_dir(set: &dyn Fn(&str) -> Option<OsString>) -> Result<PathBuf, String> {
    // A relative XDG_STATE_HOME is invalid and ignored, as the XDG specification says.
    if let Some(dir) = set("XDG_STATE_HOME").map(PathBuf::from)
        && dir.is_absolute()
    {
        return Ok(dir);
    }
    Ok(home(set)?.join(".local").join("state"))
}

#[cfg(unix)]
fn home(set: &dyn Fn(&str) -> Option<OsString>) -> Result<PathBuf, String> {
    set("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set; the daemon cannot find its state directory.".to_string())
}

/// A channel name that cannot leave its directory: `^[a-z0-9][a-z0-9-]{0,31}$`.
pub fn valid_channel_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// Every file of one channel.
#[derive(Debug, Clone)]
pub struct Paths {
    /// The state root.
    pub root: PathBuf,
    /// The test channel's name, or `None` for the user's channel.
    pub channel: Option<String>,
    /// The channel's directory: the root, or `channels/<name>/` in it.
    pub dir: PathBuf,
    /// The per-user key, shared by every channel.
    pub key: PathBuf,
    /// The single-instance lock.
    pub lock: PathBuf,
    /// `channel.json`: where clients find the pipe or socket.
    pub record: PathBuf,
    /// The settings file.
    pub settings: PathBuf,
    /// The log file; older ones get `.1` and `.2`.
    pub log: PathBuf,
    /// `held.json`: the bricks `ev3 connect` holds, connected again by the next daemon.
    pub held: PathBuf,
    /// `ledger.json`: what cut transfers left owed on each brick.
    pub ledger: PathBuf,
    /// Linux and macOS: the directory the socket lives in.
    #[cfg(unix)]
    pub socket_dir: PathBuf,
}

impl Paths {
    /// The files of `channel` (or the user's channel) under `root`.
    pub fn new(root: &Path, channel: Option<&str>) -> Self {
        let dir = match channel {
            Some(name) => root.join("channels").join(name),
            None => root.to_path_buf(),
        };
        Self {
            root: root.to_path_buf(),
            channel: channel.map(str::to_string),
            key: root.join("key"),
            lock: dir.join("daemon.lock"),
            record: dir.join("channel.json"),
            settings: dir.join("settings.json"),
            log: dir.join("daemon.log"),
            held: dir.join("held.json"),
            ledger: dir.join("ledger.json"),
            #[cfg(unix)]
            socket_dir: socket_dir(root),
            dir,
        }
    }
}

/// `$XDG_RUNTIME_DIR/ev3-cockpit`, else the state root's `run/`; never a shared directory such as
/// `/tmp`.
#[cfg(unix)]
fn socket_dir(root: &Path) -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR").filter(|d| !d.is_empty()) {
        Some(dir) if Path::new(&dir).is_absolute() => PathBuf::from(dir).join("ev3-cockpit"),
        _ => root.join("run"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_test_channel_has_its_own_directory_and_shares_the_key() {
        let root = PathBuf::from(if cfg!(windows) { "C:\\s" } else { "/s" });
        let user = Paths::new(&root, None);
        let test = Paths::new(&root, Some("ci"));
        assert_eq!(user.dir, root);
        assert_eq!(test.dir, root.join("channels").join("ci"));
        assert_eq!(user.key, test.key);
        assert_eq!(test.lock, test.dir.join("daemon.lock"));
        assert_eq!(test.record, test.dir.join("channel.json"));
    }

    #[test]
    fn the_state_root_matches_the_cross_language_vectors_of_this_platform() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../../../../contract/vectors/channel.json"))
                .expect("vectors");
        let platform = if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let mut checked = 0;
        for case in vectors["stateRoot"].as_array().expect("stateRoot") {
            if case["platform"] != platform {
                continue;
            }
            let env = case["env"].as_object().expect("env").clone();
            let home = case["home"].as_str().expect("home").to_owned();
            let var = |name: &str| {
                if name == home_var {
                    return Some(OsString::from(&home));
                }
                env.get(name)
                    .and_then(|value| value.as_str())
                    .map(OsString::from)
            };
            assert_eq!(
                state_root_from(&var).expect("root"),
                PathBuf::from(case["root"].as_str().expect("root")),
                "{}",
                case["comment"]
            );
            checked += 1;
        }
        assert!(checked > 0, "no vector for {platform}");
    }
}
