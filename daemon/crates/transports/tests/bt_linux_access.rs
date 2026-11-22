//! The bluetooth-group question: offered with the exact command, run only on a yes through
//! pkexec with a fixed argv, and asked once.
#![cfg(target_os = "linux")]

mod bt_linux_support;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use bt_linux_support::{Said, until};
use ev3_transports::bt_linux::access::{
    AccessQuestion, Answer, CheckAgain, CommandRunner, Consent, GroupFixResult, Question,
    QuestionKind, RunOutcome, is_plain_account_name, manual_group_command, offer_bluetooth_group,
};

struct ScriptedConsent {
    can_ask: AtomicBool,
    answers: Mutex<VecDeque<Answer>>,
    asked: Mutex<Vec<Question>>,
}

impl ScriptedConsent {
    fn answering(answers: &[Answer]) -> Arc<Self> {
        Arc::new(Self {
            can_ask: AtomicBool::new(true),
            answers: Mutex::new(answers.iter().copied().collect()),
            asked: Mutex::new(Vec::new()),
        })
    }

    fn kinds(&self) -> Vec<QuestionKind> {
        self.asked.lock().unwrap().iter().map(|q| q.kind).collect()
    }
}

#[async_trait]
impl Consent for ScriptedConsent {
    fn can_ask(&self) -> bool {
        self.can_ask.load(Ordering::SeqCst)
    }
    async fn ask(&self, question: Question) -> Answer {
        self.asked.lock().unwrap().push(question);
        self.answers
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Answer::Keep)
    }
}

struct Runner {
    outcome: RunOutcome,
    ran: Mutex<Vec<(String, Vec<String>)>>,
}

impl Runner {
    fn answering(outcome: RunOutcome) -> Arc<Self> {
        Arc::new(Self {
            outcome,
            ran: Mutex::new(Vec::new()),
        })
    }
}

#[async_trait]
impl CommandRunner for Runner {
    async fn run(&self, program: &str, args: &[String]) -> RunOutcome {
        self.ran
            .lock()
            .unwrap()
            .push((program.to_owned(), args.to_vec()));
        self.outcome.clone()
    }
}

#[tokio::test]
async fn runs_nothing_when_the_user_does_not_confirm() {
    for answer in [Answer::No, Answer::Keep] {
        let consent = ScriptedConsent::answering(&[answer]);
        let runner = Runner::answering(RunOutcome::Exited(Some(0)));
        let result = offer_bluetooth_group("student", consent.as_ref(), runner.as_ref()).await;
        assert_eq!(result, GroupFixResult::Declined);
        assert!(runner.ran.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn shows_the_exact_command_before_running_it_without_claiming_the_cause_as_certain() {
    let consent = ScriptedConsent::answering(&[Answer::No]);
    let runner = Runner::answering(RunOutcome::Exited(Some(0)));
    offer_bluetooth_group("student", consent.as_ref(), runner.as_ref()).await;
    let question = consent.asked.lock().unwrap()[0].clone();
    assert_eq!(question.details, ["pkexec usermod -aG bluetooth student"]);
    assert!(
        question.text.contains("On many systems"),
        "{}",
        question.text
    );
}

#[tokio::test]
async fn runs_exactly_pkexec_usermod_ag_bluetooth_user_with_no_shell() {
    let consent = ScriptedConsent::answering(&[Answer::Yes]);
    let runner = Runner::answering(RunOutcome::Exited(Some(0)));
    let result = offer_bluetooth_group("student", consent.as_ref(), runner.as_ref()).await;
    assert_eq!(
        *runner.ran.lock().unwrap(),
        [(
            "pkexec".to_owned(),
            vec![
                "usermod".to_owned(),
                "-aG".into(),
                "bluetooth".into(),
                "student".into()
            ]
        )]
    );
    match result {
        GroupFixResult::Added { message } => {
            assert!(message.contains("log out and in"), "{message}");
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn hands_back_the_command_when_pkexec_cannot_ask_or_is_missing() {
    for (outcome, reason) in [
        (RunOutcome::NotFound, "not installed"),
        (RunOutcome::Exited(Some(127)), "no polkit agent"),
        (RunOutcome::Exited(Some(1)), "exit 1"),
    ] {
        let consent = ScriptedConsent::answering(&[Answer::Yes]);
        let runner = Runner::answering(outcome);
        match offer_bluetooth_group("student", consent.as_ref(), runner.as_ref()).await {
            GroupFixResult::Manual {
                command,
                reason: why,
            } => {
                assert_eq!(command, "sudo usermod -aG bluetooth student");
                assert!(why.contains(reason), "{why}");
            }
            other => panic!("{other:?}"),
        }
    }
}

#[tokio::test]
async fn reports_a_password_dialog_the_user_dismissed_as_cancelled() {
    let consent = ScriptedConsent::answering(&[Answer::Yes]);
    let runner = Runner::answering(RunOutcome::Exited(Some(126)));
    let result = offer_bluetooth_group("student", consent.as_ref(), runner.as_ref()).await;
    assert_eq!(result, GroupFixResult::Cancelled);
}

#[tokio::test]
async fn never_runs_anything_for_a_user_name_that_is_not_a_plain_account_name() {
    let consent = ScriptedConsent::answering(&[Answer::Yes]);
    let runner = Runner::answering(RunOutcome::Exited(Some(0)));
    let result = offer_bluetooth_group("student;id", consent.as_ref(), runner.as_ref()).await;
    assert!(
        matches!(result, GroupFixResult::Manual { ref command, .. } if command.contains("<your user name>"))
    );
    assert!(runner.ran.lock().unwrap().is_empty());
    assert!(consent.asked.lock().unwrap().is_empty());
}

#[test]
fn plain_account_names_are_what_useradd_accepts() {
    for good in ["student", "_svc", "a.b-c_d", "machine$", "Student1"] {
        assert!(is_plain_account_name(good), "{good}");
    }
    for bad in ["", "1abc", "a b", "a;b", "$", "a$$", &"a".repeat(32)] {
        assert!(!is_plain_account_name(bad), "{bad}");
    }
}

#[test]
fn writes_the_command_to_copy_with_sudo() {
    assert_eq!(
        manual_group_command("student"),
        "sudo usermod -aG bluetooth student"
    );
}

#[derive(Default)]
struct Retry {
    count: AtomicUsize,
}

#[async_trait]
impl CheckAgain for Retry {
    async fn check_again(&self) {
        self.count.fetch_add(1, Ordering::SeqCst);
    }
}

fn question(
    consent: &Arc<ScriptedConsent>,
    runner: Arc<Runner>,
    said: &Arc<Said>,
) -> Arc<AccessQuestion> {
    Arc::new(AccessQuestion::new(
        "student",
        Arc::clone(consent) as _,
        runner,
        Arc::clone(said) as _,
    ))
}

#[tokio::test]
async fn asks_once_and_a_later_refusal_is_only_logged() {
    let consent = ScriptedConsent::answering(&[Answer::No]);
    let said = Arc::new(Said::default());
    let access = question(
        &consent,
        Runner::answering(RunOutcome::Exited(Some(0))),
        &said,
    );
    let retry = Arc::new(Retry::default());
    access
        .refused(Arc::clone(&retry) as _)
        .unwrap()
        .await
        .unwrap();
    assert!(access.refused(Arc::clone(&retry) as _).is_none());
    assert_eq!(consent.kinds(), [QuestionKind::BluetoothAccess]);
    assert_eq!(said.count_containing("BlueZ refused this user. The fix"), 2);
}

#[tokio::test]
async fn with_nobody_to_ask_logs_and_asks_once_somebody_is_there() {
    let consent = ScriptedConsent::answering(&[Answer::No]);
    consent.can_ask.store(false, Ordering::SeqCst);
    let said = Arc::new(Said::default());
    let access = question(
        &consent,
        Runner::answering(RunOutcome::Exited(Some(0))),
        &said,
    );
    let retry = Arc::new(Retry::default());
    assert!(access.refused(Arc::clone(&retry) as _).is_none());
    consent.can_ask.store(true, Ordering::SeqCst);
    access
        .refused(Arc::clone(&retry) as _)
        .unwrap()
        .await
        .unwrap();
    assert_eq!(consent.kinds(), [QuestionKind::BluetoothAccess]);
}

#[tokio::test]
async fn added_and_checked_again_asks_again_if_bluez_still_refuses() {
    let consent = ScriptedConsent::answering(&[Answer::Yes, Answer::Yes, Answer::No]);
    let said = Arc::new(Said::default());
    let access = question(
        &consent,
        Runner::answering(RunOutcome::Exited(Some(0))),
        &said,
    );
    let retry = Arc::new(Retry::default());
    access
        .refused(Arc::clone(&retry) as _)
        .unwrap()
        .await
        .unwrap();
    assert_eq!(retry.count.load(Ordering::SeqCst), 1);
    assert_eq!(
        consent.kinds(),
        [
            QuestionKind::BluetoothAccess,
            QuestionKind::BluetoothCheckAgain
        ]
    );
    // The login may still be the old one: that refusal asks again.
    access
        .refused(Arc::clone(&retry) as _)
        .unwrap()
        .await
        .unwrap();
    assert_eq!(consent.kinds().len(), 3);
}

#[tokio::test]
async fn added_but_not_checked_again_counts_as_answered() {
    let consent = ScriptedConsent::answering(&[Answer::Yes, Answer::No]);
    let said = Arc::new(Said::default());
    let access = question(
        &consent,
        Runner::answering(RunOutcome::Exited(Some(0))),
        &said,
    );
    let retry = Arc::new(Retry::default());
    access
        .refused(Arc::clone(&retry) as _)
        .unwrap()
        .await
        .unwrap();
    assert_eq!(retry.count.load(Ordering::SeqCst), 0);
    assert!(access.refused(Arc::clone(&retry) as _).is_none());
    let watching = Arc::clone(&said);
    until(move || watching.count_containing("is now in the") == 1).await;
}
