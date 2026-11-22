//! Taking over the user's state from the Node daemon the native one replaces.
//!
//! The Node daemon kept its state in the platform's state directory, then `ev3-cockpit`: Windows
//! `%LOCALAPPDATA%\ev3-cockpit` (or the home folder's `AppData\Local\ev3-cockpit`), macOS
//! `~/Library/Application Support/ev3-cockpit`, Linux `$XDG_STATE_HOME/ev3-cockpit` (or
//! `~/.local/state/ev3-cockpit`). The native root is `native/` inside it, so the old root is the
//! native root's parent.
//!
//! The native daemon, starting on the user's channel and never on a test channel, takes over:
//!
//! - the transfer debts of the old `ledger.json`: every debt the native ledger lacks is added to
//!   it, so the slots a cut transfer left taken on a brick are still released. A slot debt is the
//!   same debt when the same brick owes the same slot; any other debt only when it is equal. The
//!   old file goes only after the native ledger was written and read back holding every old debt,
//!   and only if nobody changed it meanwhile; it does not stay behind under another name, because
//!   the native daemon pays the debts and a copy would bring paid ones back;
//! - the old `settings.json`, when the native daemon has no settings file yet: only the settings
//!   that are stored and fit their spec, so access mode `full` is never carried over;
//!
//! and removes what only the Node daemon used: its `key`, `handover*.json`, `hardware.lock` with its
//! `hardware.lock.<pid>` claims, `install.json` and the development channel `channels/dev`. A Node
//! daemon still running from an older extension folder serves its own channel and idles out.
//!
//! A damaged old file is said in the log and left where it is; nothing here stops the start. No
//! link is followed: a link is removed as a link, and a directory reached through one is left
//! alone. Running again changes nothing, so the migration simply runs at every start of the user's
//! channel and finds nothing to do once it is done.

use std::collections::BTreeMap;
use std::fs::Metadata;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use ev3_contract::{SettingScalar, setting_specs};
use ev3_runtime::{LedgerFile, TransferDebt};
use serde_json::Value;

use crate::log::Log;
use crate::paths::Paths;

/// The old root's file names that only the Node daemon used.
const OLD_FILES: [&str; 3] = ["key", "hardware.lock", "install.json"];

/// What one run took over and removed.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Migration {
    /// False on a test channel: nothing was looked at.
    pub ran: bool,
    /// Debts added to the native ledger.
    pub debts_added: usize,
    /// The old ledger was merged and removed.
    pub ledger_taken: bool,
    /// The old settings were copied.
    pub settings_copied: bool,
    /// The old files and directories removed.
    pub removed: Vec<PathBuf>,
}

/// The Node daemon's state root for a native root: its parent, when the native root is the
/// `native` directory the native daemon keeps inside it.
pub fn old_root(native_root: &Path) -> Option<PathBuf> {
    if native_root.file_name()? != "native" {
        return None;
    }
    native_root.parent().map(Path::to_path_buf)
}

/// Takes over the Node daemon's state under `old_root` for the channel of `paths`; a test channel
/// takes over nothing. Every problem goes to `log` and the start goes on.
pub fn migrate(old_root: &Path, paths: &Paths, log: &Log) -> Migration {
    let mut done = Migration::default();
    if paths.channel.is_some() {
        return done;
    }
    done.ran = true;
    match std::fs::symlink_metadata(old_root) {
        Ok(meta) if meta.is_dir() => {}
        _ => return done,
    }
    take_ledger(&old_root.join("ledger.json"), &paths.ledger, log, &mut done);
    copy_settings(
        &old_root.join("settings.json"),
        &paths.settings,
        log,
        &mut done,
    );
    remove_old_files(old_root, log, &mut done);
    done
}

// ── The ledger ──────────────────────────────────────────────────────

/// Whether `held` already owes `debt`: the same slot, or an equal debt of another kind.
fn owed(held: &[TransferDebt], debt: &TransferDebt) -> bool {
    match debt {
        TransferDebt::Slot { handle, .. } => held
            .iter()
            .any(|d| matches!(d, TransferDebt::Slot { handle: h, .. } if h == handle)),
        other => held.contains(other),
    }
}

fn take_ledger(old: &Path, native: &Path, log: &Log, done: &mut Migration) {
    let Some(text) = read_plain(old, "transfer ledger", log) else {
        return;
    };
    let old_debts: BTreeMap<String, Vec<TransferDebt>> = match serde_json::from_str(&text) {
        Ok(debts) => debts,
        Err(error) => {
            log.warn(&format!(
                "The previous daemon's transfer ledger {} cannot be read ({error}); it is left \
                 where it is and its debts are not taken over.",
                old.display()
            ));
            return;
        }
    };
    let store = match LedgerFile::open(native) {
        Ok(store) => store,
        Err(error) => {
            log.warn(&format!(
                "{error}; the previous daemon's transfer ledger {} is kept and taken over at a \
                 later start.",
                old.display()
            ));
            return;
        }
    };
    let mut bricks = 0;
    for (brick, debts) in &old_debts {
        let mut merged = store.load(brick);
        let before = merged.len();
        for debt in debts {
            if !owed(&merged, debt) {
                merged.push(debt.clone());
            }
        }
        if merged.len() == before {
            continue;
        }
        store.save(brick, &merged);
        if let Some(error) = store.last_error() {
            log.warn(&format!(
                "The transfer ledger {} could not be written ({error}); the previous daemon's \
                 ledger {} is kept and taken over at a later start.",
                native.display(),
                old.display()
            ));
            return;
        }
        done.debts_added += merged.len() - before;
        bricks += 1;
    }

    // The old file goes only once the native one, read back, owes everything it owed.
    let complete = LedgerFile::open(native).is_ok_and(|written| {
        old_debts.iter().all(|(brick, debts)| {
            let held = written.load(brick);
            debts.iter().all(|debt| owed(&held, debt))
        })
    });
    if !complete {
        log.warn(&format!(
            "The transfer ledger {} does not read back with every debt of the previous daemon's \
             ledger {}; that one is kept and taken over at a later start.",
            native.display(),
            old.display()
        ));
        return;
    }
    match std::fs::read_to_string(old) {
        Ok(now) if now == text => match std::fs::remove_file(old) {
            Ok(()) => done.ledger_taken = true,
            Err(error) => log.warn(&format!(
                "The previous daemon's transfer ledger {} could not be removed ({error}); its \
                 debts are in the native ledger already.",
                old.display()
            )),
        },
        Ok(_) => log.warn(&format!(
            "The previous daemon's transfer ledger {} changed while it was taken over; it is kept \
             and taken over again at the next start.",
            old.display()
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => done.ledger_taken = true,
        Err(error) => log.warn(&format!(
            "The previous daemon's transfer ledger {} could not be read again ({error}); it is \
             kept.",
            old.display()
        )),
    }
    if done.debts_added > 0 || done.ledger_taken {
        log.info(&format!(
            "Took over the previous daemon's transfer ledger {}: {} debt(s) added for {bricks} \
             brick(s).",
            old.display(),
            done.debts_added
        ));
    }
}

// ── The settings ────────────────────────────────────────────────────

fn copy_settings(old: &Path, native: &Path, log: &Log, done: &mut Migration) {
    match std::fs::symlink_metadata(native) {
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        _ => return,
    }
    let Some(text) = read_plain(old, "settings file", log) else {
        return;
    };
    let Ok(Value::Object(stored)) = serde_json::from_str::<Value>(&text) else {
        log.warn(&format!(
            "The previous daemon's settings file {} is not a JSON object; it is left where it is \
             and not taken over.",
            old.display()
        ));
        return;
    };
    let specs = setting_specs();
    let mut kept = serde_json::Map::new();
    let mut dropped = Vec::new();
    for (key, raw) in stored {
        let fits = specs
            .iter()
            .find(|spec| spec.key == key && spec.stored)
            .zip(serde_json::from_value::<SettingScalar>(raw.clone()).ok())
            .is_some_and(|(spec, value)| crate::settings::problem(spec, &value).is_none());
        if fits {
            kept.insert(key, raw);
        } else {
            dropped.push(key);
        }
    }
    if !dropped.is_empty() {
        log.warn(&format!(
            "Not taken over from the previous daemon's settings: {}.",
            dropped.join(", ")
        ));
    }
    if kept.is_empty() {
        return;
    }
    let names: Vec<String> = kept.keys().cloned().collect();
    let mut text = match serde_json::to_string_pretty(&Value::Object(kept)) {
        Ok(text) => text,
        Err(error) => {
            log.warn(&format!("The settings could not be taken over ({error})."));
            return;
        }
    };
    text.push('\n');
    match crate::fsutil::write_atomic(native, text.as_bytes()) {
        Ok(()) => {
            done.settings_copied = true;
            log.info(&format!(
                "Took over the previous daemon's settings from {}: {}.",
                old.display(),
                names.join(", ")
            ));
        }
        Err(error) => log.warn(&format!(
            "The settings file {} could not be written ({error}); the previous daemon's settings \
             are taken over at a later start.",
            native.display()
        )),
    }
}

// ── The files only the Node daemon used ─────────────────────────────

fn remove_old_files(old_root: &Path, log: &Log, done: &mut Migration) {
    let mut files: Vec<PathBuf> = OLD_FILES.iter().map(|name| old_root.join(name)).collect();
    if let Ok(entries) = std::fs::read_dir(old_root) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let claim = name
                .strip_prefix("hardware.lock.")
                .is_some_and(|pid| !pid.is_empty() && pid.bytes().all(|b| b.is_ascii_digit()));
            let handover = name.starts_with("handover") && name.ends_with(".json");
            if claim || handover {
                files.push(entry.path());
            }
        }
    }
    for file in files {
        remove(&file, false, log, done);
    }

    let channels = old_root.join("channels");
    match std::fs::symlink_metadata(&channels) {
        Ok(meta) if is_link(&meta) => log.warn(&format!(
            "{} is a link; the previous daemon's development channel behind it is left alone.",
            channels.display()
        )),
        Ok(meta) if meta.is_dir() => remove(&channels.join("dev"), true, log, done),
        _ => {}
    }

    if !done.removed.is_empty() {
        let names: Vec<String> = done
            .removed
            .iter()
            .map(|p| p.display().to_string())
            .collect();
        log.info(&format!(
            "Removed what only the previous daemon used: {}.",
            names.join(", ")
        ));
    }
}

/// Removes `path` without following a link: a link goes as a link, a directory (when `dir`) with
/// everything in it, a file as a file.
fn remove(path: &Path, dir: bool, log: &Log, done: &mut Migration) {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == ErrorKind::NotFound => return,
        Err(error) => {
            log.warn(&format!(
                "{} could not be looked at ({error}).",
                path.display()
            ));
            return;
        }
    };
    let removed = if is_link(&meta) {
        // A link to a directory is removed as a directory entry on Windows.
        std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path))
    } else if meta.is_dir() {
        if !dir {
            log.warn(&format!(
                "{} is a directory where the previous daemon kept a file; it is left alone.",
                path.display()
            ));
            return;
        }
        // Does not follow links inside: each is removed as a link.
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    match removed {
        Ok(()) => done.removed.push(path.to_path_buf()),
        Err(error) => log.warn(&format!(
            "{} could not be removed ({error}).",
            path.display()
        )),
    }
}

/// A symbolic link, a junction or any other reparse point.
fn is_link(meta: &Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// The text of an old file that is a plain file; `None` when there is none, and with a warning when
/// it is a link or cannot be read.
fn read_plain(path: &Path, what: &str, log: &Log) -> Option<String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => return None,
        Err(error) => {
            log.warn(&format!(
                "The previous daemon's {what} {} could not be looked at ({error}); it is not \
                 taken over.",
                path.display()
            ));
            return None;
        }
        Ok(meta) if is_link(&meta) || !meta.is_file() => {
            log.warn(&format!(
                "The previous daemon's {what} {} is not a plain file; it is left where it is and \
                 not taken over.",
                path.display()
            ));
            return None;
        }
        Ok(_) => {}
    }
    match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(error) => {
            log.warn(&format!(
                "The previous daemon's {what} {} could not be read ({error}); it is left where it \
                 is and not taken over.",
                path.display()
            ));
            None
        }
    }
}
