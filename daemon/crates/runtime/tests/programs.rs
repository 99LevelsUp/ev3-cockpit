//! The program service over a fake brick that keeps the user slot as the firmware does: run, stop,
//! emergency stop and run state for one brick, and following the state through the program row.
//!
//! The firmware refuses a start into a running slot in silence, so the service checks first
//! (refused unless replacing) and confirms afterwards. Emergency stop is the brick's own power-off
//! sequence. A stop never waits behind a start, and a start asked before a stop whose command has
//! not gone out starts nothing. Run state is followed while someone listens, and not otherwise.

mod support_programs;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use ev3_contract::{ErrorCode, StartOutcome};
use ev3_protocol::{BrickCommand, BrickResponse};
use ev3_runtime::programs::{
    EndSink, ProgramError, ProgramRowTelemetry, ProgramRows, ProgramService, StartOptions,
    StateSink,
};
use ev3_runtime::telemetry::{ClaimRequest, ReadModelChange, ReadValue, Reading, TelemetryError};
use ev3_runtime::transfer::CancelFlag;
use futures_util::FutureExt;
use support_programs::*;

fn start(service: &ProgramService) -> tokio::task::JoinHandle<Result<StartOutcome, ProgramError>> {
    let service = service.clone();
    tokio::spawn(async move { service.start(PRG, &vscode(), StartOptions::default()).await })
}

// ── Starting ────────────────────────────────────────────────────────

#[tokio::test]
async fn runs_a_program_and_says_it_runs() {
    let w = world();

    let outcome = w
        .programs
        .start(PRG, &vscode(), StartOptions::default())
        .await;

    assert_eq!(outcome, Ok(StartOutcome::Started));
    assert_eq!(w.programs.is_running().await, Ok(true));
}

#[tokio::test]
async fn refuses_to_run_while_a_program_runs_unless_asked_to_replace_it() {
    let w = world();
    w.programs
        .start(PRG, &vscode(), StartOptions::default())
        .await
        .unwrap();

    let refused = w
        .programs
        .start(PRG, &vscode(), StartOptions::default())
        .await
        .unwrap_err();
    assert_eq!(refused.code(), Some(ErrorCode::ProgramRunning));
    assert_eq!(
        w.brick.count("program:run"),
        1,
        "a start into a running slot went out"
    );

    let replace = StartOptions {
        replace: true,
        ..StartOptions::default()
    };
    let outcome = w.programs.start(PRG, &vscode(), replace).await;

    assert_eq!(outcome, Ok(StartOutcome::Started));
    assert_eq!(w.programs.is_running().await, Ok(true));
    assert!(
        w.brick.log().contains(&"program:stop".to_owned()),
        "replaced without stopping first: the firmware would refuse the start"
    );
}

#[tokio::test]
async fn says_the_program_is_not_on_the_brick() {
    let w = world();
    let path = "/home/root/lms2012/prjs/None/None.rbf";

    let error = w
        .programs
        .start(path, &vscode(), StartOptions::default())
        .await
        .unwrap_err();

    assert_eq!(error.code(), Some(ErrorCode::ProgramNotFound));
    assert_eq!(error, ProgramError::NotFound { path: path.into() });
}

#[tokio::test]
async fn does_not_claim_a_refusal_when_the_slot_never_shows_running() {
    let w = world();
    // A short program may have ended already: the brick took the start, the slot stays idle.
    w.brick.answer_with(|command| {
        matches!(command, BrickCommand::ProgramRun { .. })
            .then_some(Ok(BrickResponse::ProgramRun { image_bytes: 14 }))
    });

    let outcome = w
        .programs
        .start(PRG, &vscode(), StartOptions::default())
        .await;

    assert_eq!(
        outcome,
        Ok(StartOutcome::NotSeenRunning),
        "said it was seen running"
    );
}

#[tokio::test]
async fn runs_one_program_at_a_time_when_two_callers_ask_at_once() {
    let w = world();
    let (one, other) = (vscode(), person("ev3"));

    let (first, second) = tokio::join!(
        w.programs.start(PRG, &one, StartOptions::default()),
        w.programs.start(PRG, &other, StartOptions::default()),
    );

    let mut results = [first, second];
    results.sort_by_key(Result::is_ok);
    assert_eq!(
        results[0].as_ref().unwrap_err().code(),
        Some(ErrorCode::ProgramRunning)
    );
    assert_eq!(results[1], Ok(StartOutcome::Started));
    assert_eq!(w.brick.count("program:run"), 1);
}

#[tokio::test]
async fn reports_a_start_whose_reply_was_lost_as_uncertain_and_does_not_send_it_again() {
    let w = world();
    w.brick
        .lose(|command| matches!(command, BrickCommand::ProgramRun { .. }));

    let outcome = w
        .programs
        .start(PRG, &vscode(), StartOptions::default())
        .await;

    assert_eq!(outcome, Ok(StartOutcome::Uncertain));
    assert_eq!(w.brick.count("program:run"), 1, "the start was sent again");
}

#[tokio::test]
async fn fails_a_start_refused_before_it_left_instead_of_calling_it_uncertain() {
    let w = world();
    w.brick
        .refuse(|command| matches!(command, BrickCommand::ProgramRun { .. }));

    let error = w
        .programs
        .start(PRG, &vscode(), StartOptions::default())
        .await
        .unwrap_err();

    assert_eq!(error, ProgramError::Command(link_lost()));
}

#[tokio::test]
async fn reports_the_start_as_a_write_and_the_stop_not() {
    let w = world();

    w.programs
        .start(PRG, &vscode(), StartOptions::default())
        .await
        .unwrap();
    w.programs.stop(&person("ev3")).await.unwrap();

    assert_eq!(
        w.reports.seen(),
        [
            format!("started Starting {PRG} for VS Code"),
            format!("ended Starting {PRG} for VS Code"),
        ]
    );
}

#[tokio::test]
async fn waits_out_a_lost_route_before_its_last_check_when_given_a_deadline() {
    let w = world();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);

    let options = StartOptions {
        deadline: Some(deadline),
        ..StartOptions::default()
    };
    w.programs.start(PRG, &vscode(), options).await.unwrap();

    assert_eq!(w.brick.state().route_waits, [deadline]);
}

#[tokio::test]
async fn ends_with_cancelled_when_its_caller_cancels_and_stops_nothing() {
    let w = world();
    let mark = w.programs.stop_mark();
    let cancel = CancelFlag::new();
    w.brick.hold("program:status");
    let options = StartOptions {
        cancel: Some(cancel.clone()),
        ..StartOptions::default()
    };
    let service = w.programs.clone();
    let starting = tokio::spawn(async move { service.start(PRG, &vscode(), options).await });
    w.brick.until(|s| !s.arrived.is_empty()).await;

    cancel.cancel();
    w.brick.release();

    assert_eq!(starting.await.unwrap(), Err(ProgramError::Cancelled));
    assert_eq!(w.brick.count("program:run"), 0);
    assert_eq!(
        w.brick.count("program:stop"),
        0,
        "a cancel stopped the brick"
    );
    assert!(
        !w.programs.stopped_since(mark).stopped,
        "a cancel counted as a stop"
    );
}

#[tokio::test]
async fn a_start_its_caller_drops_stops_nothing_and_leaves_the_turn_to_the_next() {
    let w = world();
    w.brick.hold("program:status");
    let starting = start(&w.programs);
    w.brick.until(|s| !s.arrived.is_empty()).await;

    starting.abort();
    let _ = starting.await;
    w.brick.release();

    let outcome = tokio::time::timeout(
        Duration::from_secs(2),
        w.programs.start(PRG, &vscode(), StartOptions::default()),
    )
    .await
    .expect("the dropped start kept the turn");
    assert_eq!(outcome, Ok(StartOutcome::Started));
    assert_eq!(
        w.brick.count("program:stop"),
        0,
        "dropping a start stopped the brick"
    );
    assert_eq!(w.programs.last_stopper(), None);
}

// ── Stopping ────────────────────────────────────────────────────────

#[tokio::test]
async fn stops_a_program() {
    let w = world();
    w.programs
        .start(PRG, &vscode(), StartOptions::default())
        .await
        .unwrap();

    w.programs.stop(&vscode()).await.unwrap();

    assert_eq!(w.programs.is_running().await, Ok(false));
    assert_eq!(w.programs.last_stopper().as_deref(), Some("VS Code"));
}

#[tokio::test]
async fn stops_in_an_emergency_with_the_bricks_power_off_sequence_motors_included() {
    let w = world();
    w.programs
        .start(PRG, &vscode(), StartOptions::default())
        .await
        .unwrap();

    w.programs.emergency_stop(&vscode()).await.unwrap();

    assert_eq!(w.programs.is_running().await, Ok(false));
    assert_eq!(w.brick.state().motors_stopped, 1);
    assert_eq!(
        w.brick.count("program:stop"),
        0,
        "a stop instead of the power-off sequence"
    );
}

#[tokio::test]
async fn never_starts_a_program_after_an_emergency_stop_asked_while_the_start_was_on_its_way() {
    let w = world();
    // The start's first question, whether a program runs, is held on its way.
    w.brick.hold("program:status");
    let starting = start(&w.programs);
    w.brick.until(|s| !s.arrived.is_empty()).await;

    let stopping = {
        let programs = w.programs.clone();
        tokio::spawn(async move { programs.emergency_stop(&person("ev3")).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    w.brick.release();

    let error = starting.await.unwrap().unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::Cancelled));
    assert_eq!(error.stopped_by(), Some("ev3"));
    stopping.await.unwrap().unwrap();
    assert_eq!(
        w.programs.is_running().await,
        Ok(false),
        "the program started after the stop"
    );
    assert_eq!(w.brick.count("program:run"), 0);
}

#[tokio::test]
async fn starts_nothing_when_a_stop_comes_while_a_run_is_still_checking_the_slot() {
    let w = world();
    w.brick.hold("program:status");
    let starting = start(&w.programs);
    w.brick.until(|s| !s.arrived.is_empty()).await;

    let stopping = {
        let programs = w.programs.clone();
        tokio::spawn(async move { programs.stop(&vscode()).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    w.brick.release();

    let error = starting.await.unwrap().unwrap_err();
    assert_eq!(
        error,
        ProgramError::Stopped {
            stopped_by: Some("VS Code".into()),
            deploying: false,
        }
    );
    assert!(error.to_string().contains("VS Code"), "{error}");
    stopping.await.unwrap().unwrap();
    assert_eq!(
        w.brick.count("program:run"),
        0,
        "a start went out after the stop"
    );
    assert_eq!(w.programs.is_running().await, Ok(false));
    assert_eq!(
        w.reports.seen(),
        Vec::<String>::new(),
        "a start the stop cancelled was reported as a write"
    );
}

#[tokio::test]
async fn sends_the_stop_while_a_run_is_still_confirming_its_start() {
    let w = world();
    // The brick takes the start but never shows the program running: the start keeps asking for
    // its whole confirmation window.
    w.brick.answer_with(|command| {
        matches!(command, BrickCommand::ProgramRun { .. })
            .then_some(Ok(BrickResponse::ProgramRun { image_bytes: 14 }))
    });
    let starting = {
        let programs = w.programs.clone();
        let brick = w.brick.clone();
        tokio::spawn(async move {
            let outcome = programs
                .start(PRG, &vscode(), StartOptions::default())
                .await;
            brick.mark("run settled");
            outcome
        })
    };
    w.brick
        .until(|s| s.log.iter().any(|k| k == "program:run"))
        .await;

    w.programs.stop(&vscode()).await.unwrap();
    w.brick.mark("stop settled");
    starting.await.unwrap().unwrap();

    let log = w.brick.log();
    let at = |what: &str| log.iter().position(|k| k == what).unwrap();
    assert!(
        at("program:stop") < at("run settled"),
        "the stop waited for the confirmation: {log:?}"
    );
    assert!(
        at("stop settled") < at("run settled"),
        "the stop returned only after the run: {log:?}"
    );
}

#[tokio::test]
async fn a_stop_counted_after_the_last_check_reaches_the_brick_after_the_start_and_ends_it() {
    let w = world();
    // The start has passed its last check and is on its way to the brick when the stop is asked.
    w.brick.hold("program:run");
    let starting = start(&w.programs);
    w.brick
        .until(|s| s.arrived.iter().any(|k| k == "program:run"))
        .await;

    let stopping = {
        let programs = w.programs.clone();
        tokio::spawn(async move { programs.emergency_stop(&vscode()).await })
    };
    tokio::time::sleep(Duration::from_millis(20)).await;
    w.brick.release();

    stopping.await.unwrap().unwrap();
    let _ = starting.await.unwrap();
    let log = w.brick.log();
    let at = |what: &str| log.iter().position(|k| k == what).unwrap();
    assert!(
        at("program:run") < at("program:emergencyStop"),
        "the stop reached the brick before the start it was meant to end: {log:?}"
    );
    assert_eq!(
        w.programs.is_running().await,
        Ok(false),
        "the program runs after the stop"
    );
}

// ── Following ───────────────────────────────────────────────────────

#[tokio::test]
async fn follows_the_run_state_while_anyone_listens_one_follow_for_every_listener() {
    let follow = FakeFollow::new();
    let w = world_with(Some(follow.clone()));

    let first = w.programs.subscribe().unwrap();
    let second = w.programs.subscribe().unwrap();
    assert_eq!(follow.counts(), (1, 0));

    drop(first);
    assert_eq!(follow.counts(), (1, 0), "one listener still there");
    drop(second);
    assert_eq!(follow.counts(), (1, 1));
    assert_eq!(w.brick.count("program:status"), 0, "no poll of its own");
}

#[tokio::test]
async fn refuses_to_follow_without_telemetry_and_keeps_no_listener_whose_follow_could_not_start() {
    let bare = world();
    let error = bare.programs.subscribe().err().unwrap();
    assert_eq!(error.code(), Some(ErrorCode::SubscriptionFailed));

    let follow = FakeFollow::new();
    let w = world_with(Some(follow.clone()));
    *follow.failing.lock().unwrap() = true;
    assert!(w.programs.subscribe().is_err());

    *follow.failing.lock().unwrap() = false;
    let mut later = w.programs.subscribe().unwrap();
    follow.say(false, now_ms());
    follow.say(true, now_ms());

    assert_eq!(later.next().now_or_never(), Some(Some(true)));
    assert_eq!(
        follow.counts(),
        (1, 0),
        "a refused follow was counted as made"
    );
}

#[tokio::test]
async fn tells_every_listener_even_when_one_never_reads_and_the_start_still_succeeds() {
    let follow = FakeFollow::new();
    let w = world_with(Some(follow.clone()));
    let _idle = w.programs.subscribe().unwrap();
    let mut reading = w.programs.subscribe().unwrap();
    follow.say(false, now_ms());

    let outcome = w
        .programs
        .start(PRG, &vscode(), StartOptions::default())
        .await;

    assert_eq!(outcome, Ok(StartOutcome::Started));
    assert_eq!(reading.next().now_or_never(), Some(Some(true)));
    assert_eq!(
        reading.next().now_or_never(),
        None,
        "told more than the start"
    );
}

#[tokio::test]
async fn tells_a_listener_when_a_program_starts_and_when_it_ends_by_itself_once_each() {
    let follow = FakeFollow::new();
    let w = world_with(Some(follow.clone()));
    let mut states = w.programs.subscribe().unwrap();
    follow.say(false, now_ms() - 1);

    w.programs
        .start(PRG, &vscode(), StartOptions::default())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(2)).await;
    w.brick.end_program();
    follow.say(false, now_ms()); // the program row: it ended by itself
    follow.say(false, now_ms()); // and is read again, still ended

    assert_eq!(states.next().now_or_never(), Some(Some(true)));
    assert_eq!(states.next().now_or_never(), Some(Some(false)));
    assert_eq!(states.next().now_or_never(), None);
}

#[tokio::test]
async fn does_not_follow_the_brick_when_nobody_listens_even_while_a_program_it_started_runs() {
    let follow = FakeFollow::new();
    let w = world_with(Some(follow.clone()));
    w.programs
        .start(PRG, &vscode(), StartOptions::default())
        .await
        .unwrap();
    let before = w.brick.log().len();

    tokio::time::sleep(Duration::from_millis(100)).await;

    assert_eq!(
        w.brick.log().len(),
        before,
        "asked a brick nobody asked about"
    );
    assert_eq!(follow.counts(), (0, 0));
}

#[tokio::test]
async fn ends_following_with_the_bricks_session_and_a_new_listener_starts_a_new_follow() {
    let follow = FakeFollow::new();
    let w = world_with(Some(follow.clone()));
    let mut old = w.programs.subscribe().unwrap();

    follow.end_session();
    let mut fresh = w.programs.subscribe().unwrap();
    follow.say(true, now_ms());
    follow.say(false, now_ms());

    assert_eq!(follow.counts().0, 2, "a new claim after the session ended");
    assert!(old.ended());
    assert_eq!(
        old.next().await,
        None,
        "a listener of the ended session is not revived"
    );
    assert_eq!(fresh.next().now_or_never(), Some(Some(false)));
    assert_eq!(fresh.next().now_or_never(), None);
}

#[tokio::test]
async fn tells_nothing_queued_before_the_session_ended() {
    let follow = FakeFollow::new();
    let w = world_with(Some(follow.clone()));
    let mut states = w.programs.subscribe().unwrap();
    follow.say(false, now_ms());
    follow.say(true, now_ms());

    follow.end_session();

    assert_eq!(states.next().await, None);
}

#[tokio::test]
async fn takes_no_state_older_than_one_it_already_has() {
    let follow = FakeFollow::new();
    let w = world_with(Some(follow.clone()));
    let before = now_ms() - 1000; // a frame read before the start

    let outcome = w
        .programs
        .start(PRG, &vscode(), StartOptions::default())
        .await;
    assert_eq!(outcome, Ok(StartOutcome::Started)); // confirmed running, now
    let mut states = w.programs.subscribe().unwrap();
    follow.say(false, before); // the cached value, replayed
    follow.say(true, now_ms()); // the next frame

    assert_eq!(
        states.next().now_or_never(),
        None,
        "an end and a start that never happened"
    );
}

#[tokio::test]
async fn follows_again_on_asking_keeping_its_listeners_and_leaving_no_gap() {
    let follow = FakeFollow::new();
    let w = world_with(Some(follow.clone()));
    let mut states = w.programs.subscribe().unwrap();
    follow.say(false, now_ms());

    w.programs.follow_again();
    follow.say(true, now_ms());

    assert_eq!(
        follow.counts(),
        (2, 1),
        "the new follow first, then the old one goes"
    );
    assert_eq!(states.next().now_or_never(), Some(Some(true)));
}

#[tokio::test]
async fn ends_every_listener_when_disposed() {
    let follow = FakeFollow::new();
    let w = world_with(Some(follow.clone()));
    let mut states = w.programs.subscribe().unwrap();

    w.programs.dispose();

    assert_eq!(states.next().await, None);
    assert_eq!(follow.counts(), (1, 1));
    assert!(w.programs.subscribe().is_err());
}

// ── The program row ─────────────────────────────────────────────────

const ROW: &str = "program.user.running";
const A: &str = "AAA";
const B: &str = "BBB";

#[derive(Default)]
struct FakeTelemetry {
    claims: Mutex<Vec<(String, ClaimRequest, String)>>,
    released: Mutex<Vec<String>>,
    snapshot: Mutex<Option<ReadValue>>,
    /// Ends the claim inside the claim call, as a listener ending the brick there would.
    end_inside_claim: Option<Mutex<Option<ProgramRows>>>,
}

impl ProgramRowTelemetry for FakeTelemetry {
    fn claim(
        &self,
        brick_id: &str,
        request: &ClaimRequest,
        owner: &str,
    ) -> Result<String, TelemetryError> {
        let handle = {
            let mut claims = self.claims.lock().unwrap();
            claims.push((brick_id.into(), request.clone(), owner.into()));
            format!("h{}", claims.len())
        };
        if let Some(rows) = &self.end_inside_claim {
            let rows = rows.lock().unwrap().clone();
            if let Some(rows) = rows {
                rows.claims_ended(brick_id, std::slice::from_ref(&handle));
            }
        }
        Ok(handle)
    }

    fn release(&self, handle: &str) {
        self.released.lock().unwrap().push(handle.into());
    }

    fn program_row(&self, brick_id: &str) -> Option<ReadValue> {
        if brick_id == A {
            self.snapshot.lock().unwrap().clone()
        } else {
            None
        }
    }
}

fn value(reading: Reading, stale: bool, sampled_at: u64) -> ReadValue {
    ReadValue {
        row_id: ROW.into(),
        value: reading,
        unit: None,
        mode: None,
        sampled_at,
        effective: None,
        stale,
    }
}

fn change(brick: &str, rows: Vec<ReadValue>, removed: &[&str]) -> ReadModelChange {
    ReadModelChange {
        brick_id: brick.into(),
        rows,
        removed: removed.iter().map(|id| (*id).to_owned()).collect(),
    }
}

type Heard = Arc<Mutex<Vec<(bool, u64)>>>;

fn sinks() -> (StateSink, EndSink, Heard, Arc<Mutex<u32>>) {
    let heard: Heard = Arc::default();
    let ended = Arc::new(Mutex::new(0));
    let on_state: StateSink = {
        let heard = heard.clone();
        Arc::new(move |running, at| heard.lock().unwrap().push((running, at)))
    };
    let on_ended: EndSink = {
        let ended = ended.clone();
        Arc::new(move || *ended.lock().unwrap() += 1)
    };
    (on_state, on_ended, heard, ended)
}

fn interval(ms: f64) -> Arc<dyn Fn() -> f64 + Send + Sync> {
    Arc::new(move || ms)
}

#[test]
fn claims_the_row_on_its_brick_at_the_interval_it_is_given_as_the_cockpit() {
    let telemetry = Arc::new(FakeTelemetry::default());
    let rows = ProgramRows::new(telemetry.clone());
    let (on_state, on_ended, _, _) = sinks();

    let _following = rows
        .follower(A, interval(750.0))
        .follow(on_state, on_ended)
        .unwrap();

    let claims = telemetry.claims.lock().unwrap();
    assert_eq!(claims.len(), 1);
    let (brick, request, owner) = &claims[0];
    assert_eq!(brick, A);
    assert_eq!(request.row_ids, [ROW]);
    assert_eq!(request.interval_ms, 750.0);
    assert_eq!(owner, "cockpit:programs");
}

#[test]
fn tells_the_state_there_is_now_then_each_change_of_its_brick() {
    let telemetry = Arc::new(FakeTelemetry::default());
    *telemetry.snapshot.lock().unwrap() = Some(value(Reading::Flag(false), false, 1));
    let rows = ProgramRows::new(telemetry.clone());
    let (on_state, on_ended, heard, _) = sinks();
    let _following = rows
        .follower(A, interval(1000.0))
        .follow(on_state, on_ended)
        .unwrap();

    rows.change(&change(A, vec![value(Reading::Flag(true), false, 2)], &[]));

    assert_eq!(*heard.lock().unwrap(), [(false, 1), (true, 2)]);
}

#[test]
fn tells_nothing_for_another_brick_a_stale_or_dropped_value_or_a_value_that_is_not_a_state() {
    let telemetry = Arc::new(FakeTelemetry::default());
    let rows = ProgramRows::new(telemetry.clone());
    let (on_state, on_ended, heard, _) = sinks();
    let _following = rows
        .follower(A, interval(1000.0))
        .follow(on_state, on_ended)
        .unwrap();

    rows.change(&change(B, vec![value(Reading::Flag(true), false, 1)], &[]));
    rows.change(&change(A, vec![value(Reading::Flag(true), true, 1)], &[]));
    rows.change(&change(A, vec![], &[ROW]));
    rows.change(&change(A, vec![value(Reading::Number(1.0), false, 1)], &[]));

    assert!(heard.lock().unwrap().is_empty());
}

#[test]
fn releases_its_claim_once_when_it_ends_and_tells_nothing_after() {
    let telemetry = Arc::new(FakeTelemetry::default());
    let rows = ProgramRows::new(telemetry.clone());
    let (on_state, on_ended, heard, _) = sinks();
    let following = rows
        .follower(A, interval(1000.0))
        .follow(on_state, on_ended)
        .unwrap();

    drop(following);
    rows.change(&change(A, vec![value(Reading::Flag(true), false, 1)], &[]));

    assert_eq!(*telemetry.released.lock().unwrap(), ["h1"]);
    assert!(heard.lock().unwrap().is_empty());
}

#[test]
fn says_when_the_bricks_session_ended_its_claim_and_tells_nothing_after() {
    let telemetry = Arc::new(FakeTelemetry::default());
    let rows = ProgramRows::new(telemetry.clone());
    let (on_state, on_ended, heard, ended) = sinks();
    let following = rows
        .follower(A, interval(1000.0))
        .follow(on_state, on_ended)
        .unwrap();

    rows.claims_ended(B, &["h1".to_owned()]);
    assert_eq!(*ended.lock().unwrap(), 0, "another brick's claims");
    rows.claims_ended(A, &["h1".to_owned()]);
    rows.change(&change(A, vec![value(Reading::Flag(false), false, 1)], &[]));
    drop(following);

    assert_eq!(*ended.lock().unwrap(), 1);
    assert!(heard.lock().unwrap().is_empty());
    assert!(
        telemetry.released.lock().unwrap().is_empty(),
        "released a claim that went with its brick"
    );
}

#[test]
fn tells_when_each_state_was_sampled() {
    let telemetry = Arc::new(FakeTelemetry::default());
    let rows = ProgramRows::new(telemetry.clone());
    let (on_state, on_ended, heard, _) = sinks();
    let _following = rows
        .follower(A, interval(1000.0))
        .follow(on_state, on_ended)
        .unwrap();

    rows.change(&change(A, vec![value(Reading::Flag(true), false, 42)], &[]));

    assert_eq!(*heard.lock().unwrap(), [(true, 42)]);
}

#[test]
fn refuses_a_follow_whose_claim_ended_while_it_was_being_made_listening_to_nothing() {
    let telemetry = Arc::new(FakeTelemetry {
        end_inside_claim: Some(Mutex::new(None)),
        ..FakeTelemetry::default()
    });
    let rows = ProgramRows::new(telemetry.clone());
    *telemetry.end_inside_claim.as_ref().unwrap().lock().unwrap() = Some(rows.clone());
    let (on_state, on_ended, heard, ended) = sinks();

    let error = rows
        .follower(A, interval(1000.0))
        .follow(on_state, on_ended)
        .err()
        .unwrap();

    assert_eq!(error.code(), Some(ErrorCode::SubscriptionFailed));
    rows.change(&change(A, vec![value(Reading::Flag(true), false, 1)], &[]));
    rows.claims_ended(A, &["h1".to_owned()]);
    assert!(heard.lock().unwrap().is_empty(), "nobody left listening");
    assert_eq!(*ended.lock().unwrap(), 0);
}

#[tokio::test]
async fn a_program_service_hears_its_brick_through_the_row_and_queues_each_change_for_its_listener()
{
    let telemetry = Arc::new(FakeTelemetry::default());
    *telemetry.snapshot.lock().unwrap() = Some(value(Reading::Flag(false), false, now_ms() - 10));
    let rows = ProgramRows::new(telemetry.clone());
    let brick = FakeBrick::new();
    let programs = ProgramService::new(
        brick,
        quick(),
        Some(rows.follower(A, interval(500.0))),
        None,
    );
    let mut states = programs.subscribe().unwrap();

    rows.change(&change(
        A,
        vec![value(Reading::Flag(true), false, now_ms())],
        &[],
    ));

    assert_eq!(states.next().now_or_never(), Some(Some(true)));
    drop(states);
    assert_eq!(
        *telemetry.released.lock().unwrap(),
        ["h1"],
        "the last listener kept the claim"
    );
}
