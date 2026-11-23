//! The channel: a named pipe on Windows, a unix socket on Linux and macOS, under a name drawn at
//! each start, and `channel.json`, which tells clients where it is.
//!
//! The name is HMAC-SHA256 with the user's key over a fixed label and 16 bytes drawn at the start,
//! truncated; a test channel adds its name to the label. Nobody without the key can predict it,
//! and a pipe squatted under an earlier daemon's name is never contacted, because clients connect
//! only to the path the lock holder recorded.

use std::io;
use std::path::{Path, PathBuf};

use ev3_contract::ChannelRecord;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tokio::io::{AsyncRead, AsyncWrite};

/// The label the name is derived over, for the user's channel or a test channel.
pub fn name_label(channel: Option<&str>) -> String {
    match channel {
        None => "ev3-cockpit/channel".into(),
        Some(name) => format!("ev3-cockpit/channel/{name}"),
    }
}

/// HMAC-SHA256 with `key` over the label, a newline and `nonce`.
pub fn name_hash(key: &[u8], channel: Option<&str>, nonce: &[u8; 16]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(name_label(channel).as_bytes());
    mac.update(b"\n");
    mac.update(nonce);
    mac.finalize().into_bytes().into()
}

/// Windows: `\\.\pipe\ev3-cockpit-<16 hex digits>`.
pub fn pipe_path(hash: &[u8; 32]) -> String {
    format!(r"\\.\pipe\ev3-cockpit-{}", crate::hex(&hash[..8]))
}

/// Linux and macOS: `<socket dir>/daemon-<10 hex digits>.sock`.
pub fn socket_path(dir: &Path, hash: &[u8; 32]) -> PathBuf {
    dir.join(format!("daemon-{}.sock", crate::hex(&hash[..5])))
}

/// `channel.json` as the daemon writes it.
pub fn record_text(path: &str, pid: u32) -> String {
    serde_json::to_string(&ChannelRecord {
        path: path.to_string(),
        pid: u64::from(pid),
    })
    .expect("a channel record encodes")
}

/// A connected client's stream.
pub trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

/// Why the channel could not be opened.
#[derive(Debug)]
pub enum BindError {
    /// Someone else already holds the name, or the place for the socket is not the user's alone:
    /// the daemon refuses to run there.
    Refused(String),
    /// Anything else.
    Io(io::Error),
}

impl std::fmt::Display for BindError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(message) => f.write_str(message),
            Self::Io(error) => write!(f, "the channel could not be opened ({error})"),
        }
    }
}

#[cfg(windows)]
pub use windows::Listener;

#[cfg(windows)]
mod windows {
    use std::ffi::c_void;
    use std::io;

    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

    use super::{BindError, Duplex};
    use crate::fsutil::windows::OwnerOnly;

    /// The daemon's pipe. One instance always listens; each created with the owner-only DACL
    /// and refusing remote clients.
    pub struct Listener {
        path: String,
        owner: OwnerOnly,
        listening: NamedPipeServer,
    }

    impl Listener {
        /// Creates the first instance of `path`. A name someone else already created is refused.
        pub fn bind(path: &str) -> Result<Self, BindError> {
            let owner = OwnerOnly::current_user().map_err(BindError::Io)?;
            let listening = create(path, &owner, true).map_err(|error| {
                // ERROR_ACCESS_DENIED: an instance of this name exists already;
                // ERROR_PIPE_BUSY: the same, with every instance taken.
                if matches!(error.raw_os_error(), Some(5 | 231)) {
                    BindError::Refused(format!(
                        "The pipe {path} was already created by another process; the daemon refuses to serve on a name someone else holds."
                    ))
                } else {
                    BindError::Io(error)
                }
            })?;
            Ok(Self {
                path: path.to_string(),
                owner,
                listening,
            })
        }

        /// The pipe path.
        pub fn path(&self) -> &str {
            &self.path
        }

        /// Waits for the next client; a fresh instance listens before the connected one is
        /// handed out.
        pub async fn accept(&mut self) -> io::Result<Box<dyn Duplex>> {
            loop {
                match self.listening.connect().await {
                    Ok(()) => {
                        let next = create(&self.path, &self.owner, false)?;
                        let connected = std::mem::replace(&mut self.listening, next);
                        return Ok(Box::new(connected));
                    }
                    // ERROR_NO_DATA: the client left before it was accepted.
                    Err(error) if error.raw_os_error() == Some(232) => {
                        self.listening = create(&self.path, &self.owner, false)?;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
    }

    fn create(path: &str, owner: &OwnerOnly, first: bool) -> io::Result<NamedPipeServer> {
        let mut attributes = owner.attributes();
        // SAFETY: `attributes` points at a valid descriptor owned by `owner`, which outlives
        // the call; the pipe keeps its own copy of the security descriptor.
        unsafe {
            ServerOptions::new()
                .first_pipe_instance(first)
                .reject_remote_clients(true)
                .create_with_security_attributes_raw(
                    path,
                    (&mut attributes as *mut _) as *mut c_void,
                )
        }
    }
}

/// The longest socket path, in bytes: `sun_path` holds 108 bytes with its NUL on Linux, 104 on
/// macOS.
pub const MAX_SOCKET_PATH: usize = if cfg!(target_os = "macos") { 103 } else { 107 };

#[cfg(unix)]
pub use unix::Listener;

#[cfg(unix)]
mod unix {
    use std::io;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};

    use tokio::net::UnixListener;

    use super::{BindError, Duplex, MAX_SOCKET_PATH};
    use crate::fsutil::{dir_facts, private_dir_problem};

    /// The daemon's socket.
    pub struct Listener {
        path: String,
        listener: UnixListener,
    }

    impl Listener {
        /// Makes the socket directory if needed, refuses one that is not the user's alone, and
        /// binds `path` in it.
        pub fn bind(path: &str) -> Result<Self, BindError> {
            let socket = PathBuf::from(path);
            if path.len() > MAX_SOCKET_PATH {
                return Err(BindError::Refused(format!(
                    "The socket path {path} is longer than {MAX_SOCKET_PATH} bytes; choose a shorter state or runtime directory."
                )));
            }
            let dir = socket.parent().ok_or_else(|| {
                BindError::Refused(format!("The socket path {path} has no directory."))
            })?;
            ensure_private_dir(dir)?;
            let listener = UnixListener::bind(&socket).map_err(|error| {
                if error.kind() == io::ErrorKind::AddrInUse {
                    BindError::Refused(format!(
                        "The socket {path} already exists; the daemon refuses to serve on a name someone else holds."
                    ))
                } else {
                    BindError::Io(error)
                }
            })?;
            std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))
                .map_err(BindError::Io)?;
            Ok(Self {
                path: path.to_string(),
                listener,
            })
        }

        /// The socket path.
        pub fn path(&self) -> &str {
            &self.path
        }

        /// Waits for the next client.
        pub async fn accept(&mut self) -> io::Result<Box<dyn Duplex>> {
            let (stream, _) = self.listener.accept().await?;
            Ok(Box::new(stream))
        }
    }

    impl Drop for Listener {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    /// Makes the socket directory, or checks the one that exists, which must be the user's alone.
    ///
    /// The directory is created with mode 0700 in the same call, never widened first and narrowed
    /// afterwards: a second daemon starting at the same moment finds it already private, and both
    /// creators succeed.
    pub(super) fn ensure_private_dir(dir: &Path) -> Result<(), BindError> {
        match crate::fsutil::create_private_dir_all(dir) {
            Ok(()) => {}
            // Something other than a directory holds the name: the check below refuses it.
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(BindError::Io(error)),
        }
        let facts = dir_facts(dir).map_err(BindError::Io)?;
        // SAFETY: geteuid has no preconditions.
        let me = unsafe { libc::geteuid() };
        match private_dir_problem(facts, me) {
            Some(problem) => Err(BindError::Refused(format!(
                "{} {problem}; the daemon will not put its socket there.",
                dir.display()
            ))),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_depends_on_key_nonce_and_channel() {
        let key = [7u8; 32];
        let nonce = [1u8; 16];
        let base = name_hash(&key, None, &nonce);
        assert_eq!(base, name_hash(&key, None, &nonce));
        assert_ne!(base, name_hash(&[8u8; 32], None, &nonce));
        assert_ne!(base, name_hash(&key, None, &[2u8; 16]));
        assert_ne!(base, name_hash(&key, Some("ci"), &nonce));
        assert_ne!(
            name_hash(&key, Some("ci"), &nonce),
            name_hash(&key, Some("ci2"), &nonce)
        );
    }

    #[test]
    fn the_name_is_hmac_sha256_over_label_newline_nonce() {
        // An independent computation of the same derivation, so the spec in docs/channel.md and
        // the code cannot drift apart silently.
        let key = [0x42u8; 32];
        let nonce = [0xa5u8; 16];
        let mut message = b"ev3-cockpit/channel/t1\n".to_vec();
        message.extend_from_slice(&nonce);
        let mut mac = Hmac::<Sha256>::new_from_slice(&key).expect("key");
        mac.update(&message);
        let expected: [u8; 32] = mac.finalize().into_bytes().into();
        assert_eq!(name_hash(&key, Some("t1"), &nonce), expected);
    }

    #[test]
    fn pipe_and_socket_names_have_the_recorded_shape() {
        let hash: [u8; 32] = std::array::from_fn(|i| i as u8);
        assert_eq!(pipe_path(&hash), r"\\.\pipe\ev3-cockpit-0001020304050607");
        assert_eq!(
            socket_path(Path::new("/run/user/1000/ev3-cockpit"), &hash),
            PathBuf::from("/run/user/1000/ev3-cockpit/daemon-0001020304.sock")
        );
    }

    #[test]
    fn the_record_is_exactly_the_cross_language_vector() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../../../../contract/vectors/channel.json"))
                .expect("vectors");
        let first = &vectors["channelRecord"][0];
        let path = first["path"].as_str().expect("path");
        let pid = first["pid"].as_u64().expect("pid") as u32;
        assert_eq!(
            record_text(path, pid),
            first["file"].as_str().expect("file")
        );
    }

    /// A fresh directory under the system temp directory, removed on drop.
    #[cfg(unix)]
    struct Scratch(PathBuf);

    #[cfg(unix)]
    impl Scratch {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "ev3-cockpitd-channel-{}-{}",
                std::process::id(),
                crate::hex(&crate::random_bytes::<6>())
            ));
            crate::fsutil::create_private_dir_all(&base).expect("scratch");
            Self(base)
        }
    }

    #[cfg(unix)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    #[test]
    fn daemons_creating_the_socket_directory_at_the_same_moment_all_succeed() {
        use std::os::unix::fs::MetadataExt;
        use std::sync::{Arc, Barrier};

        let scratch = Scratch::new();
        for round in 0..200 {
            let dir = Arc::new(scratch.0.join(format!("r{round}")).join("ev3-cockpit"));
            let barrier = Arc::new(Barrier::new(8));
            let starts: Vec<_> = (0..8)
                .map(|_| {
                    let dir = Arc::clone(&dir);
                    let barrier = Arc::clone(&barrier);
                    std::thread::spawn(move || {
                        barrier.wait();
                        unix::ensure_private_dir(&dir).map_err(|error| error.to_string())
                    })
                })
                .collect();
            for start in starts {
                let outcome = start.join().expect("thread");
                assert!(outcome.is_ok(), "round {round}: {outcome:?}");
            }
            let mode = std::fs::metadata(&*dir).expect("made").mode();
            assert_eq!(mode & 0o077, 0, "round {round}: mode {:o}", mode & 0o777);
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_socket_directory_others_can_reach_is_still_refused() {
        use std::os::unix::fs::PermissionsExt;

        let scratch = Scratch::new();
        let open = scratch.0.join("open");
        std::fs::create_dir(&open).expect("dir");
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        match unix::ensure_private_dir(&open) {
            Err(BindError::Refused(message)) => {
                assert!(message.contains("other users"), "{message}")
            }
            other => panic!("refused expected, got {other:?}"),
        }
        let file = scratch.0.join("file");
        std::fs::write(&file, b"").expect("file");
        match unix::ensure_private_dir(&file) {
            Err(BindError::Refused(message)) => {
                assert!(message.contains("not a plain directory"), "{message}")
            }
            other => panic!("refused expected, got {other:?}"),
        }
        let private = scratch.0.join("private");
        unix::ensure_private_dir(&private).expect("made");
        unix::ensure_private_dir(&private).expect("an existing private directory is accepted");
    }
}
