//! When the daemon ends because a client asked, and what it serves to a client on another contract
//! version.
//!
//! The daemon judges `daemon/exit` from the asking client's hello, never from anything the request
//! carries:
//!
//! - A release daemon is **replaced** by a release client whose version is newer, and by any
//!   development client, whatever the versions: a work-in-progress build may carry a lower version
//!   than the installed release. Installing a release or building a development build is the
//!   person's own act, so nobody is asked. Only the clients that carry the cockpit's daemon (VS
//!   Code and the `ev3` command) replace it; an add-on's request is a restart.
//! - A development daemon stays, whichever build asks: a release client never replaces it, and
//!   switching to another development build is an explicit restart.
//! - Every other request is a **restart**, which runs only after a person said yes in a VS Code
//!   window or a terminal; the question names the client that asked. Silence for 60 s refuses it.
//! - An MCP client may not ask at all: the method table does not let it send `daemon/exit`, and a
//!   client kind the daemon does not know reads as one.
//!
//! Either way the daemon ends only once no write is in progress (a leased operation, a pairing, or
//! a write the runtime reports), waiting at most [`WRITE_WAIT`]. A wait that runs out keeps the
//! daemon running and says why in the answer. Once it ends, the next daemon connects the bricks
//! held with `ev3 connect` again from `held.json`.
//!
//! The contract version rises only on a breaking change. A client whose hello names another
//! contract version still finishes the hello and reads the daemon's version from it, but of the
//! methods only the stable core (`daemon/exit`) is served to it: the rest is refused naming both
//! versions, so neither side acts on messages it would read wrong.

use std::cmp::Ordering;
use std::sync::Arc;
use std::time::Duration;

use ev3_contract::{BuildKind, CONTRACT_VERSION, ClientInfo, ClientKind, ContractError, ErrorCode};
use ev3_runtime::Requester;
use tokio::time::Instant;

use crate::questions::{Asked, Questions, Topic};
use crate::state::ClientEntry;

/// How long an exit waits for the write in progress before it gives up.
pub const WRITE_WAIT: Duration = Duration::from_secs(60);
/// How often the wait looks again.
const WRITE_CHECK: Duration = Duration::from_millis(100);

pub use ev3_channel::version::compare_versions;

/// What an exit request is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitKind {
    /// The asking client's build replaces this daemon: it ends once no write is in progress,
    /// without asking anyone.
    Replacement,
    /// Any other request: the daemon ends only after a person said yes.
    Restart,
}

/// Judges an exit request from the daemon's build kind and version and the asking client, as its
/// hello named it.
///
/// Only a client that carries the cockpit's own daemon can replace one: the VS Code extension and
/// the `ev3` command (`vscode`, `cli`). An add-on's version and build kind are the add-on's, and it
/// starts the installed daemon, not one of its own, so its request is a restart.
pub fn judge(daemon_kind: BuildKind, daemon_version: &str, client: &ClientInfo) -> ExitKind {
    if !matches!(client.kind, ClientKind::Vscode | ClientKind::Cli) {
        return ExitKind::Restart;
    }
    match (daemon_kind, client.build_kind) {
        (BuildKind::Release, BuildKind::Development) => ExitKind::Replacement,
        (BuildKind::Release, BuildKind::Release)
            if compare_versions(&client.version, daemon_version) == Ordering::Greater =>
        {
            ExitKind::Replacement
        }
        _ => ExitKind::Restart,
    }
}

/// The restart question's text.
pub fn restart_text(requester: &str) -> String {
    format!(
        "Restart the EVƎ Cockpit daemon? {requester} asked. It ends once no write to a brick is in \
         progress; bricks held with ev3 connect are connected again."
    )
}

/// Asks a person whether the daemon may restart for `requester`; `Err` with the reason, ready to
/// show, unless the person said yes.
pub async fn ask_restart(
    questions: &Questions,
    clients: &[Arc<ClientEntry>],
    requester: &Requester,
) -> Result<(), String> {
    let asked = questions
        .ask(
            clients,
            requester,
            Topic::Restart,
            restart_text(&requester.name),
        )
        .await;
    match asked {
        Asked::Yes => Ok(()),
        Asked::No => Err("The daemon keeps running: the restart was declined.".into()),
        Asked::Unanswered => Err(format!(
            "The daemon keeps running: nobody answered the restart question within {} s.",
            questions.timeout().as_secs()
        )),
        Asked::NoPerson => Err(
            "The daemon keeps running: a restart needs a person to say yes in VS Code or a \
             terminal, and none is connected. Run `ev3 daemon restart` in a terminal."
                .into(),
        ),
    }
}

/// Waits until no write is in progress and `close` shut the door on new ones, at most `limit`.
///
/// `in_progress` names the write in progress, if any; `close` refuses later writes when none has
/// started meanwhile and says whether it did; `waiting` hears once what the exit waits for. `Err`
/// carries the reason, ready to show, when the wait ran out.
pub async fn wait_for_no_write(
    in_progress: impl Fn() -> Option<String>,
    close: impl Fn() -> bool,
    limit: Duration,
    waiting: impl FnOnce(&str),
) -> Result<(), String> {
    let deadline = Instant::now() + limit;
    let mut waiting = Some(waiting);
    let mut last = None;
    loop {
        match in_progress() {
            None if close() => return Ok(()),
            None => {}
            Some(what) => {
                if let Some(tell) = waiting.take() {
                    tell(&what);
                }
                last = Some(what);
            }
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "The daemon keeps running: {} was still in progress after {} s. Ask again once it \
                 has finished.",
                last.as_deref().unwrap_or("a write to a brick"),
                limit.as_secs()
            ));
        }
        tokio::time::sleep(WRITE_CHECK).await;
    }
}

/// What the daemon logs about a client on another contract version, or `None` on the same one.
pub fn contract_mismatch(client_contract: u64) -> Option<String> {
    (client_contract != u64::from(CONTRACT_VERSION)).then(|| {
        format!(
            "This client speaks contract {client_contract} and the daemon contract \
             {CONTRACT_VERSION}: across contract versions only the hello and daemon/exit are served."
        )
    })
}

/// The refusal of `method` for a client on contract `client_contract`, or `None` when it is
/// served: always on the same contract version, and the stable core on any.
pub fn contract_refusal(client_contract: u64, method: &str) -> Option<ContractError> {
    let mismatch = contract_mismatch(client_contract)?;
    if ev3_contract::method_info(method).is_some_and(|info| info.stable_core) {
        return None;
    }
    Some(ContractError::new(
        ErrorCode::InvalidRequest,
        format!("{mismatch} {method} is not served to it; update the client or the cockpit."),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use serde_json::{Value, json};
    use tokio::sync::mpsc::UnboundedReceiver;

    #[test]
    fn a_release_daemon_is_replaced_only_by_a_newer_release_client_or_a_development_one() {
        use BuildKind::{Development as Dev, Release as Rel};
        use ExitKind::{Replacement, Restart};
        let cases = [
            // A release daemon meeting release clients: only a newer one replaces it.
            (Rel, "0.2.5", Rel, "0.2.6", Replacement),
            (Rel, "0.2.5", Rel, "0.2.5", Restart),
            (Rel, "0.2.5", Rel, "0.2.4", Restart),
            // A development client replaces a release daemon whatever the versions.
            (Rel, "0.2.5", Dev, "0.1.0", Replacement),
            (Rel, "0.2.5", Dev, "0.2.5", Replacement),
            (Rel, "0.2.5", Dev, "9.0.0", Replacement),
            // A development daemon stays, whichever build asks.
            (Dev, "0.2.5", Rel, "9.0.0", Restart),
            (Dev, "0.2.5", Rel, "0.2.5", Restart),
            (Dev, "0.2.5", Dev, "9.0.0", Restart),
            (Dev, "0.2.5", Dev, "0.1.0", Restart),
        ];
        let asking = |kind: ClientKind, build_kind: BuildKind, version: &str| ClientInfo {
            name: "a client".into(),
            kind,
            version: version.into(),
            build_kind,
        };
        for (daemon, daemon_version, client, client_version, expected) in cases {
            for kind in [ClientKind::Vscode, ClientKind::Cli] {
                assert_eq!(
                    judge(
                        daemon,
                        daemon_version,
                        &asking(kind, client, client_version)
                    ),
                    expected,
                    "{daemon} {daemon_version} asked by {kind} {client} {client_version}"
                );
            }
            // An add-on carries no daemon of its own: whatever its build, it never replaces one.
            assert_eq!(
                judge(
                    daemon,
                    daemon_version,
                    &asking(ClientKind::Addon, client, client_version)
                ),
                Restart,
                "{daemon} {daemon_version} asked by an add-on {client} {client_version}"
            );
        }
        // A build kind the daemon does not know reads as release, so it never replaces as a
        // development build would.
        let unknown = BuildKind::read_open("nightly");
        assert_eq!(
            judge(Rel, "0.2.5", &asking(ClientKind::Cli, unknown, "0.2.5")),
            Restart
        );
    }

    #[tokio::test(start_paused = true)]
    async fn the_exit_waits_for_the_write_in_progress_and_then_closes_the_door() {
        let writing = Arc::new(Mutex::new(Some("VS Code's write to AAA".to_owned())));
        let closed = Arc::new(Mutex::new(false));
        let told = Arc::new(Mutex::new(Vec::new()));
        let wait = tokio::spawn({
            let (writing, closed, told) = (writing.clone(), closed.clone(), told.clone());
            async move {
                wait_for_no_write(
                    || writing.lock().unwrap().clone(),
                    || {
                        *closed.lock().unwrap() = true;
                        true
                    },
                    WRITE_WAIT,
                    |what| told.lock().unwrap().push(what.to_owned()),
                )
                .await
            }
        });
        tokio::time::sleep(Duration::from_secs(30)).await;
        assert!(!wait.is_finished(), "still waiting while the write runs");
        assert!(!*closed.lock().unwrap(), "new writes are still let in");
        *writing.lock().unwrap() = None;
        assert_eq!(wait.await.unwrap(), Ok(()));
        assert!(*closed.lock().unwrap());
        assert_eq!(*told.lock().unwrap(), ["VS Code's write to AAA"]);
    }

    #[tokio::test(start_paused = true)]
    async fn an_exit_waiting_longer_than_60_s_gives_up_and_says_why() {
        let started = Instant::now();
        let outcome = wait_for_no_write(
            || Some("ev3's write to AAA".to_owned()),
            || unreachable!("never closed while a write runs"),
            WRITE_WAIT,
            |_| {},
        )
        .await;
        let reason = outcome.expect_err("gave up");
        assert!(started.elapsed() >= WRITE_WAIT);
        assert!(started.elapsed() < WRITE_WAIT + Duration::from_secs(1));
        assert!(reason.contains("ev3's write to AAA"), "{reason}");
        assert!(reason.contains("60 s"), "{reason}");
    }

    #[tokio::test(start_paused = true)]
    async fn a_write_starting_as_the_door_closes_keeps_the_exit_waiting() {
        let tries = Arc::new(Mutex::new(0));
        let outcome = wait_for_no_write(
            || None,
            || {
                let mut tries = tries.lock().unwrap();
                *tries += 1;
                *tries > 2
            },
            WRITE_WAIT,
            |_| {},
        )
        .await;
        assert_eq!(outcome, Ok(()));
        assert_eq!(*tries.lock().unwrap(), 3);
    }

    struct Fake {
        entry: Arc<ClientEntry>,
        out: UnboundedReceiver<Value>,
    }

    fn client(id: u64, name: &str, kind: ClientKind) -> Fake {
        let (peer, out, _closed) = crate::rpc::detached_peer();
        Fake {
            entry: Arc::new(ClientEntry {
                id,
                info: ClientInfo {
                    name: name.into(),
                    kind,
                    version: "0.0.1".into(),
                    build_kind: BuildKind::Development,
                },
                contract_version: u64::from(CONTRACT_VERSION),
                peer,
            }),
            out,
        }
    }

    fn requester(fake: &Fake) -> Requester {
        Requester {
            name: fake.entry.info.name.clone(),
            kind: fake.entry.kind(),
            connection: Some(fake.entry.id),
        }
    }

    async fn restart_question(fake: &mut Fake) -> Value {
        let sent = fake.out.recv().await.expect("asked");
        assert_eq!(sent["method"], "question/ask");
        assert_eq!(sent["params"]["kind"], "restart");
        sent
    }

    #[tokio::test(start_paused = true)]
    async fn a_restart_goes_ahead_only_on_a_persons_yes_and_names_the_asking_client() {
        let questions = Arc::new(Questions::default());
        let mut vscode = client(1, "VS Code", ClientKind::Vscode);
        let addon = client(2, "an add-on", ClientKind::Addon);
        let clients = vec![vscode.entry.clone(), addon.entry.clone()];

        for (reply, expected) in [
            (json!({"answer": "yes"}), None),
            (json!({"answer": "no"}), Some("declined")),
            (json!({"answer": "keep"}), Some("nobody answered")),
        ] {
            let asking = tokio::spawn({
                let (questions, clients, who) =
                    (questions.clone(), clients.clone(), requester(&addon));
                async move { ask_restart(&questions, &clients, &who).await }
            });
            let sent = restart_question(&mut vscode).await;
            assert_eq!(sent["params"]["requester"]["name"], "an add-on");
            assert_eq!(sent["params"]["requester"]["kind"], "addon");
            assert!(
                sent["params"]["text"]
                    .as_str()
                    .unwrap()
                    .contains("an add-on asked"),
                "{sent}"
            );
            vscode.entry.peer.answer(&sent["id"], reply);
            match (asking.await.unwrap(), expected) {
                (Ok(()), None) => {}
                (Err(reason), Some(part)) => assert!(reason.contains(part), "{reason}"),
                (other, _) => panic!("{other:?} for {expected:?}"),
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_restart_nobody_answers_within_60_s_is_refused() {
        let questions = Arc::new(Questions::default());
        let mut cli = client(1, "ev3 (terminal)", ClientKind::Cli);
        let clients = vec![cli.entry.clone()];
        let who = requester(&cli);
        let asking = tokio::spawn({
            let questions = questions.clone();
            async move { ask_restart(&questions, &clients, &who).await }
        });
        restart_question(&mut cli).await;
        tokio::time::sleep(Duration::from_secs(59)).await;
        assert!(!asking.is_finished(), "still asking after 59 s");
        tokio::time::sleep(Duration::from_secs(2)).await;
        let reason = asking.await.unwrap().expect_err("refused");
        assert!(reason.contains("within 60 s"), "{reason}");
    }

    #[tokio::test]
    async fn a_restart_with_nobody_to_ask_is_refused_naming_the_command() {
        let questions = Questions::default();
        let mut addon = client(1, "an add-on", ClientKind::Addon);
        let reason = ask_restart(
            &questions,
            std::slice::from_ref(&addon.entry),
            &requester(&addon),
        )
        .await
        .expect_err("refused");
        assert!(reason.contains("ev3 daemon restart"), "{reason}");
        assert!(addon.out.try_recv().is_err(), "the add-on was not asked");
    }

    #[test]
    fn a_client_on_another_contract_is_served_only_the_stable_core() {
        let same = u64::from(CONTRACT_VERSION);
        let other = same + 1;
        assert!(contract_mismatch(same).is_none());
        assert!(contract_refusal(same, "bricks/list").is_none());
        assert!(contract_refusal(other, "daemon/exit").is_none());
        for method in ["daemon/status", "bricks/list", "files/write", "no/such"] {
            let refusal = contract_refusal(other, method).expect("refused");
            assert_eq!(refusal.data.code, ErrorCode::InvalidRequest);
            assert!(
                refusal.message.contains(&format!("contract {other}")),
                "{}",
                refusal.message
            );
            assert!(
                refusal.message.contains(&format!("contract {same}")),
                "{}",
                refusal.message
            );
        }
        assert!(contract_refusal(same - 1, "daemon/status").is_some());
    }
}
