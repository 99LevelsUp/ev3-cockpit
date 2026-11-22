//! Add-ons: `ev3 <name> …` runs an installed program called `ev3-<name>`.
//!
//! `ev3` finds it itself, walking PATH, so nothing about the lookup is left to a shell:
//! - only absolute PATH entries count; the current folder and relative entries never do;
//! - the name must match `^[a-z][a-z0-9-]*$`, so it cannot climb folders or carry shell syntax;
//! - on Windows only `.exe` files and the `.cmd` shims npm installs count. A shim is read for the
//!   Node script it starts, and that script is run with the `node.exe` found on PATH, never
//!   through `cmd.exe`;
//! - the program is started by its absolute path, with no shell, its arguments passed as they are.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::error::{CliError, Result};

/// How to start an add-on.
#[derive(Debug, PartialEq, Eq)]
pub struct AddonLaunch {
    /// An absolute path.
    pub command: PathBuf,
    pub args: Vec<OsString>,
    /// The file found on PATH.
    pub found: PathBuf,
}

/// Checks an add-on's name; a name that could escape its folder or reach a shell is refused.
pub fn check_name(name: &str) -> Result<()> {
    let bytes = name.as_bytes();
    let ok = !bytes.is_empty()
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-');
    if ok {
        Ok(())
    } else {
        Err(CliError::usage(format!(
            "{} is not a command, and not a name an add-on can have (lowercase letters, digits and dashes).",
            serde_json::Value::String(name.to_owned())
        )))
    }
}

/// The Node script an npm `.cmd` shim starts: the last `"%dp0%\…\script.js" %*` in it.
#[cfg(any(windows, test))]
pub fn shim_script(shim: &Path, text: &str) -> Option<PathBuf> {
    let mut last = None;
    let lower = text.to_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find("dp0") {
        let start = from + at;
        from = start + 3;
        let rest = &text[start + 3..];
        let rest = rest.strip_prefix('%').unwrap_or(rest);
        let Some(rest) = rest.strip_prefix('\\') else {
            continue;
        };
        let Some(end) = rest.find('"') else { continue };
        let script = &rest[..end];
        let after = rest[end + 1..].trim_start();
        let is_js = [".js", ".cjs", ".mjs"]
            .iter()
            .any(|e| script.to_lowercase().ends_with(e));
        if is_js && !script.contains('%') && after.starts_with("%*") {
            last = Some(script.to_owned());
        }
    }
    let script = shim
        .parent()?
        .join(last?.replace('\\', std::path::MAIN_SEPARATOR_STR));
    script.is_file().then_some(script)
}

#[cfg(unix)]
fn is_executable(file: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(file).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The absolute directories on PATH, in order.
fn path_dirs() -> Vec<PathBuf> {
    let Some(value) = std::env::var_os("PATH") else {
        return Vec::new();
    };
    std::env::split_paths(&value)
        .map(|dir| {
            let text = dir.to_string_lossy();
            let unquoted = text.trim().trim_matches('"');
            PathBuf::from(unquoted)
        })
        .filter(|dir| !dir.as_os_str().is_empty() && dir.is_absolute())
        .collect()
}

/// Finds `ev3-<name>` on PATH; `None` when no folder on PATH has it.
pub fn find(name: &str) -> Result<Option<AddonLaunch>> {
    check_name(name)?;
    let file = format!("ev3-{name}");
    let dirs = path_dirs();
    for dir in &dirs {
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{file}.exe"));
            if exe.is_file() {
                return Ok(Some(AddonLaunch {
                    command: exe.clone(),
                    args: Vec::new(),
                    found: exe,
                }));
            }
            let shim = dir.join(format!("{file}.cmd"));
            if shim.is_file() {
                let Ok(text) = std::fs::read_to_string(&shim) else {
                    continue;
                };
                let Some(script) = shim_script(&shim, &text) else {
                    continue;
                };
                let Some(node) = dirs
                    .iter()
                    .map(|d| d.join("node.exe"))
                    .find(|n| n.is_file())
                else {
                    continue;
                };
                return Ok(Some(AddonLaunch {
                    command: node,
                    args: vec![script.into_os_string()],
                    found: shim,
                }));
            }
        }
        #[cfg(unix)]
        {
            let candidate = dir.join(&file);
            if is_executable(&candidate) {
                return Ok(Some(AddonLaunch {
                    command: candidate.clone(),
                    args: Vec::new(),
                    found: candidate,
                }));
            }
        }
    }
    Ok(None)
}

/// Runs an add-on in this terminal and returns its exit code.
pub fn run(launch: &AddonLaunch, args: &[String]) -> u8 {
    match Command::new(&launch.command)
        .args(&launch.args)
        .args(args)
        .status()
    {
        Ok(status) => status
            .code()
            .map_or(1, |code| u8::try_from(code).unwrap_or(1)),
        Err(error) => {
            eprintln!("ev3: {} could not start: {error}", launch.found.display());
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_add_on_name_cannot_climb_or_carry_shell_syntax() {
        assert!(check_name("c").is_ok());
        assert!(check_name("eve-c2").is_ok());
        for bad in ["", "C", "../x", "a b", "a;b", "-a", "1a", "a.exe"] {
            assert!(check_name(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn the_script_an_npm_shim_starts_is_found_beside_it() {
        let dir = std::env::temp_dir().join(format!(
            "ev3-shim-{}",
            ev3_channel::hex(&ev3_channel::random_bytes::<6>())
        ));
        std::fs::create_dir_all(dir.join("node_modules").join("x")).expect("dirs");
        let script = dir.join("node_modules").join("x").join("cli.js");
        std::fs::write(&script, "").expect("script");
        let shim = dir.join("ev3-x.cmd");
        let text = "@ECHO off\r\n\"%_prog%\"  \"%dp0%\\node_modules\\x\\cli.js\" %*\r\n";
        assert_eq!(shim_script(&shim, text), Some(script));
        assert_eq!(shim_script(&shim, "\"%dp0%\\missing.js\" %*"), None);
        std::fs::remove_dir_all(dir).expect("clean");
    }
}
