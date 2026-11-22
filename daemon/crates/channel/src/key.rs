//! Reading the per-user key: 32 random bytes the daemon and every client read to prove themselves
//! to each other in the hello.
//!
//! Only the daemon creates the key (`ev3_cockpitd::key::ensure_key`). It writes it through a
//! temporary file and a link, so a short or missing read can only be momentary: readers try again a
//! few times before they give up.

use std::io;
use std::path::Path;
use std::time::Duration;

/// The key is exactly this long.
pub const KEY_BYTES: usize = 32;
const READ_ATTEMPTS: u32 = 5;
const READ_RETRY: Duration = Duration::from_millis(20);

/// Why the key cannot be used.
#[derive(Debug)]
pub struct KeyError(pub String);

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for KeyError {}

/// Reads an existing key, retrying a short or missing read a few times.
pub fn read_key(file: &Path) -> Result<Vec<u8>, KeyError> {
    let mut problem = String::new();
    for attempt in 1..=READ_ATTEMPTS {
        match std::fs::read(file) {
            Ok(key) if key.len() == KEY_BYTES => {
                check_private(file)?;
                return Ok(key);
            }
            Ok(key) => problem = format!("it has {} bytes instead of {KEY_BYTES}", key.len()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                problem = "it is not there".into();
            }
            Err(error) => {
                return Err(KeyError(format!(
                    "The cockpit key {} could not be read ({error}).",
                    file.display()
                )));
            }
        }
        if attempt < READ_ATTEMPTS {
            std::thread::sleep(READ_RETRY);
        }
    }
    Err(KeyError(format!(
        "The cockpit key {} could not be read: {problem}.",
        file.display()
    )))
}

/// Linux and macOS: the key must belong to the user and be readable by nobody else.
#[cfg(unix)]
fn check_private(file: &Path) -> Result<(), KeyError> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(file).map_err(|error| {
        KeyError(format!(
            "The cockpit key {} cannot be checked ({error}).",
            file.display()
        ))
    })?;
    // SAFETY: geteuid has no preconditions.
    let me = unsafe { libc::geteuid() };
    match key_file_problem(meta.file_type().is_symlink(), meta.mode(), meta.uid(), me) {
        Some(problem) => Err(KeyError(format!(
            "The cockpit key {} {problem}; it is not used.",
            file.display()
        ))),
        None => Ok(()),
    }
}

/// Windows: the key lives in the user's profile, which only the user can reach, and the daemon
/// created it with an owner-only DACL.
#[cfg(not(unix))]
fn check_private(_file: &Path) -> Result<(), KeyError> {
    Ok(())
}

/// What is wrong with a key file of this type, mode and owner, for user `me`.
pub fn key_file_problem(is_symlink: bool, mode: u32, owner: u32, me: u32) -> Option<String> {
    if is_symlink {
        return Some("is a link, not a file".into());
    }
    if owner != me {
        return Some("belongs to another user".into());
    }
    if mode & 0o077 != 0 {
        return Some(format!("can be read by others (mode {:o})", mode & 0o777));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_file_others_can_reach_is_refused() {
        assert_eq!(key_file_problem(false, 0o100600, 1000, 1000), None);
        assert!(key_file_problem(false, 0o100640, 1000, 1000).is_some());
        assert!(key_file_problem(false, 0o100604, 1000, 1000).is_some());
        assert!(key_file_problem(false, 0o100600, 1001, 1000).is_some());
        assert!(key_file_problem(true, 0o120777, 1000, 1000).is_some());
    }

    #[test]
    fn a_key_of_the_wrong_length_is_not_used() {
        let dir = std::env::temp_dir().join(format!(
            "ev3-key-{}",
            crate::hex(&crate::random_bytes::<6>())
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        let file = dir.join("key");
        std::fs::write(&file, [1u8; 31]).expect("write");
        let error = read_key(&file).expect_err("short");
        assert!(error.0.contains("31 bytes"), "{error}");
        std::fs::remove_dir_all(dir).expect("clean");
    }
}
