//! The per-user key: 32 random bytes the daemon and every client read to prove themselves to each
//! other in the hello.
//!
//! Only the daemon creates it: it writes the bytes to a temporary file in the same directory,
//! created readable by the user alone, and links that file into place. A link never replaces an
//! existing file, so two daemons starting at once end with one key: the one that lost the race
//! reads the winner's. Reading it is shared with the clients (`ev3_channel::key`).

use std::io;
use std::path::Path;

pub use ev3_channel::key::{KEY_BYTES, KeyError, key_file_problem, read_key};

/// Reads the key, creating it when there is none.
pub fn ensure_key(file: &Path) -> Result<Vec<u8>, KeyError> {
    match std::fs::symlink_metadata(file) {
        Ok(_) => read_key(file),
        Err(error) if error.kind() == io::ErrorKind::NotFound => create_key(file),
        Err(error) => Err(KeyError(format!(
            "The cockpit key {} cannot be checked ({error}).",
            file.display()
        ))),
    }
}

fn create_key(file: &Path) -> Result<Vec<u8>, KeyError> {
    let problem = |error: io::Error| {
        KeyError(format!(
            "The cockpit key {} could not be created ({error}).",
            file.display()
        ))
    };
    if let Some(dir) = file.parent() {
        crate::fsutil::create_private_dir_all(dir).map_err(problem)?;
    }
    let key = crate::random_bytes::<KEY_BYTES>();
    let temp = crate::fsutil::temp_beside(file);
    let written = (|| {
        use std::io::Write as _;
        let mut handle = crate::fsutil::create_new_private(&temp)?;
        handle.write_all(&key)?;
        handle.sync_all()
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(problem(error));
    }
    let linked = std::fs::hard_link(&temp, file);
    let _ = std::fs::remove_file(&temp);
    match linked {
        Ok(()) => Ok(key.to_vec()),
        // Another daemon made it first: use theirs.
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => read_key(file),
        Err(error) => Err(problem(error)),
    }
}
