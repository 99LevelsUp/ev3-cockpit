//! What the Bluetooth provider needs from the runtime above it, as two small ports the runtime
//! adapts to: somewhere to say what happened ([`Activity`]) and a person to ask ([`Consent`]).
//!
//! And the one question it asks. Some distributions' D-Bus policy limits BlueZ to the
//! `bluetooth` group. The cockpit offers to add the user to it and, on a yes, runs it itself,
//! through `pkexec`, so polkit shows its own system dialog and no password passes through the
//! cockpit. The user comes from the operating system, never from input; the argv is fixed and
//! there is no shell. Where `pkexec` or a polkit agent is missing (headless, SSH, a remote
//! session) the cockpit hands back the command to copy. Nothing runs without a yes.
//!
//! Once asked and answered, a later refusal is not asked about again: BlueZ refuses at every
//! retry until the person logs in again, and each refusal would otherwise reopen the question.
//! Debian 13 and Raspberry Pi OS need none of this: their policy lets a desktop user talk to
//! BlueZ.

use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;

/// Where the provider says what happened: things a person may want to read in the log, such as
/// a radio restarted or BlueZ refusing this user. The runtime adapts its log to it.
pub trait Activity: Send + Sync {
    fn info(&self, message: &str);
    fn warn(&self, message: &str);
}

/// An [`Activity`] that drops everything.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoActivity;

impl Activity for NoActivity {
    fn info(&self, _message: &str) {}
    fn warn(&self, _message: &str) {}
}

/// Which question is asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum QuestionKind {
    /// May the cockpit add this user to the `bluetooth` group?
    BluetoothAccess,
    /// The user was added; check Bluetooth again now?
    BluetoothCheckAgain,
}

/// A question for the person behind a VS Code window or a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub kind: QuestionKind,
    pub text: String,
    /// Shown with the question: the exact command, for the group question.
    pub details: Vec<String>,
}

/// What the person answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    Yes,
    No,
    /// Nobody could be asked, or the question was dismissed: leave things as they are.
    Keep,
}

/// A person to ask. The runtime adapts its question channel to it.
#[async_trait]
pub trait Consent: Send + Sync {
    /// Whether anybody is connected to ask. With nobody, a refusal is only logged; a later
    /// refusal asks once somebody is there.
    fn can_ask(&self) -> bool;
    /// Asks and waits for the answer.
    async fn ask(&self, question: Question) -> Answer;
}

/// The group BlueZ is limited to on the distributions that limit it.
pub const BLUETOOTH_GROUP: &str = "bluetooth";

/// What the user can run themselves.
pub fn manual_group_command(user: &str) -> String {
    format!("sudo usermod -aG {BLUETOOTH_GROUP} {user}")
}

/// A plain account name, what `useradd` accepts by default: a letter or `_`, then up to 30
/// letters, digits, `_`, `.` or `-`, and an optional trailing `$`. Anything else is never run.
pub fn is_plain_account_name(user: &str) -> bool {
    let name = user.strip_suffix('$').unwrap_or(user);
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && name.len() <= 31
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// This process's user name, from the password database.
pub fn current_user_name() -> Option<String> {
    // SAFETY: getuid has no failure mode.
    let uid = unsafe { libc::getuid() };
    let mut buffer = vec![0u8; 4096];
    // SAFETY: passwd is plain data, valid when zeroed; getpwuid_r fills it.
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: every pointer is to live, writable memory of the stated size.
    let code = unsafe {
        libc::getpwuid_r(
            uid,
            &raw mut entry,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &raw mut result,
        )
    };
    if code != 0 || result.is_null() || entry.pw_name.is_null() {
        return None;
    }
    // SAFETY: getpwuid_r succeeded, so pw_name is a NUL-terminated string inside `buffer`.
    let name = unsafe { std::ffi::CStr::from_ptr(entry.pw_name) };
    name.to_str().ok().map(str::to_owned)
}

/// How a run of the fix ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    /// It ran and exited with this code (`None` when a signal ended it).
    Exited(Option<i32>),
    /// The program is not installed.
    NotFound,
    /// It could not start for another reason.
    Failed(String),
}

/// Runs a program with a fixed argv and no shell. The seam the fix is tested through.
#[async_trait]
pub trait CommandRunner: Send + Sync {
    async fn run(&self, program: &str, args: &[String]) -> RunOutcome;
}

/// Runs programs on this host, with no shell and nothing on their standard streams.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemRunner;

#[async_trait]
impl CommandRunner for SystemRunner {
    async fn run(&self, program: &str, args: &[String]) -> RunOutcome {
        let program = program.to_owned();
        let args = args.to_vec();
        let run = tokio::task::spawn_blocking(move || {
            std::process::Command::new(&program)
                .args(&args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
        })
        .await;
        match run {
            Ok(Ok(status)) => RunOutcome::Exited(status.code()),
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => RunOutcome::NotFound,
            Ok(Err(error)) => RunOutcome::Failed(error.to_string()),
            Err(error) => RunOutcome::Failed(error.to_string()),
        }
    }
}

/// How the offer to join the group ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GroupFixResult {
    /// The user said no; nothing ran.
    Declined,
    /// Added; it applies to new logins.
    Added { message: String },
    /// The polkit dialog was dismissed or refused.
    Cancelled,
    /// It could not run here: the command to copy, and why.
    Manual { command: String, reason: String },
}

/// The text of the group question.
pub fn group_question(user: &str) -> Question {
    Question {
        kind: QuestionKind::BluetoothAccess,
        text: format!(
            "BlueZ refused this user. On many systems only members of the \"{BLUETOOTH_GROUP}\" \
             group may use it. Add {user} to it? Your system will ask for your password."
        ),
        details: vec![format!("pkexec usermod -aG {BLUETOOTH_GROUP} {user}")],
    }
}

/// Offers to add `user` to the `bluetooth` group and runs it on a yes.
///
/// `pkexec` exits 126 when the dialog is dismissed or authorisation refused, and 127 when it
/// cannot ask at all (no polkit agent); both, and a missing `pkexec`, are told apart from a real
/// failure.
pub async fn offer_bluetooth_group(
    user: &str,
    consent: &dyn Consent,
    runner: &dyn CommandRunner,
) -> GroupFixResult {
    if !is_plain_account_name(user) {
        return GroupFixResult::Manual {
            command: manual_group_command("<your user name>"),
            reason: "the account name is not one the cockpit will pass on".into(),
        };
    }
    if consent.ask(group_question(user)).await != Answer::Yes {
        return GroupFixResult::Declined;
    }
    let args: Vec<String> = ["usermod", "-aG", BLUETOOTH_GROUP, user]
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect();
    let manual = |reason: String| GroupFixResult::Manual {
        command: manual_group_command(user),
        reason,
    };
    match runner.run("pkexec", &args).await {
        RunOutcome::NotFound => manual("pkexec is not installed".into()),
        RunOutcome::Failed(reason) => manual(format!("pkexec could not start ({reason})")),
        RunOutcome::Exited(Some(0)) => GroupFixResult::Added {
            message: format!(
                "{user} is now in the \"{BLUETOOTH_GROUP}\" group. It applies to new logins: log \
                 out and in (or run \"newgrp {BLUETOOTH_GROUP}\" in a terminal), then check \
                 Bluetooth again."
            ),
        },
        RunOutcome::Exited(Some(126)) => GroupFixResult::Cancelled,
        RunOutcome::Exited(Some(127)) => manual(
            "no polkit agent could ask for the password (headless, SSH or a remote session)".into(),
        ),
        RunOutcome::Exited(Some(code)) => manual(format!("pkexec ended with exit {code}")),
        RunOutcome::Exited(None) => manual("pkexec was ended by a signal".into()),
    }
}

/// Starts Bluetooth over on a fresh bus, as after logging out and in.
#[async_trait]
pub trait CheckAgain: Send + Sync {
    async fn check_again(&self);
}

#[derive(Debug, Default)]
struct QuestionState {
    asking: bool,
    answered: bool,
    /// Which question is the open one: an earlier one ending must not clear a later one's flag.
    current: u64,
}

/// The group question, asked once.
pub struct AccessQuestion {
    user: String,
    consent: Arc<dyn Consent>,
    runner: Arc<dyn CommandRunner>,
    activity: Arc<dyn Activity>,
    state: Mutex<QuestionState>,
}

impl std::fmt::Debug for AccessQuestion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccessQuestion")
            .field("user", &self.user)
            .finish_non_exhaustive()
    }
}

impl AccessQuestion {
    pub fn new(
        user: impl Into<String>,
        consent: Arc<dyn Consent>,
        runner: Arc<dyn CommandRunner>,
        activity: Arc<dyn Activity>,
    ) -> Self {
        Self {
            user: user.into(),
            consent,
            runner,
            activity,
            state: Mutex::new(QuestionState::default()),
        }
    }

    /// For this process's user, running `pkexec` on this host.
    pub fn system(consent: Arc<dyn Consent>, activity: Arc<dyn Activity>) -> Self {
        Self::new(
            current_user_name().unwrap_or_default(),
            consent,
            Arc::new(SystemRunner),
            activity,
        )
    }

    fn lock(&self) -> MutexGuard<'_, QuestionState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The command that fixes it, for a user who would rather run it themselves.
    pub fn command(&self) -> String {
        manual_group_command(&self.user)
    }

    /// BlueZ refused this user. Logged every time; asked once, when somebody can be asked. The
    /// question runs on a task of its own, whose handle is returned when one was started.
    pub fn refused(
        self: &Arc<Self>,
        check_again: Arc<dyn CheckAgain>,
    ) -> Option<tokio::task::JoinHandle<()>> {
        self.activity.warn(&format!(
            "Bluetooth: BlueZ refused this user. The fix: {}",
            self.command()
        ));
        let mine = {
            let mut state = self.lock();
            if state.asking || state.answered || !self.consent.can_ask() {
                return None;
            }
            state.asking = true;
            state.current += 1;
            state.current
        };
        let this = Arc::clone(self);
        Some(tokio::spawn(async move {
            this.ask(mine, check_again).await;
        }))
    }

    async fn ask(&self, mine: u64, check_again: Arc<dyn CheckAgain>) {
        let result =
            offer_bluetooth_group(&self.user, self.consent.as_ref(), self.runner.as_ref()).await;
        match result {
            GroupFixResult::Added { message } => {
                self.activity.info(&format!("Bluetooth: {message}"));
                let again = self
                    .consent
                    .ask(Question {
                        kind: QuestionKind::BluetoothCheckAgain,
                        text: format!("{message} Check Bluetooth again now?"),
                        details: Vec::new(),
                    })
                    .await;
                if again == Answer::Yes {
                    // Not answered, and not asking any more before the check: BlueZ's refusal can
                    // come back during it (the login may still be the old one), and that one asks
                    // again.
                    self.finish(mine, false);
                    check_again.check_again().await;
                    return;
                }
            }
            GroupFixResult::Manual { command, reason } => {
                self.activity.warn(&format!(
                    "Bluetooth: BlueZ refused this user; run \"{command}\" ({reason})"
                ));
            }
            GroupFixResult::Cancelled => {
                self.activity.info(
                    "Bluetooth: the system dialog for joining the bluetooth group was dismissed",
                );
            }
            GroupFixResult::Declined => {
                self.activity.info(&format!(
                    "Bluetooth: not added to the bluetooth group; to do it later: {}",
                    self.command()
                ));
            }
        }
        self.finish(mine, true);
    }

    fn finish(&self, mine: u64, answered: bool) {
        let mut state = self.lock();
        if answered {
            state.answered = true;
        }
        if state.current == mine {
            state.asking = false;
        }
    }
}
