//! Finding the daemon and proving both sides hold the user's key (`docs/channel.md`).
//!
//! Only the daemon holding the channel's lock writes `channel.json`, so a client connects only to
//! the path recorded there and never computes a name itself. A record whose daemon no longer holds
//! the lock is deleted, if unchanged, and never contacted.

use std::path::Path;
use std::time::Duration;

use ev3_channel::key::read_key;
use ev3_channel::paths::Paths;
use ev3_channel::record::{ChannelRecord, parse_record};
use ev3_contract::hello::{client_proof, daemon_proof};
use ev3_contract::{CONTRACT_VERSION, HELLO_FINISH, HELLO_START};
use serde_json::{Value, json};

use crate::endpoint::{Duplex, Endpoint, RequestHandler};
use crate::error::{CliError, Result};

/// How long finding, opening and the hello may take.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Who this client is in the hello.
#[derive(Debug, Clone)]
pub struct Identity {
    /// Where it runs, as people read it in the daemon's log and messages.
    pub name: String,
    /// `cli`, `mcp`, ...
    pub kind: String,
    pub version: String,
    /// `release` or `development`.
    pub build_kind: String,
}

/// Who the daemon is, once it proved it holds the key.
#[derive(Debug, Clone)]
pub struct DaemonIdentity {
    pub version: String,
    pub contract_version: u64,
    pub build_kind: String,
    /// SHA-256 of the daemon's executable.
    pub build_id: String,
    pub pid: u64,
    /// `exiting` once the daemon is about to end.
    pub state: Option<String>,
}

/// A connection that finished the hello.
pub struct Connected {
    pub endpoint: Endpoint,
    pub daemon: DaemonIdentity,
    pub record: ChannelRecord,
}

fn read_text(file: &Path) -> Result<Option<String>> {
    match std::fs::read_to_string(file) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CliError::unavailable(format!(
            "The cockpit daemon's channel record {} cannot be read ({error}).",
            file.display()
        ))),
    }
}

/// Deletes a stale record unless it changed since it was judged stale.
fn delete_stale(file: &Path, judged: &str) {
    if read_text(file).ok().flatten().as_deref() == Some(judged) {
        let _ = std::fs::remove_file(file);
    }
}

/// Opens the daemon's pipe or socket, or `None` when no daemon runs.
pub async fn open_channel(paths: &Paths) -> Result<Option<(Box<dyn Duplex>, ChannelRecord)>> {
    let Some(text) = read_text(&paths.record)? else {
        return Ok(None);
    };
    let record = parse_record(&text);
    platform::open(paths, &text, record).await
}

#[cfg(windows)]
mod platform {
    use super::*;
    use tokio::net::windows::named_pipe::ClientOptions;

    const ERROR_SHARING_VIOLATION: i32 = 32;
    const ERROR_PIPE_BUSY: i32 = 231;

    pub async fn open(
        paths: &Paths,
        text: &str,
        record: Option<ChannelRecord>,
    ) -> Result<Option<(Box<dyn Duplex>, ChannelRecord)>> {
        // The daemon keeps the lock file open with no sharing: a client that can open it for
        // writing knows no daemon holds it, and deletes the record while it still has it open.
        match std::fs::OpenOptions::new().write(true).open(&paths.lock) {
            Ok(file) => {
                delete_stale(&paths.record, text);
                drop(file);
                return Ok(None);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                delete_stale(&paths.record, text);
                return Ok(None);
            }
            Err(error)
                if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION)
                    || error.kind() == std::io::ErrorKind::PermissionDenied => {}
            Err(error) => {
                return Err(CliError::unavailable(format!(
                    "The cockpit daemon's lock {} cannot be checked ({error}).",
                    paths.lock.display()
                )));
            }
        }
        let Some(record) = record else {
            return Err(CliError::unavailable(format!(
                "A cockpit daemon runs, but its channel record {} cannot be read.",
                paths.record.display()
            )));
        };
        let mut attempts = 0;
        loop {
            match ClientOptions::new().open(&record.path) {
                Ok(pipe) => return Ok(Some((Box::new(pipe), record))),
                Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) && attempts < 40 => {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                Err(error) => {
                    return Err(CliError::unavailable(format!(
                        "The cockpit daemon (pid {}) runs but is not answering on {} ({error}).",
                        record.pid, record.path
                    )));
                }
            }
        }
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    fn process_alive(pid: u32) -> bool {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        // SAFETY: signal 0 only checks that the process exists.
        if unsafe { libc::kill(pid, 0) } == 0 {
            return true;
        }
        // EPERM: the process exists, it is just not ours to signal.
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    /// Refuses a socket directory anyone but the user could have put a socket in.
    fn check_socket_dir(socket: &str) -> Result<()> {
        let dir = Path::new(socket).parent().unwrap_or(Path::new("/"));
        let refuse = |why: String| {
            Err(CliError::unavailable(format!(
                "The cockpit daemon's socket directory {} {why}; the client did not connect.",
                dir.display()
            )))
        };
        let meta = match std::fs::symlink_metadata(dir) {
            Ok(meta) => meta,
            Err(error) => return refuse(format!("cannot be checked ({error})")),
        };
        if !meta.is_dir() {
            return refuse("is not a plain directory".into());
        }
        // SAFETY: geteuid has no preconditions.
        if meta.uid() != unsafe { libc::geteuid() } {
            return refuse("belongs to another user".into());
        }
        if meta.mode() & 0o077 != 0 {
            return refuse(format!(
                "can be opened by other users (mode {:o})",
                meta.mode() & 0o777
            ));
        }
        Ok(())
    }

    pub async fn open(
        paths: &Paths,
        text: &str,
        record: Option<ChannelRecord>,
    ) -> Result<Option<(Box<dyn Duplex>, ChannelRecord)>> {
        let Some(record) = record.filter(|r| process_alive(r.pid)) else {
            delete_stale(&paths.record, text);
            return Ok(None);
        };
        check_socket_dir(&record.path)?;
        match tokio::net::UnixStream::connect(&record.path).await {
            Ok(stream) => Ok(Some((Box::new(stream), record))),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                ) =>
            {
                delete_stale(&paths.record, text);
                Ok(None)
            }
            Err(error) => Err(CliError::unavailable(format!(
                "The cockpit daemon (pid {}) is not answering on {} ({error}).",
                record.pid, record.path
            ))),
        }
    }
}

/// A fresh nonce: 16 random bytes as 32 hex digits.
fn nonce() -> String {
    ev3_channel::hex(&ev3_channel::random_bytes::<16>())
}

/// Equal in constant time, for proofs.
fn proofs_match(expected: &str, given: Option<&str>) -> bool {
    let Some(given) = given else { return false };
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The hello: the daemon's proof is checked before anything it says is trusted and before this
/// client proves itself.
pub async fn hello(endpoint: &Endpoint, key: &[u8], client: &Identity) -> Result<DaemonIdentity> {
    let client_nonce = nonce();
    let challenge = endpoint
        .request(
            HELLO_START,
            json!({
                "clientNonce": client_nonce, "clientName": client.name, "clientKind": client.kind,
                "version": client.version, "contractVersion": CONTRACT_VERSION,
                "buildKind": client.build_kind,
            }),
        )
        .await?;
    let daemon_nonce = challenge
        .get("daemonNonce")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let expected = daemon_proof(key, &client_nonce, &daemon_nonce);
    if daemon_nonce.is_empty()
        || !proofs_match(
            &expected,
            challenge.get("daemonProof").and_then(Value::as_str),
        )
    {
        endpoint.close();
        return Err(CliError::unavailable(
            "The process on the cockpit channel could not prove it is your cockpit daemon; nothing was sent to it.",
        ));
    }
    let accepted = endpoint
        .request(
            HELLO_FINISH,
            json!({ "clientProof": client_proof(key, &client_nonce, &daemon_nonce) }),
        )
        .await?;
    let (Some(version), Some(contract_version)) = (
        accepted.get("version").and_then(Value::as_str),
        accepted.get("contractVersion").and_then(Value::as_u64),
    ) else {
        endpoint.close();
        return Err(CliError::unavailable(
            "The cockpit daemon did not say which version it is; the connection was closed.",
        ));
    };
    let text = |key: &str| accepted.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(DaemonIdentity {
        version: version.to_owned(),
        contract_version,
        build_kind: match text("buildKind").as_deref() {
            Some("development") => "development".into(),
            _ => "release".into(),
        },
        build_id: text("buildId").unwrap_or_default(),
        pid: accepted.get("pid").and_then(Value::as_u64).unwrap_or(0),
        state: text("state"),
    })
}

/// Finds the daemon, opens its channel and finishes the hello, or `None` when none runs. A
/// daemon on another contract version is returned too: the launch decides about it.
pub async fn connect(
    paths: &Paths,
    client: &Identity,
    on_request: Option<RequestHandler>,
) -> Result<Option<Connected>> {
    let attempt = async {
        let Some((stream, record)) = open_channel(paths).await? else {
            return Ok(None);
        };
        let key = read_key(&paths.key).map_err(|error| CliError::unavailable(error.0))?;
        let endpoint = Endpoint::new(stream, on_request);
        match hello(&endpoint, &key, client).await {
            Ok(daemon) => Ok(Some(Connected {
                endpoint,
                daemon,
                record,
            })),
            Err(error) => {
                endpoint.close();
                Err(error)
            }
        }
    };
    match tokio::time::timeout(CONNECT_TIMEOUT, attempt).await {
        Ok(result) => result,
        Err(_) => Err(CliError::unavailable(format!(
            "The cockpit daemon did not finish the hello within {} ms; the connection was closed.",
            CONNECT_TIMEOUT.as_millis()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proofs_compare_whole() {
        assert!(proofs_match("abcd", Some("abcd")));
        assert!(!proofs_match("abcd", Some("abce")));
        assert!(!proofs_match("abcd", Some("abc")));
        assert!(!proofs_match("abcd", None));
    }

    #[test]
    fn a_nonce_has_32_lowercase_hex_digits() {
        let n = nonce();
        assert_eq!(n.len(), 32);
        assert!(
            n.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
    }
}
