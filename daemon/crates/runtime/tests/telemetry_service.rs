//! Claims, the brick loop and the service. Ports of `telemetryClaims.test.ts`,
//! `brickTelemetry.test.ts`, `schedulerSchedule.test.ts` (the floor clamp),
//! `telemetryServiceClaims.test.ts`, `telemetryThrottle.test.ts` and `programPreset.test.ts`.
//! Names are `<describe>__<it>` in snake case.

#![allow(non_snake_case)]

mod support_telemetry;

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use ev3_protocol::packet::program_status;
use ev3_protocol::{BrickCommand, BrickResponse};
use ev3_runtime::telemetry::brick_loop::{
    BrickTelemetry, BrickTelemetryOptions, TelemetrySender, frame_limits_for,
};
use ev3_runtime::telemetry::claims::{ClaimCadence, ClaimRequest, RowRate, TelemetryClaims};
use ev3_runtime::telemetry::service::{
    ReadMode, TelemetryEvent, TelemetryService, TelemetryServiceOptions,
};
use ev3_runtime::telemetry::{
    Lifetime, ProgramPresetSettings, TelemetryError, TelemetryRow, ThrottleSettings, WallClock,
    cadence_for, ev3_row_registry,
};
use ev3_transports::Transport;
use support_telemetry::{FakeBricks, RowExt, row};

const A: &str = "AAA";
const B: &str = "BBB";
const TACHO: &str = "ports.motor.A.tacho";

fn request(rows: &[&str], interval_ms: f64) -> ClaimRequest {
    ClaimRequest {
        row_ids: rows.iter().map(|r| (*r).to_owned()).collect(),
        interval_ms,
        modes: BTreeMap::new(),
    }
}

fn with_modes(mut request: ClaimRequest, modes: &[(&str, u64)]) -> ClaimRequest {
    request.modes = modes.iter().map(|(p, m)| ((*p).to_owned(), *m)).collect();
    request
}

fn grant(entries: &[(&str, RowRate)]) -> BTreeMap<String, RowRate> {
    entries
        .iter()
        .map(|(id, rate)| ((*id).to_owned(), *rate))
        .collect()
}

fn ids(rows: &[TelemetryRow]) -> Vec<String> {
    rows.iter().map(|r| r.id.clone()).collect()
}

fn divider_of(rows: &[TelemetryRow], id: &str) -> Option<Lifetime> {
    rows.iter().find(|r| r.id == id).map(|r| r.lifetime)
}

// ── telemetry claims ────────────────────────────────────────────────

const USB: ClaimCadence = ClaimCadence {
    floor_ms: 50.0,
    foreground_ms: 100.0,
};

fn claims(foreground: bool) -> TelemetryClaims {
    let mut c = TelemetryClaims::new(ev3_row_registry(), USB);
    c.set_foreground(foreground);
    c
}

#[test]
fn telemetry_claims__reads_every_row_for_the_foreground() {
    let plan = claims(true).plan();
    assert_eq!(plan.period_ms, 100.0);
    assert_eq!(plan.rows.len(), ev3_row_registry().all().len());
    assert_eq!(
        divider_of(&plan.rows, "ports.sensor.1.value"),
        Some(Lifetime::Repeating { divider: 1 })
    );
    assert_eq!(
        divider_of(&plan.rows, "system.battery.level"),
        Some(Lifetime::Repeating { divider: 5 })
    );
    assert_eq!(
        divider_of(&plan.rows, "system.firmwareVersion"),
        Some(Lifetime::OneShot)
    );
}

#[test]
fn telemetry_claims__reads_nothing_for_a_brick_nobody_claims_and_that_is_not_in_the_foreground() {
    assert!(claims(false).plan().rows.is_empty());
}

#[test]
fn telemetry_claims__reads_only_the_claimed_rows_of_a_brick_in_the_background_at_the_interval_asked()
 {
    let mut c = claims(false);
    let handle = c
        .claim(
            &request(&["ports.sensor.1.value", "system.battery.level"], 400.0),
            "ev3-explorer",
        )
        .unwrap();
    let plan = c.plan();
    assert_eq!(plan.period_ms, 400.0);
    let mut planned = ids(&plan.rows);
    planned.sort();
    assert_eq!(planned, ["ports.sensor.1.value", "system.battery.level"]);
    assert_eq!(
        c.grant_of(handle).unwrap(),
        &grant(&[
            ("ports.sensor.1.value", RowRate::Every(400.0)),
            ("system.battery.level", RowRate::Every(400.0))
        ])
    );
}

#[test]
fn telemetry_claims__speeds_the_tick_for_a_claim_faster_than_the_foreground() {
    let mut c = claims(true);
    let handle = c
        .claim(&request(&["ports.sensor.2.value"], 60.0), "fast")
        .unwrap();
    let plan = c.plan();
    assert_eq!(plan.period_ms, 60.0);
    assert_eq!(
        c.grant_of(handle).unwrap()["ports.sensor.2.value"],
        RowRate::Every(60.0)
    );
    assert_eq!(
        divider_of(&plan.rows, "ports.sensor.1.value"),
        Some(Lifetime::Repeating { divider: 1 })
    );
    assert_eq!(
        divider_of(&plan.rows, "system.battery.level"),
        Some(Lifetime::Repeating { divider: 8 })
    );
}

#[test]
fn telemetry_claims__clamps_a_claim_faster_than_the_transport_allows_to_its_floor() {
    let mut c = claims(false);
    let handle = c.claim(&request(&[TACHO], 10.0), "greedy").unwrap();
    assert_eq!(c.plan().period_ms, 50.0);
    assert_eq!(c.grant_of(handle).unwrap()[TACHO], RowRate::Every(50.0));
}

#[test]
fn telemetry_claims__reads_an_interval_between_ticks_on_the_faster_one_and_grants_what_was_asked() {
    let mut c = claims(true);
    let handle = c
        .claim(&request(&["system.battery.level"], 150.0), "battery-watch")
        .unwrap();
    assert_eq!(
        divider_of(&c.plan().rows, "system.battery.level"),
        Some(Lifetime::Repeating { divider: 1 })
    );
    assert_eq!(
        c.grant_of(handle).unwrap()["system.battery.level"],
        RowRate::Every(150.0)
    );
}

#[test]
fn telemetry_claims__keeps_a_grant_as_negotiated_when_the_foreground_leaves_or_the_transport_changes()
 {
    let mut c = claims(true);
    let handle = c.claim(&request(&[TACHO], 100.0), "tacho-watch").unwrap();
    c.set_foreground(false);
    assert_eq!(
        c.grant_of(handle).unwrap(),
        &grant(&[(TACHO, RowRate::Every(100.0))])
    );
    c.set_cadence(ClaimCadence {
        floor_ms: 250.0,
        foreground_ms: 500.0,
    });
    assert_eq!(c.plan().period_ms, 250.0);
    assert_eq!(
        c.grant_of(handle).unwrap(),
        &grant(&[(TACHO, RowRate::Every(100.0))])
    );
}

#[test]
fn telemetry_claims__says_a_static_row_is_read_once() {
    let mut c = claims(false);
    let handle = c
        .claim(&request(&["system.firmwareVersion"], 1000.0), "info")
        .unwrap();
    assert_eq!(
        c.grant_of(handle).unwrap()["system.firmwareVersion"],
        RowRate::Once
    );
}

#[test]
fn telemetry_claims__recomputes_from_the_claims_that_remain_when_one_is_released() {
    let mut c = claims(true);
    let handle = c
        .claim(&request(&["ports.sensor.2.value"], 60.0), "fast")
        .unwrap();
    c.release(handle);
    c.release(handle);
    assert_eq!(c.plan().period_ms, 100.0);
}

#[test]
fn telemetry_claims__refuses_an_unknown_row_and_a_nonsense_interval_and_adds_nothing() {
    let mut c = claims(false);
    assert!(
        c.claim(&request(&["ports.sensor.9.value"], 100.0), "x")
            .unwrap_err()
            .to_string()
            .contains("ports.sensor.9.value")
    );
    assert!(
        c.claim(&request(&[], 100.0), "x")
            .unwrap_err()
            .to_string()
            .contains("at least one row")
    );
    for interval in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(
            c.claim(&request(&["ports.sensor.1.value"], interval), "x")
                .unwrap_err()
                .to_string()
                .contains("interval")
        );
    }
    assert!(c.plan().rows.is_empty());
}

#[test]
fn telemetry_claims__reads_a_port_in_the_mode_its_claim_asks_for() {
    let mut c = claims(false);
    c.claim(
        &with_modes(request(&["ports.sensor.1.value"], 200.0), &[("1", 2)]),
        "ev3-c",
    )
    .unwrap();
    assert_eq!(
        c.plan()
            .rows
            .iter()
            .find(|r| r.id == "ports.sensor.1.value")
            .unwrap()
            .mode,
        Some(2)
    );
}

#[test]
fn telemetry_claims__lets_the_first_claim_hold_a_ports_mode_and_refuses_another_naming_the_holder()
{
    let mut c = claims(false);
    let first = c
        .claim(
            &with_modes(request(&["ports.sensor.1.value"], 200.0), &[("1", 2)]),
            "ev3-c",
        )
        .unwrap();
    assert!(
        c.claim(
            &with_modes(request(&["ports.sensor.1.value"], 200.0), &[("1", 2)]),
            "ev3-explorer"
        )
        .is_ok()
    );
    let error = c
        .claim(
            &with_modes(request(&["ports.sensor.1.value"], 200.0), &[("1", 0)]),
            "blockly",
        )
        .unwrap_err();
    assert!(
        matches!(error, TelemetryError::ModeConflict(_)) && error.to_string().contains("ev3-c")
    );
    assert_eq!(error.code(), ev3_contract::ErrorCode::ModeConflict);
    c.release(first);
    let error = c
        .claim(
            &with_modes(request(&["ports.sensor.1.value"], 200.0), &[("1", 0)]),
            "blockly",
        )
        .unwrap_err();
    assert!(
        matches!(error, TelemetryError::ModeConflict(_)),
        "another claim still holds the mode"
    );
}

#[test]
fn telemetry_claims__holds_the_mode_of_a_chain_members_port_apart_from_the_masters_port() {
    let mut c = claims(false);
    c.claim(
        &with_modes(request(&["chain.1.sensor.3.value"], 200.0), &[("1:3", 2)]),
        "ev3-c",
    )
    .unwrap();
    assert_eq!(
        c.plan()
            .rows
            .iter()
            .find(|r| r.id == "chain.1.sensor.3.value")
            .unwrap()
            .mode,
        Some(2)
    );
    assert!(matches!(
        c.claim(
            &with_modes(request(&["chain.1.sensor.3.value"], 200.0), &[("1:3", 4)]),
            "blockly"
        ),
        Err(TelemetryError::ModeConflict(_))
    ));
    assert!(
        c.claim(
            &with_modes(request(&["ports.sensor.3.value"], 200.0), &[("3", 4)]),
            "blockly"
        )
        .is_ok()
    );
}

#[test]
fn telemetry_claims__reads_what_a_chain_members_row_needs_to_open() {
    let mut c = claims(false);
    let handle = c
        .claim(&request(&["chain.1.sensor.1.value"], 200.0), "ev3-c")
        .unwrap();
    let planned = ids(&c.plan().rows);
    assert!(planned.contains(&"chain.depth".to_owned()));
    assert!(planned.contains(&"chain.1.sensor.1.occupancy".to_owned()));
    assert_eq!(
        c.grant_of(handle).unwrap().keys().collect::<Vec<_>>(),
        ["chain.1.sensor.1.value"]
    );
    assert!(planned.iter().all(|id| !id.starts_with("chain.2.")));
}

#[test]
fn telemetry_claims__frees_a_ports_mode_when_the_last_claim_holding_it_is_released() {
    let mut c = claims(false);
    let a = c
        .claim(
            &with_modes(request(&["ports.sensor.1.value"], 200.0), &[("1", 2)]),
            "a",
        )
        .unwrap();
    let b = c
        .claim(
            &with_modes(request(&["ports.sensor.1.value"], 200.0), &[("1", 2)]),
            "b",
        )
        .unwrap();
    c.release(a);
    c.release(b);
    assert!(
        c.claim(
            &with_modes(request(&["ports.sensor.1.value"], 200.0), &[("1", 0)]),
            "c"
        )
        .is_ok()
    );
}

#[test]
fn telemetry_claims__does_not_let_the_foreground_hold_a_mode() {
    let mut c = claims(true);
    c.claim(
        &with_modes(request(&["ports.sensor.3.value"], 100.0), &[("3", 1)]),
        "ev3-c",
    )
    .unwrap();
    assert_eq!(
        c.plan()
            .rows
            .iter()
            .find(|r| r.id == "ports.sensor.3.value")
            .unwrap()
            .mode,
        Some(1)
    );
}

#[test]
fn telemetry_claims__refuses_a_mode_for_a_port_without_one_or_outside_0_to_7() {
    let mut c = claims(false);
    assert!(
        c.claim(&with_modes(request(&[TACHO], 100.0), &[("A", 1)]), "x")
            .unwrap_err()
            .to_string()
            .contains("mode")
    );
    // A mode is a whole, non-negative number by type; 8 is the value left to refuse.
    assert!(
        c.claim(
            &with_modes(request(&["ports.sensor.1.value"], 100.0), &[("1", 8)]),
            "x"
        )
        .unwrap_err()
        .to_string()
        .contains("mode")
    );
}

#[test]
fn telemetry_claims__ends_every_claim_at_once_when_the_brick_goes_and_says_which() {
    let mut c = claims(false);
    let a = c
        .claim(
            &with_modes(request(&["ports.sensor.1.value"], 200.0), &[("1", 2)]),
            "a",
        )
        .unwrap();
    let b = c
        .claim(&request(&["system.battery.level"], 1000.0), "b")
        .unwrap();
    let mut ended = c.end_all();
    ended.sort_unstable();
    assert_eq!(ended, [a, b]);
    assert!(c.plan().rows.is_empty());
    assert!(
        c.claim(
            &with_modes(request(&["ports.sensor.1.value"], 200.0), &[("1", 0)]),
            "c"
        )
        .is_ok()
    );
}

// ── brick telemetry ─────────────────────────────────────────────────

/// Records every command and answers frames with zeroed globals, or with `answer`.
struct Recording {
    commands: Mutex<Vec<BrickCommand>>,
    packet: Mutex<Option<usize>>,
    transport: Option<Transport>,
    answer: Box<dyn Fn() -> BrickResponse + Send + Sync>,
}

impl Recording {
    fn new(packet: Option<usize>) -> Arc<Self> {
        Arc::new(Self {
            commands: Mutex::new(Vec::new()),
            packet: Mutex::new(packet),
            transport: Some(Transport::Usb),
            answer: Box::new(|| BrickResponse::TelemetryFrame {
                payload: vec![0; 64],
            }),
        })
    }
}

#[async_trait]
impl TelemetrySender for Recording {
    async fn send(&self, _: &str, command: BrickCommand) -> Result<BrickResponse, TelemetryError> {
        self.commands.lock().unwrap().push(command);
        Ok((self.answer)())
    }
    fn max_packet_bytes(&self, _: &str) -> Option<usize> {
        *self.packet.lock().unwrap()
    }
    fn transport_of(&self, _: &str) -> Option<Transport> {
        self.transport
    }
}

fn brick_loop(
    sender: Arc<dyn TelemetrySender>,
    rows: Vec<TelemetryRow>,
    errors: Option<Arc<Mutex<Vec<TelemetryError>>>>,
) -> BrickTelemetry {
    let mut options = BrickTelemetryOptions::new(sender, A);
    options.rows = Some(rows);
    options.clock = WallClock::starting_at(0);
    options.on_error = errors.map(|errors| {
        Arc::new(move |error: &TelemetryError| errors.lock().unwrap().push(error.clone())) as _
    });
    BrickTelemetry::new(options).unwrap()
}

#[tokio::test]
async fn brick_telemetry_routing__sends_a_composed_frame_as_a_queued_telemetry_frame_command() {
    let host = Recording::new(Some(1024));
    let telemetry = brick_loop(host.clone(), vec![row("a"), row("b")], None);
    telemetry.run_tick().await;
    let commands = host.commands.lock().unwrap();
    assert_eq!(commands.len(), 1, "one frame, one command");
    assert!(
        matches!(&commands[0], BrickCommand::TelemetryFrame { payload } if !payload.is_empty())
    );
    assert_eq!(telemetry.stats().frames_sent, 1);
}

#[tokio::test]
async fn brick_telemetry_routing__refuses_a_reply_that_came_back_as_another_command() {
    let host = Arc::new(Recording {
        commands: Mutex::new(Vec::new()),
        packet: Mutex::new(Some(1024)),
        transport: Some(Transport::Usb),
        answer: Box::new(|| BrickResponse::ProgramStatus {
            running: false,
            status: 0x40,
        }),
    });
    let errors = Arc::new(Mutex::new(Vec::new()));
    let telemetry = brick_loop(host, vec![row("a")], Some(errors.clone()));
    telemetry.run_tick().await;
    let stats = telemetry.stats();
    assert_eq!((stats.frames_sent, stats.frames_failed), (0, 1));
    assert!(
        errors.lock().unwrap()[0]
            .to_string()
            .contains("came back as another command")
    );
}

#[tokio::test]
async fn brick_telemetry_packet_budget__narrows_the_frame_when_the_link_falls_back_to_hid_mid_session()
 {
    let host = Recording::new(Some(1024));
    let rows: Vec<TelemetryRow> = (0..20).map(|i| row(&format!("r{i}")).bytes(4, 4)).collect();
    let telemetry = brick_loop(host.clone(), rows, None);
    telemetry.run_tick().await;
    *host.packet.lock().unwrap() = Some(64);
    telemetry.run_tick().await;
    let commands = host.commands.lock().unwrap();
    let len = |c: &BrickCommand| match c {
        BrickCommand::TelemetryFrame { payload } => payload.len(),
        _ => 0,
    };
    assert_eq!(commands.len(), 2);
    assert!(
        len(&commands[1]) < len(&commands[0]),
        "{} vs {}",
        len(&commands[1]),
        len(&commands[0])
    );
    assert!(len(&commands[1]) + 5 <= 64);
}

#[test]
fn brick_telemetry_packet_budget__falls_back_to_the_hid_size_when_a_usb_link_cannot_say() {
    let host = Recording::new(None);
    assert_eq!(frame_limits_for(host.as_ref(), A).max_packet_bytes, 64);
    let other = Recording {
        transport: Some(Transport::Bt),
        ..Arc::try_unwrap(Recording::new(None)).ok().unwrap()
    };
    assert_eq!(
        frame_limits_for(&other, A).max_packet_bytes,
        1024,
        "the firmware's buffer elsewhere"
    );
}

#[tokio::test]
async fn telemetry_cadence__takes_the_transport_cadence_when_the_caller_names_no_period() {
    let telemetry = brick_loop(Recording::new(Some(1024)), vec![row("a")], None);
    assert_eq!(
        telemetry.tick_period_ms(),
        cadence_for(Some(Transport::Usb)).foreground_ms as f64
    );
}

#[tokio::test]
async fn brick_telemetry__clamps_its_period_to_its_transports_floor_and_says_what_it_granted() {
    let telemetry = brick_loop(Recording::new(Some(1024)), vec![row("a")], None);
    let granted = telemetry.set_period(1.0).unwrap();
    assert_eq!(granted, cadence_for(Some(Transport::Usb)).floor_ms as f64);
    assert_eq!(telemetry.tick_period_ms(), granted);
    assert_eq!(telemetry.set_period(400.0).unwrap(), 400.0);
}

// ── the service ─────────────────────────────────────────────────────

struct World {
    bricks: Arc<FakeBricks>,
    service: TelemetryService,
    events: Arc<Mutex<Vec<TelemetryEvent>>>,
}

fn world(options: TelemetryServiceOptions) -> World {
    let bricks = FakeBricks::new();
    let service = bricks.service(TelemetryServiceOptions {
        start_loops: false,
        clock: WallClock::starting_at(0),
        ..options
    });
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    service.listen(Arc::new(move |event: &TelemetryEvent| {
        sink.lock().unwrap().push(event.clone())
    }));
    World {
        bricks,
        service,
        events,
    }
}

fn plain() -> World {
    world(TelemetryServiceOptions::default())
}

impl World {
    fn rows_of(&self, brick: &str) -> Vec<String> {
        self.service
            .loop_for(brick)
            .map(|l| ids(&l.rows()))
            .unwrap_or_default()
    }

    fn tick_of(&self, brick: &str) -> Option<f64> {
        self.service.loop_for(brick).map(|l| l.tick_period_ms())
    }

    fn ended(&self) -> Vec<(String, Vec<String>)> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                TelemetryEvent::ClaimsEnded { brick_id, handles } => {
                    Some((brick_id.clone(), handles.clone()))
                }
                _ => None,
            })
            .collect()
    }

    fn plans(&self) -> Vec<(String, BTreeMap<String, RowRate>)> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                TelemetryEvent::PlanChanged {
                    brick_id,
                    intervals,
                } => Some((brick_id.clone(), intervals.clone())),
                _ => None,
            })
            .collect()
    }

    fn clear(&self) {
        self.events.lock().unwrap().clear();
    }

    async fn frames(&self, brick: &str, n: usize) {
        for _ in 0..n {
            self.service.loop_for(brick).unwrap().run_tick().await;
        }
    }
}

fn shape(rows: &[TelemetryRow]) -> Vec<(String, Lifetime)> {
    rows.iter().map(|r| (r.id.clone(), r.lifetime)).collect()
}

#[tokio::test]
async fn telemetry_service_who_runs__runs_the_active_connected_brick_in_foreground_and_everything_else_minimal()
 {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.connect(B, Transport::Usb);
    w.bricks.set_active(Some(A));
    assert_eq!(w.service.mode_of(A), ReadMode::Foreground);
    assert_eq!(w.service.mode_of(B), ReadMode::Minimal);
}

#[tokio::test]
async fn telemetry_service_who_runs__hands_the_loop_over_when_the_active_brick_changes() {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.connect(B, Transport::Usb);
    w.bricks.set_active(Some(A));
    w.bricks.set_active(Some(B));
    assert_eq!(w.service.mode_of(A), ReadMode::Minimal);
    assert_eq!(w.service.mode_of(B), ReadMode::Foreground);
}

#[tokio::test]
async fn telemetry_service_who_runs__stops_the_loop_when_the_active_brick_stops_being_connected() {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.set_active(Some(A));
    assert_eq!(w.service.mode_of(A), ReadMode::Foreground);
    w.bricks.lose_link(A);
    assert_eq!(w.service.mode_of(A), ReadMode::Minimal);
    w.bricks.connect(A, Transport::Usb);
    assert_eq!(w.service.mode_of(A), ReadMode::Foreground);
}

#[tokio::test]
async fn telemetry_service_who_runs__leaves_a_transport_that_cannot_execute_frames_alone() {
    let w = plain();
    w.bricks.connect(A, Transport::Tcp);
    w.bricks.set_active(Some(A));
    assert_eq!(w.service.mode_of(A), ReadMode::Minimal);
    assert!(w.service.loop_for(A).is_none());
}

#[tokio::test]
async fn telemetry_service_who_runs__reads_the_bricks_each_client_shows_in_the_foreground() {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.connect(B, Transport::Usb);
    w.bricks.set_active(Some(A));
    w.service
        .set_foreground_bricks(Some(HashSet::from([B.to_owned()])));
    assert_eq!(w.service.mode_of(A), ReadMode::Minimal);
    assert_eq!(w.service.mode_of(B), ReadMode::Foreground);
    w.service.set_foreground_bricks(None);
    assert_eq!(
        w.service.mode_of(A),
        ReadMode::Foreground,
        "back to the active brick"
    );
    assert_eq!(w.service.mode_of(B), ReadMode::Minimal);
}

#[tokio::test]
async fn telemetry_service_claims__reads_the_active_brick_every_row_sampled_each_tick_event_every_fifth_static_once()
 {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.set_active(Some(A));
    let rows = w.service.loop_for(A).unwrap().rows();
    let expected = claims(true).plan().rows;
    assert_eq!(shape(&rows), shape(&expected));
    assert_eq!(w.tick_of(A), Some(100.0));
}

#[tokio::test]
async fn telemetry_service_claims__runs_a_second_loop_for_a_claimed_brick_that_is_not_active() {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.connect(B, Transport::Usb);
    w.bricks.set_active(Some(A));
    let ticket = w
        .service
        .claim(B, &request(&[TACHO], 400.0), "ev3-c")
        .unwrap();
    assert_eq!(w.service.mode_of(A), ReadMode::Foreground);
    assert_eq!(w.service.mode_of(B), ReadMode::Subscribed);
    assert_eq!(w.rows_of(B), [TACHO]);
    assert_eq!(w.tick_of(B), Some(400.0));
    assert_eq!(ticket.grant, grant(&[(TACHO, RowRate::Every(400.0))]));
    assert_eq!(
        w.service.grant_of(&ticket.handle),
        Some(grant(&[(TACHO, RowRate::Every(400.0))]))
    );
}

#[tokio::test]
async fn telemetry_service_claims__stands_a_brick_down_to_minimal_when_its_last_claim_is_released()
{
    let w = plain();
    w.bricks.connect(B, Transport::Usb);
    let first = w
        .service
        .claim(B, &request(&["system.battery.level"], 1000.0), "one")
        .unwrap();
    let second = w
        .service
        .claim(B, &request(&[TACHO], 200.0), "two")
        .unwrap();
    w.service.release(&second.handle);
    assert_eq!(w.service.mode_of(B), ReadMode::Subscribed);
    assert_eq!(w.rows_of(B), ["system.battery.level"]);
    assert_eq!(
        w.tick_of(B),
        Some(1000.0),
        "the tick follows the claims that remain"
    );
    w.service.release(&first.handle);
    assert_eq!(w.service.mode_of(B), ReadMode::Minimal);
    assert!(w.service.loop_for(B).is_none());
    w.service.release(&first.handle);
    assert!(w.service.grant_of(&first.handle).is_none());
}

#[tokio::test]
async fn telemetry_service_claims__keeps_one_loop_through_the_active_brick_leaving_and_coming_back()
{
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.connect(B, Transport::Usb);
    w.bricks.set_active(Some(A));
    w.service
        .claim(A, &request(&[TACHO], 300.0), "ev3-c")
        .unwrap();
    let first = w.service.loop_for(A).unwrap();

    w.bricks.set_active(Some(B));
    assert!(
        w.service.loop_for(A).unwrap().is_same(&first),
        "re-planned, not restarted"
    );
    assert_eq!(w.service.mode_of(A), ReadMode::Subscribed);
    assert_eq!(w.rows_of(A), [TACHO]);
    assert_eq!(w.tick_of(A), Some(300.0));
    assert_eq!(w.service.mode_of(B), ReadMode::Foreground);

    w.bricks.set_active(Some(A));
    assert!(w.service.loop_for(A).unwrap().is_same(&first));
    assert_eq!(w.service.mode_of(A), ReadMode::Foreground);
    assert_eq!(w.rows_of(A).len(), ev3_row_registry().all().len());
    assert_eq!(w.tick_of(A), Some(100.0));
    assert_eq!(w.service.mode_of(B), ReadMode::Minimal);
}

#[tokio::test]
async fn telemetry_service_claims__keeps_the_claims_while_the_link_is_lost_and_reads_them_again_when_it_is_back()
 {
    let w = plain();
    w.bricks.connect(B, Transport::Usb);
    let ticket = w
        .service
        .claim(B, &request(&[TACHO], 200.0), "ev3-c")
        .unwrap();
    w.bricks.lose_link(B);
    assert!(w.service.loop_for(B).is_none());
    assert_eq!(w.service.mode_of(B), ReadMode::Minimal);
    assert_eq!(
        w.service.grant_of(&ticket.handle),
        Some(grant(&[(TACHO, RowRate::Every(200.0))]))
    );
    w.bricks.connect(B, Transport::Usb);
    assert_eq!(w.service.mode_of(B), ReadMode::Subscribed);
    assert_eq!(w.rows_of(B), [TACHO]);
    assert!(w.ended().is_empty());
}

#[tokio::test]
async fn telemetry_service_claims__ends_every_claim_on_a_brick_that_disconnects_and_says_which() {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.connect(B, Transport::Usb);
    let on_b = w
        .service
        .claim(B, &request(&[TACHO], 200.0), "ev3-c")
        .unwrap();
    let on_a = w
        .service
        .claim(A, &request(&[TACHO], 200.0), "ev3-c")
        .unwrap();
    w.bricks.disconnect(B);
    assert_eq!(w.ended(), [(B.to_owned(), vec![on_b.handle.clone()])]);
    assert!(w.service.grant_of(&on_b.handle).is_none());
    assert!(w.service.loop_for(B).is_none());
    assert_eq!(w.service.mode_of(B), ReadMode::None);
    assert_eq!(w.service.mode_of(A), ReadMode::Subscribed);
    w.bricks.connect(B, Transport::Usb);
    assert_eq!(
        w.service.mode_of(B),
        ReadMode::Minimal,
        "an ended claim does not come back"
    );
    assert!(w.service.grant_of(&on_a.handle).is_some());
}

#[tokio::test]
async fn telemetry_service_claims__ends_the_claims_of_a_brick_that_is_signed_out_once() {
    let w = plain();
    w.bricks.connect(B, Transport::Usb);
    let ticket = w
        .service
        .claim(B, &request(&[TACHO], 200.0), "ev3-c")
        .unwrap();
    w.bricks.sign_out(B);
    assert_eq!(
        w.ended(),
        [(B.to_owned(), vec![ticket.handle])],
        "ended once, not per event"
    );
    assert_eq!(w.service.mode_of(B), ReadMode::None);
}

#[tokio::test]
async fn telemetry_service_claims__says_nothing_when_the_active_brick_goes_with_no_claim_on_it() {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.set_active(Some(A));
    w.bricks.sign_out(A);
    assert!(w.ended().is_empty());
    assert!(w.service.loop_for(A).is_none());
}

#[tokio::test]
async fn telemetry_service_claims__restarts_a_claimed_brick_at_its_new_transports_floor_the_grant_stays()
 {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.connect(B, Transport::Usb);
    w.bricks.set_active(Some(A));
    let ticket = w
        .service
        .claim(B, &request(&[TACHO], 100.0), "ev3-c")
        .unwrap();
    let before = w.service.loop_for(B).unwrap();
    w.bricks.move_route(B, Transport::Bt);
    let after = w.service.loop_for(B).unwrap();
    assert!(
        !after.is_same(&before),
        "the loop is built for one transport"
    );
    assert_eq!(after.tick_period_ms(), 250.0);
    assert_eq!(
        w.service.grant_of(&ticket.handle),
        Some(grant(&[(TACHO, RowRate::Every(100.0))]))
    );
}

#[tokio::test]
async fn telemetry_service_claims__grants_a_claim_against_the_bricks_transport_now() {
    let w = plain();
    w.bricks.connect(B, Transport::Usb);
    let first = w
        .service
        .claim(B, &request(&[TACHO], 200.0), "ev3-c")
        .unwrap();
    w.service.release(&first.handle);
    w.bricks.move_route(B, Transport::Bt);
    let ticket = w
        .service
        .claim(B, &request(&[TACHO], 10.0), "ev3-c")
        .unwrap();
    assert_eq!(
        ticket.grant,
        grant(&[(TACHO, RowRate::Every(250.0))]),
        "Bluetooth's floor, not USB's 50 ms"
    );
}

#[tokio::test(start_paused = true)]
async fn telemetry_service_claims__sends_a_restarted_loops_first_frame_only_after_the_retired_loops_frame_settled()
 {
    let w = plain();
    w.bricks.connect(B, Transport::Usb);
    w.service
        .claim(B, &request(&[TACHO], 200.0), "ev3-c")
        .unwrap();
    w.bricks.hold_sends();
    let retired_loop = w.service.loop_for(B).unwrap();
    let retired = tokio::spawn(async move { retired_loop.run_tick().await });
    support_telemetry::flush().await;
    w.bricks.move_route(B, Transport::Bt);
    let fresh_loop = w.service.loop_for(B).unwrap();
    let fresh = tokio::spawn(async move { fresh_loop.run_tick().await });
    support_telemetry::flush().await;
    assert_eq!(
        w.bricks.sent(),
        1,
        "one frame outstanding for the brick, not two"
    );

    w.bricks.release_sends();
    retired.await.unwrap();
    support_telemetry::flush().await;
    assert_eq!(
        w.bricks.sent(),
        2,
        "the new loop's frame goes once the retired one settled"
    );
    w.bricks.release_sends();
    fresh.await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn telemetry_service_claims__sends_nothing_for_a_loop_retired_or_a_service_disposed_while_its_frame_waited()
 {
    let w = plain();
    w.bricks.connect(B, Transport::Usb);
    w.service
        .claim(B, &request(&[TACHO], 200.0), "ev3-c")
        .unwrap();
    w.bricks.hold_sends();
    let tick = |w: &World| {
        let l = w.service.loop_for(B).unwrap();
        tokio::spawn(async move { l.run_tick().await })
    };
    tick(&w);
    support_telemetry::flush().await;
    w.bricks.move_route(B, Transport::Bt);
    tick(&w); // waits behind the first frame
    support_telemetry::flush().await;
    w.bricks.move_route(B, Transport::Usb); // and its loop is retired meanwhile
    tick(&w);
    support_telemetry::flush().await;

    w.bricks.release_sends();
    support_telemetry::flush().await;
    assert_eq!(
        w.bricks.sent(),
        2,
        "the first frame and the current loop's, not the retired one's"
    );
    let errors = w
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, TelemetryEvent::Error { .. }))
        .count();
    assert_eq!(
        errors, 0,
        "a retired loop's refused frame is nobody's failure"
    );

    w.bricks.hold_sends();
    tick(&w);
    support_telemetry::flush().await;
    assert_eq!(w.bricks.sent(), 3);
    w.bricks.move_route(B, Transport::Bt);
    tick(&w); // waits behind the held frame
    support_telemetry::flush().await;
    w.service.dispose();
    w.bricks.release_sends();
    support_telemetry::flush().await;
    assert_eq!(
        w.bricks.sent(),
        3,
        "nothing goes out for a disposed service"
    );
}

#[tokio::test]
async fn telemetry_service_claims__says_which_rows_a_brick_reads_and_how_often_whenever_that_changes()
 {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.set_active(Some(A));
    let (brick, foreground) = w.plans().pop().unwrap();
    assert_eq!(brick, A);
    assert_eq!(foreground[TACHO], RowRate::Every(100.0));
    assert_eq!(foreground["system.battery.level"], RowRate::Every(500.0));
    assert_eq!(foreground["system.firmwareVersion"], RowRate::Once);
    assert_eq!(
        w.service.current_plans()[A][TACHO],
        RowRate::Every(100.0),
        "a reader attached later learns it too"
    );

    w.clear();
    w.bricks.move_route(A, Transport::Usb);
    assert!(
        w.plans().is_empty(),
        "a refresh that changes nothing announces nothing"
    );

    w.service
        .claim(A, &request(&[TACHO], 50.0), "ev3-c")
        .unwrap();
    assert_eq!(
        w.plans().pop().unwrap().1["system.battery.level"],
        RowRate::Every(500.0),
        "still every 500 ms on a 50 ms tick"
    );

    w.bricks.set_active(None);
    assert_eq!(
        w.plans().pop().unwrap().1,
        grant(&[(TACHO, RowRate::Every(50.0))])
    );

    w.bricks.lose_link(A);
    assert_eq!(w.plans().pop().unwrap(), (A.to_owned(), BTreeMap::new()));
}

#[tokio::test]
async fn telemetry_service_claims__says_once_that_a_brick_it_read_has_no_session_any_more() {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.connect(B, Transport::Usb);
    w.bricks.set_active(Some(A));
    w.bricks.sign_out(A);
    w.bricks.disconnect(B);
    let gone: Vec<String> = w
        .events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            TelemetryEvent::SessionEnded { brick_id } => Some(brick_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(gone, [A]);
}

const THROTTLE: ThrottleSettings = ThrottleSettings {
    enabled: true,
    window_size: 5,
    tail_factor: 3.0,
    step: 1.5,
    max_slowdown: 4.0,
    calm_windows: 2,
};

fn throttled(settings: Option<ThrottleSettings>) -> World {
    world(TelemetryServiceOptions {
        throttle: settings,
        ..TelemetryServiceOptions::default()
    })
}

#[tokio::test(start_paused = true)]
async fn telemetry_service_claims__does_not_count_a_retired_loops_round_trip_against_the_new_link()
{
    let w = throttled(Some(THROTTLE));
    w.bricks.connect(B, Transport::Usb);
    w.service
        .claim(B, &request(&[TACHO], 200.0), "ev3-c")
        .unwrap();
    w.bricks.hold_sends();
    let retired_loop = w.service.loop_for(B).unwrap();
    let retired = tokio::spawn(async move { retired_loop.run_tick().await });
    support_telemetry::flush().await;
    w.bricks.move_route(B, Transport::Bt);
    w.bricks.release_sends();
    retired.await.unwrap();
    assert_eq!(w.service.throttle_of(B).unwrap().throttle.window_samples, 0);
}

#[tokio::test]
async fn telemetry_service_claims__refuses_a_claim_that_could_never_be_read_and_adds_nothing() {
    let w = plain();
    let error = w
        .service
        .claim(B, &request(&[TACHO], 200.0), "ev3-c")
        .unwrap_err();
    assert_eq!(error.code(), ev3_contract::ErrorCode::NotConnected);
    w.bricks.connect(B, Transport::Tcp);
    let error = w
        .service
        .claim(B, &request(&[TACHO], 200.0), "ev3-c")
        .unwrap_err();
    assert_eq!(
        error.code(),
        ev3_contract::ErrorCode::SubscriptionFailed,
        "a link without telemetry frames"
    );
    assert_eq!(w.service.mode_of(B), ReadMode::Minimal);
}

#[tokio::test]
async fn telemetry_service_claims__gives_every_claim_its_own_handle_across_bricks() {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.connect(B, Transport::Usb);
    let on_a = w
        .service
        .claim(A, &request(&[TACHO], 200.0), "ev3-c")
        .unwrap();
    let on_b = w
        .service
        .claim(B, &request(&[TACHO], 200.0), "ev3-c")
        .unwrap();
    assert_ne!(on_a.handle, on_b.handle);
    w.service.release(&on_a.handle);
    assert_eq!(w.service.mode_of(A), ReadMode::Minimal);
    assert_eq!(w.service.mode_of(B), ReadMode::Subscribed);
}

#[tokio::test]
async fn telemetry_service_claims__does_not_read_a_static_row_again_for_a_claim_made_after_the_foreground_read_it()
 {
    let w = plain();
    w.bricks.connect(A, Transport::Usb);
    w.bricks.set_active(Some(A));
    let read = || -> Vec<String> {
        w.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                TelemetryEvent::Values { values, .. } => {
                    Some(values.iter().map(|v| v.row_id.clone()).collect::<Vec<_>>())
                }
                _ => None,
            })
            .flatten()
            .collect()
    };
    w.frames(A, 1).await;
    assert!(read().contains(&"system.firmwareVersion".to_owned()));
    w.clear();
    let ticket = w
        .service
        .claim(A, &request(&["system.firmwareVersion"], 1000.0), "info")
        .unwrap();
    w.frames(A, 2).await;
    assert_eq!(
        ticket.grant,
        grant(&[("system.firmwareVersion", RowRate::Once)])
    );
    assert!(!read().contains(&"system.firmwareVersion".to_owned()));
}

#[tokio::test]
async fn telemetry_service_claims__keeps_a_tick_override_for_the_foreground_below_the_floor_also_when_re_planned()
 {
    let w = world(TelemetryServiceOptions {
        tick_period_ms: Some(20.0),
        ..TelemetryServiceOptions::default()
    });
    w.bricks.connect(A, Transport::Usb);
    w.bricks.connect(B, Transport::Usb);
    w.bricks.set_active(Some(A));
    assert_eq!(w.tick_of(A), Some(20.0));
    w.service
        .claim(A, &request(&[TACHO], 300.0), "ev3-c")
        .unwrap();
    w.bricks.set_active(Some(B));
    w.bricks.set_active(Some(A));
    assert_eq!(w.tick_of(A), Some(20.0));
}

// ── telemetry service — throttling ──────────────────────────────────

fn latency(w: &World, brick: &str, ms: u64) {
    w.bricks
        .state()
        .latency
        .insert(brick.to_owned(), Duration::from_millis(ms));
}

fn both_connected(w: &World) {
    w.bricks.connect(A, Transport::Usb);
    w.bricks.connect(B, Transport::Usb);
    latency(w, A, 5);
    latency(w, B, 5);
}

#[tokio::test(start_paused = true)]
async fn telemetry_service_throttling__slows_a_brick_whose_round_trips_grow_and_says_so() {
    let w = throttled(Some(THROTTLE));
    both_connected(&w);
    w.service
        .claim(B, &request(&[TACHO], 100.0), "ev3-c")
        .unwrap();
    latency(&w, B, 40);
    w.clear();
    w.frames(B, 5).await;
    assert_eq!(w.tick_of(B), Some(150.0));
    assert_eq!(
        w.plans().pop().unwrap().1[TACHO],
        RowRate::Every(150.0),
        "the effective interval moves with it"
    );
    let changes: Vec<TelemetryEvent> = w
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|e| matches!(e, TelemetryEvent::ThrottleChanged { .. }))
        .cloned()
        .collect();
    assert!(
        matches!(changes.last(), Some(TelemetryEvent::ThrottleChanged { brick_id, .. }) if brick_id == B)
    );
    let state = w.service.throttle_of(B).unwrap();
    assert_eq!(
        (
            state.throttle.factor,
            state.throttle.limit_ms,
            state.throttle.p95_ms,
            state.throttle.stalls,
            state.throttle.window_samples,
            state.base_period_ms,
            state.period_ms
        ),
        (1.5, 30.0, Some(40.0), 5, 0, 100.0, 150.0)
    );
}

#[tokio::test(start_paused = true)]
async fn telemetry_service_throttling__does_not_slow_one_brick_for_anothers_slowness() {
    let w = throttled(Some(THROTTLE));
    both_connected(&w);
    w.service
        .claim(A, &request(&[TACHO], 100.0), "ev3-c")
        .unwrap();
    w.service
        .claim(B, &request(&[TACHO], 100.0), "ev3-c")
        .unwrap();
    latency(&w, B, 40);
    w.frames(A, 5).await;
    w.frames(B, 5).await;
    assert_eq!(w.tick_of(A), Some(100.0));
    assert_eq!(w.tick_of(B), Some(150.0));
}

#[tokio::test(start_paused = true)]
async fn telemetry_service_throttling__speeds_back_up_when_the_brick_recovers_to_the_plans_tick_and_no_faster()
 {
    let w = throttled(Some(THROTTLE));
    both_connected(&w);
    w.service
        .claim(B, &request(&[TACHO], 100.0), "ev3-c")
        .unwrap();
    latency(&w, B, 40);
    w.frames(B, 5).await;
    latency(&w, B, 5);
    w.frames(B, 10).await;
    assert_eq!(w.tick_of(B), Some(100.0));
    assert_eq!(w.service.throttle_of(B).unwrap().throttle.factor, 1.0);
}

#[tokio::test(start_paused = true)]
async fn telemetry_service_throttling__keeps_the_bricks_slowdown_through_a_re_plan() {
    let w = throttled(Some(THROTTLE));
    both_connected(&w);
    w.service
        .claim(B, &request(&[TACHO], 100.0), "ev3-c")
        .unwrap();
    latency(&w, B, 40);
    w.frames(B, 5).await;
    w.service
        .claim(B, &request(&[TACHO], 60.0), "ev3-c")
        .unwrap();
    assert_eq!(w.tick_of(B), Some(90.0), "60 ms planned, 1.5 times slower");
}

#[tokio::test(start_paused = true)]
async fn telemetry_service_throttling__follows_a_settings_change_at_once() {
    let w = throttled(Some(THROTTLE));
    both_connected(&w);
    w.service
        .claim(B, &request(&[TACHO], 100.0), "ev3-c")
        .unwrap();
    latency(&w, B, 40);
    w.frames(B, 5).await;
    w.service
        .configure_throttle(ThrottleSettings {
            enabled: false,
            ..THROTTLE
        })
        .unwrap();
    assert_eq!(w.tick_of(B), Some(100.0));
    assert_eq!(w.plans().pop().unwrap().1[TACHO], RowRate::Every(100.0));
}

#[tokio::test]
async fn telemetry_service_throttling__refuses_settings_out_of_range_even_when_no_brick_is_read_yet()
 {
    let w = throttled(None);
    let error = w
        .service
        .configure_throttle(ThrottleSettings {
            step: 1.0,
            ..THROTTLE
        })
        .unwrap_err();
    assert!(error.to_string().contains("step"));
}

#[tokio::test(start_paused = true)]
async fn telemetry_service_throttling__does_not_throttle_without_throttle_settings() {
    let w = throttled(None);
    both_connected(&w);
    w.service
        .claim(B, &request(&[TACHO], 100.0), "ev3-c")
        .unwrap();
    latency(&w, B, 400);
    w.frames(B, 10).await;
    assert_eq!(w.tick_of(B), Some(100.0));
    assert!(w.service.throttle_of(B).is_none());
}

#[tokio::test(start_paused = true)]
async fn telemetry_service_throttling__counts_the_wait_in_the_queue_in_the_round_trip() {
    // A brick busy with something else is a brick to slow down for: the round trip runs from
    // handing the frame to the queue to its answer, wait included.
    let w = throttled(Some(THROTTLE));
    w.bricks.connect(B, Transport::Usb);
    w.service
        .claim(B, &request(&[TACHO], 100.0), "ev3-c")
        .unwrap();
    for _ in 0..5 {
        w.bricks.hold_sends();
        let l = w.service.loop_for(B).unwrap();
        let tick = tokio::spawn(async move { l.run_tick().await });
        support_telemetry::flush().await;
        tokio::time::advance(Duration::from_millis(40)).await;
        w.bricks.release_sends();
        tick.await.unwrap();
    }
    assert_eq!(w.tick_of(B), Some(150.0));
}

// ── telemetry while a program runs ──────────────────────────────────

/// A brick on `transport` whose every global byte says whether a program runs.
fn programmed(tick_ms: f64, transport: Transport) -> (World, Arc<Mutex<bool>>) {
    let w = world(TelemetryServiceOptions {
        program_preset: Some(ProgramPresetSettings {
            program_running_tick_ms: tick_ms,
        }),
        ..TelemetryServiceOptions::default()
    });
    let running = Arc::new(Mutex::new(false));
    let flag = running.clone();
    w.bricks.reply_with(move |_, _| {
        let byte = if *flag.lock().unwrap() {
            program_status::RUNNING
        } else {
            program_status::STOPPED
        };
        BrickResponse::TelemetryFrame {
            payload: vec![byte; 1024],
        }
    });
    w.bricks.connect(A, transport);
    w.bricks.set_active(Some(A));
    (w, running)
}

#[tokio::test]
async fn telemetry_while_a_program_runs__slows_the_loop_to_the_floor_while_the_program_row_says_running()
 {
    let (w, running) = programmed(200.0, Transport::Usb);
    assert_eq!(w.tick_of(A), Some(100.0));
    *running.lock().unwrap() = true;
    w.frames(A, 5).await;
    assert_eq!(w.tick_of(A), Some(200.0));
    assert_eq!(w.plans().pop().unwrap().1[TACHO], RowRate::Every(200.0));
    *running.lock().unwrap() = false;
    w.frames(A, 5).await;
    assert_eq!(w.tick_of(A), Some(100.0));
    assert_eq!(w.plans().pop().unwrap().1[TACHO], RowRate::Every(100.0));
}

#[tokio::test]
async fn telemetry_while_a_program_runs__leaves_a_tick_that_is_already_slower_than_the_floor() {
    let (w, running) = programmed(200.0, Transport::Bt);
    assert_eq!(w.tick_of(A), Some(500.0));
    *running.lock().unwrap() = true;
    w.frames(A, 5).await;
    assert_eq!(w.tick_of(A), Some(500.0));
}

#[tokio::test]
async fn telemetry_while_a_program_runs__does_nothing_with_the_preset_at_0() {
    let (w, running) = programmed(0.0, Transport::Usb);
    *running.lock().unwrap() = true;
    w.frames(A, 5).await;
    assert_eq!(w.tick_of(A), Some(100.0));
}

#[tokio::test]
async fn telemetry_while_a_program_runs__applies_a_changed_setting_at_once_and_refuses_one_out_of_range()
 {
    let (w, running) = programmed(200.0, Transport::Usb);
    *running.lock().unwrap() = true;
    w.frames(A, 5).await;
    w.service
        .configure_program_preset(ProgramPresetSettings {
            program_running_tick_ms: 300.0,
        })
        .unwrap();
    assert_eq!(w.tick_of(A), Some(300.0));
    w.service
        .configure_program_preset(ProgramPresetSettings {
            program_running_tick_ms: 0.0,
        })
        .unwrap();
    assert_eq!(
        w.tick_of(A),
        Some(100.0),
        "turned off while the program still runs"
    );
    let error = w
        .service
        .configure_program_preset(ProgramPresetSettings {
            program_running_tick_ms: -1.0,
        })
        .unwrap_err();
    assert!(error.to_string().contains("programRunningTickMs"));
}
