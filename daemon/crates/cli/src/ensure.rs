//! Which daemon a client works with. The daemon judges an exit request itself; the client decides
//! when to ask.
//!
//! - No daemon: the client starts its own verified copy.
//! - A daemon runs: the hello says its version, contract version and build kind.
//!   - A development client meeting a release daemon asks it to exit and starts its own.
//!   - A release client newer than a release daemon asks it to exit, then starts its own.
//!   - A release client meeting a development daemon uses it and says one runs.
//!   - Otherwise the client uses it. One on another contract version stops the client.
//! - Only `ev3` itself (kind `cli`) ever asks a daemon to exit; `ev3 mcp` asks nothing.
//! - An exit request may take up to two minutes to answer; once accepted the daemon is ending, so
//!   the client waits for its channel to go before it starts its own.

use std::time::{Duration, Instant};

use ev3_channel::paths::Paths;
use ev3_channel::version::compare_versions;
use ev3_contract::CONTRACT_VERSION;
use serde_json::{Value, json};

use crate::connect::{Connected, DaemonIdentity, Identity, connect, open_channel};
use crate::endpoint::{Endpoint, RequestHandler};
use crate::error::{CliError, DAEMON_UNAVAILABLE, Failure, Result};
use crate::launch::{self, LaunchSpec};

/// How long starting a daemon, or waiting for one to end, may take.
pub const READINESS: Duration = Duration::from_secs(15);
/// How long the client waits for the answer to an exit request: a person's 60 s, then a write's.
pub const EXIT_ANSWER: Duration = Duration::from_secs(130);
/// How many times the client meets a daemon and decides again before it gives up.
const MAX_ROUNDS: u32 = 5;
/// How long without a channel after a lock-held exit before the client starts its copy again.
const RESPAWN_AFTER: Duration = Duration::from_secs(1);

/// Who is connecting, and with what.
pub struct Options<'a> {
    pub identity: Identity,
    /// The daemon this client carries; `None` for one that can start nothing.
    pub daemon: Option<LaunchSpec>,
    /// The channel's files; a test channel's name goes to a daemon this client starts.
    pub paths: &'a Paths,
    /// This client may ask a daemon to exit (only `ev3` itself).
    pub may_replace: bool,
    pub on_request: Option<RequestHandler>,
    /// Told what the user should know: a development daemon runs, an exit request was refused.
    pub notice: &'a (dyn Fn(&str) + Sync),
}

/// What the client does about a daemon it met.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    Use(Option<String>),
    Replace,
    Stop(String),
}

fn speaks_our_contract(daemon: &DaemonIdentity) -> bool {
    daemon.contract_version == u64::from(CONTRACT_VERSION)
}

/// A daemon not reachable yet (no answer on its channel so far), as opposed to one that cannot be
/// started at all.
fn not_reachable_yet(error: &CliError) -> bool {
    error.code() == Some(DAEMON_UNAVAILABLE) && !matches!(error, CliError::Start { .. })
}

fn describe(daemon: &DaemonIdentity) -> String {
    if daemon.build_kind == "development" {
        format!(
            "A development build of the EVƎ Cockpit daemon (version {})",
            daemon.version
        )
    } else {
        format!("The EVƎ Cockpit daemon {}", daemon.version)
    }
}

fn contract_stop(daemon: &DaemonIdentity, why: &str) -> String {
    let why = if why.is_empty() {
        String::new()
    } else {
        format!(" {why}")
    };
    format!(
        "{} runs and speaks contract {}; this client speaks contract {CONTRACT_VERSION}, so it cannot use it.{why} Update the older of the two.",
        describe(daemon),
        daemon.contract_version
    )
}

pub fn decide(
    build_kind: &str,
    version: &str,
    can_replace: bool,
    daemon: &DaemonIdentity,
) -> Decision {
    if can_replace
        && daemon.build_kind == "release"
        && (build_kind == "development"
            || compare_versions(version, &daemon.version) == std::cmp::Ordering::Greater)
    {
        return Decision::Replace;
    }
    if !speaks_our_contract(daemon) {
        return Decision::Stop(contract_stop(daemon, ""));
    }
    if build_kind == "release" && daemon.build_kind == "development" {
        return Decision::Use(Some(format!(
            "{} runs; this client uses it.",
            describe(daemon)
        )));
    }
    Decision::Use(None)
}

/// Asks a daemon to exit and waits for its answer. A daemon that goes meanwhile counts as ending,
/// and so does one that cancelled the request.
pub async fn ask_to_exit(endpoint: &Endpoint, timeout: Duration) -> Value {
    match tokio::time::timeout(timeout, endpoint.request("daemon/exit", json!({}))).await {
        Err(_) => json!({
            "accepted": false,
            "reason": format!("The cockpit daemon did not answer the exit request within {} s.", timeout.as_secs()),
        }),
        Ok(Ok(answer)) => answer,
        Ok(Err(error)) => match error.code() {
            Some(DAEMON_UNAVAILABLE) | Some("cancelled") => json!({ "accepted": true }),
            _ => json!({ "accepted": false, "reason": error.message() }),
        },
    }
}

/// Connects to the daemon this client should work with, starting or replacing one as the rules
/// above say.
pub async fn ensure(options: &Options<'_>) -> Result<Connected> {
    let paths = options.paths;
    let args: Vec<String> = match &paths.channel {
        Some(channel) => vec![
            "--channel".into(),
            channel.clone(),
            "--state-root".into(),
            paths.root.display().to_string(),
        ],
        None => Vec::new(),
    };
    let find = |until: Instant| async move {
        loop {
            match connect(paths, &options.identity, options.on_request.clone()).await {
                Err(error) if not_reachable_yet(&error) && Instant::now() < until => {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                other => return other,
            }
        }
    };

    for _ in 0..MAX_ROUNDS {
        let mut started = false;
        let connection = match find(Instant::now() + READINESS).await? {
            Some(connection) => connection,
            None => {
                let Some(own) = &options.daemon else {
                    return Err(CliError::start(
                        Failure::MissingBinary,
                        "No cockpit daemon runs, and this client carries none to start.",
                    ));
                };
                let (connection, ours) = start(own, &args, options).await?;
                started = ours;
                connection
            }
        };
        if connection.daemon.state.as_deref() == Some("exiting") {
            connection.endpoint.close();
            wait_gone(paths).await?;
            continue;
        }
        let decision = if started && speaks_our_contract(&connection.daemon) {
            Decision::Use(None)
        } else {
            decide(
                &options.identity.build_kind,
                &options.identity.version,
                options.may_replace && options.daemon.is_some(),
                &connection.daemon,
            )
        };
        match decision {
            Decision::Use(notice) => {
                if let Some(text) = notice {
                    (options.notice)(&text);
                }
                return Ok(finish(connection, options, started));
            }
            Decision::Stop(reason) => {
                connection.endpoint.close();
                return Err(CliError::start(Failure::ContractMismatch, reason));
            }
            Decision::Replace => {
                let answer = ask_to_exit(&connection.endpoint, EXIT_ANSWER).await;
                if answer.get("accepted").and_then(Value::as_bool) == Some(true) {
                    connection.endpoint.close();
                    wait_gone(paths).await?;
                    continue;
                }
                let reason = answer
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("The cockpit daemon refused to exit.")
                    .to_owned();
                (options.notice)(&reason);
                if speaks_our_contract(&connection.daemon) {
                    return Ok(finish(connection, options, started));
                }
                connection.endpoint.close();
                return Err(CliError::start(
                    Failure::ContractMismatch,
                    contract_stop(&connection.daemon, &reason),
                ));
            }
        }
    }
    Err(CliError::start(
        Failure::Failed,
        "The cockpit daemon kept changing while this client connected; try again.",
    ))
}

/// The connection this client works with. A client that started the daemon removes the verified
/// copies no daemon needs any more: copies pile up only when a daemon is replaced, and a
/// replacement always ends in a start, so a command reaching a running daemon skips the walk.
fn finish(connection: Connected, options: &Options<'_>, started: bool) -> Connected {
    if started {
        let own = options.daemon.as_ref().map(|d| d.sha256.as_str());
        let keep: Vec<&str> = own
            .into_iter()
            .chain(Some(connection.daemon.build_id.as_str()))
            .collect();
        launch::remove_old_copies(&options.paths.root, &keep);
    }
    // The installed cockpit records its daemon for add-ons; a development build is not the
    // installed one.
    if let Some(own) = &options.daemon
        && own.build_kind == "release"
        && options.may_replace
    {
        launch::record_install(&options.paths.dir, own);
    }
    connection
}

/// Waits until no daemon holds the channel.
async fn wait_gone(paths: &Paths) -> Result<()> {
    let until = Instant::now() + READINESS;
    while Instant::now() < until {
        // An error is a daemon ending: its pipe no longer answers.
        if let Ok(None) = open_channel(paths).await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err(CliError::start(
        Failure::LockHeld,
        format!(
            "The cockpit daemon was asked to exit but still held its channel after {} s.",
            READINESS.as_secs()
        ),
    ))
}

/// Why an elevated `ev3` starts no daemon, and what to do instead.
pub fn elevated_message() -> &'static str {
    if cfg!(windows) {
        "ev3 runs as administrator (elevated), and the cockpit daemon never runs with administrator rights: it would give every program of yours that reaches it those rights. Run ev3 from a terminal opened without \"Run as administrator\". Over SSH, an administrator's session is always elevated: use a standard account there."
    } else {
        "ev3 runs as root, and the cockpit daemon never runs as root. Run ev3 as yourself, without sudo."
    }
}

/// Starts this client's verified copy and connects to whichever daemon then serves the channel.
async fn start(
    launch: &LaunchSpec,
    args: &[String],
    options: &Options<'_>,
) -> Result<(Connected, bool)> {
    let paths = options.paths;
    // A daemon this process starts would run elevated too, and refuse.
    if ev3_channel::security::is_elevated().unwrap_or(false) {
        return Err(CliError::start(Failure::NameHeld, elevated_message()));
    }
    let until = Instant::now() + READINESS;
    let log = paths.log.clone();
    let mut binary = launch::verified_copy(launch, &paths.root)?;
    let mut child = launch::spawn(&binary, args, &paths.root);
    let mut lock_held_since: Option<Instant> = None;
    let mut delay = Duration::from_millis(50);
    loop {
        if let Some(ended) = child.outcome() {
            let failure = launch::classify(&ended, &binary, &log);
            if !matches!(
                failure,
                CliError::Start {
                    failure: Failure::LockHeld,
                    ..
                }
            ) {
                return Err(failure);
            }
            let since = *lock_held_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= RESPAWN_AFTER && Instant::now() < until {
                binary = launch::verified_copy(launch, &paths.root)?;
                child = launch::spawn(&binary, args, &paths.root);
                lock_held_since = None;
            } else if Instant::now() >= until {
                return Err(CliError::start(
                    Failure::LockHeld,
                    format!(
                        "Another cockpit daemon held this channel's lock and did not become reachable within {} s; try again.",
                        READINESS.as_secs()
                    ),
                ));
            }
        }
        match connect(paths, &options.identity, options.on_request.clone()).await {
            Ok(Some(connection)) => {
                let ours = child.pid().map(u64::from) == Some(u64::from(connection.record.pid));
                return Ok((connection, ours));
            }
            Ok(None) => {}
            Err(error) if not_reachable_yet(&error) => {}
            Err(error) => return Err(error),
        }
        if Instant::now() >= until {
            return Err(CliError::start(
                Failure::Failed,
                format!(
                    "The cockpit daemon did not answer within {} s.",
                    READINESS.as_secs()
                ),
            ));
        }
        tokio::time::sleep(delay).await;
        // Each look is one small file read: looking often costs less than a daemon left waiting.
        delay = (delay * 2).min(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn daemon(version: &str, build_kind: &str, contract: u64) -> DaemonIdentity {
        DaemonIdentity {
            version: version.into(),
            contract_version: contract,
            build_kind: build_kind.into(),
            build_id: String::new(),
            pid: 1,
            state: None,
        }
    }

    #[test]
    fn the_launch_decisions_follow_the_rules() {
        let c = u64::from(CONTRACT_VERSION);
        assert_eq!(
            decide("development", "1.0.0", true, &daemon("9.0.0", "release", c)),
            Decision::Replace
        );
        assert_eq!(
            decide("release", "1.0.1", true, &daemon("1.0.0", "release", c)),
            Decision::Replace
        );
        assert_eq!(
            decide("release", "1.0.0", true, &daemon("1.0.0", "release", c)),
            Decision::Use(None)
        );
        assert!(matches!(
            decide("release", "1.0.0", true, &daemon("1.0.0", "development", c)),
            Decision::Use(Some(_))
        ));
        assert!(matches!(
            decide(
                "development",
                "1.0.0",
                false,
                &daemon("1.0.0", "release", c + 1)
            ),
            Decision::Stop(_)
        ));
        // A newer release on another contract is replaced, not refused.
        assert_eq!(
            decide("release", "2.0.0", true, &daemon("1.0.0", "release", c + 1)),
            Decision::Replace
        );
        // A client that may not replace never does.
        assert_eq!(
            decide(
                "development",
                "1.0.0",
                false,
                &daemon("1.0.0", "release", c)
            ),
            Decision::Use(None)
        );
    }
}
