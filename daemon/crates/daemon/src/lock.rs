//! The single-instance lock: before anything else the daemon takes an exclusive OS lock on
//! `daemon.lock` in its channel directory and holds it for its whole life. A daemon that cannot
//! take it exits with code 2.
//!
//! Windows: the file is opened with share mode 0 and kept open, and `LockFileEx` locks it. The
//! share-none handle is also the client's liveness test: a client that can open the file for
//! writing knows no daemon holds it. A client's probe holds the file for a moment, so the
//! share-none open is retried for about a second on a sharing violation.
//!
//! Linux and macOS: an exclusive `flock`. The file is never removed, since a removed lock file
//! would let two later daemons lock two different files.

use std::fs::File;
use std::io;
use std::path::Path;

/// Held for the daemon's whole life; dropping it releases the lock.
#[derive(Debug)]
pub struct InstanceLock {
    _file: File,
}

/// Why the lock was not taken.
#[derive(Debug)]
pub enum LockError {
    /// Another daemon holds it.
    Held,
    /// The file could not be opened or locked.
    Io(io::Error),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Held => f.write_str("another cockpit daemon holds this channel's lock"),
            Self::Io(error) => write!(f, "the lock file could not be taken ({error})"),
        }
    }
}

/// Takes the lock on `path`, creating the file readable and writable by the user alone.
pub fn acquire(path: &Path) -> Result<InstanceLock, LockError> {
    imp::acquire(path).map(|file| InstanceLock { _file: file })
}

#[cfg(windows)]
mod imp {
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use std::time::{Duration, Instant};

    use windows_sys::Win32::Foundation::{ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION};
    use windows_sys::Win32::Storage::FileSystem::{
        LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    use super::LockError;
    use crate::fsutil::windows::{Disposition, create_file};

    /// How long a client's probe may keep the share-none open from succeeding.
    const SHARING_RETRY: Duration = Duration::from_millis(1000);

    pub fn acquire(path: &Path) -> Result<File, LockError> {
        let deadline = Instant::now() + SHARING_RETRY;
        let file = loop {
            match create_file(path, Disposition::OpenAlways, false) {
                Ok(file) => break file,
                Err(error) if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32) => {
                    if Instant::now() >= deadline {
                        return Err(LockError::Held);
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(LockError::Io(error)),
            }
        };
        // SAFETY: a zeroed OVERLAPPED selects offset 0; the handle is open and owned by `file`.
        let locked = unsafe {
            let mut overlapped: OVERLAPPED = std::mem::zeroed();
            LockFileEx(
                file.as_raw_handle(),
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        };
        if locked == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
                return Err(LockError::Held);
            }
            return Err(LockError::Io(error));
        }
        Ok(file)
    }
}

#[cfg(unix)]
mod imp {
    use std::fs::File;
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;
    use std::path::Path;

    use super::LockError;

    pub fn acquire(path: &Path) -> Result<File, LockError> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)
            .map_err(LockError::Io)?;
        // SAFETY: the descriptor is open and owned by `file`.
        let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if locked != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
                return Err(LockError::Held);
            }
            return Err(LockError::Io(error));
        }
        Ok(file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_second_taker_finds_the_lock_held_until_the_first_lets_go() {
        let dir = std::env::temp_dir().join(format!(
            "ev3d-lock-{}",
            crate::hex(&crate::random_bytes::<6>())
        ));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("daemon.lock");
        let first = acquire(&path).expect("first");
        assert!(matches!(acquire(&path), Err(LockError::Held)));
        drop(first);
        let again = acquire(&path).expect("after release");
        drop(again);
        std::fs::remove_dir_all(dir).expect("clean");
    }
}
