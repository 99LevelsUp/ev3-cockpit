//! The base-tick scheduler. Ports of `telemetryScheduler.test.ts` and `schedulerSchedule.test.ts`.
//! Names are `<describe>__<it>` in snake case.
//!
//! The stalled-brick case matters most: a wall-clock scheduler against a serial queue lets frames
//! pile up while the brick is busy, and the heartbeat then misses its window and trips a reconnect
//! on a brick that was only slow.

#![allow(non_snake_case)]

mod support_telemetry;

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ev3_runtime::telemetry::assembler::FrameLimits;
use ev3_runtime::telemetry::ev3_rows::{chain_depth_row, sensor_occupancy_row, sensor_value_row};
use ev3_runtime::telemetry::scheduler::SETTLE_LIMIT;
use ev3_runtime::telemetry::{
    Lifetime, PortState, Reading, RowValue, SchedulerOptions, TelemetryError, TelemetryRow,
    TelemetryScheduler, Tier, WallClock,
};
use support_telemetry::{ChainBrick, HID, LIBUSB, RowExt, TestLink, float_reply, flush, row};

struct World {
    scheduler: TelemetryScheduler,
    link: TestLink,
    seen: Arc<Mutex<Vec<Vec<RowValue>>>>,
    errors: Arc<Mutex<Vec<TelemetryError>>>,
}

impl World {
    fn new(rows: Vec<TelemetryRow>, link: TestLink) -> Self {
        Self::with_period(rows, link, 10.0)
    }

    fn with_period(rows: Vec<TelemetryRow>, link: TestLink, period: f64) -> Self {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let errors = Arc::new(Mutex::new(Vec::new()));
        let (s, e) = (seen.clone(), errors.clone());
        let scheduler = TelemetryScheduler::new(SchedulerOptions {
            rows,
            link: link.as_link(),
            tick_period_ms: period,
            on_values: Some(Arc::new(move |values: &[RowValue]| {
                s.lock().unwrap().push(values.to_vec())
            })),
            on_error: Some(Arc::new(move |error: &TelemetryError| {
                e.lock().unwrap().push(error.clone())
            })),
            clock: WallClock::starting_at(0),
        })
        .unwrap();
        Self {
            scheduler,
            link,
            seen,
            errors,
        }
    }

    async fn ticks(&self, n: usize) {
        for _ in 0..n {
            self.scheduler.run_tick().await;
        }
    }

    /// A tick left running on a task of its own, as the timer runs it.
    fn spawn_tick(&self) -> tokio::task::JoinHandle<()> {
        let scheduler = self.scheduler.clone();
        tokio::spawn(async move { scheduler.run_tick().await })
    }

    /// Row ids per delivery, in delivery order.
    fn ids(&self) -> Vec<Vec<String>> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|vs| vs.iter().map(|v| v.row_id.clone()).collect())
            .collect()
    }

    /// Row ids per delivery, sorted.
    fn sorted(&self) -> Vec<Vec<String>> {
        self.ids()
            .into_iter()
            .map(|mut ids| {
                ids.sort();
                ids
            })
            .collect()
    }

    /// `id=value` per delivery, sorted.
    fn delivered(&self) -> Vec<Vec<String>> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|vs| {
                let mut out: Vec<String> = vs.iter().map(show).collect();
                out.sort();
                out
            })
            .collect()
    }
}

fn show(value: &RowValue) -> String {
    match &value.value {
        Reading::Number(n) => format!("{}={n}", value.row_id),
        other => format!("{}={other:?}", value.row_id),
    }
}

fn s(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

fn link() -> TestLink {
    TestLink::new(LIBUSB)
}

fn filled(limits: FrameLimits, byte: Arc<Mutex<u8>>) -> TestLink {
    TestLink::answering(limits, move |_| Ok(vec![*byte.lock().unwrap(); 64]))
}

/// A link whose n-th reply carries `floats[n-1]` (the last one again after the end) at offset 0,
/// and fails the calls listed.
fn floats(values: &[f32], fail: &[usize]) -> TestLink {
    let values = values.to_vec();
    let fail = fail.to_vec();
    let mut call = 0;
    TestLink::answering(LIBUSB, move |_| {
        call += 1;
        if fail.contains(&call) {
            return Err(TelemetryError::Frame("lost".into()));
        }
        Ok(float_reply(values[(call - 1).min(values.len() - 1)]))
    })
}

fn sensor(id: &str, mode: u8) -> TelemetryRow {
    row(id).bytes(4, 4).port("1").mode(mode)
}

// ── scheduler — dividers ────────────────────────────────────────────

#[tokio::test]
async fn scheduler_dividers__includes_a_divider_1_row_every_tick_and_a_divider_3_row_every_third() {
    let w = World::new(vec![row("fast"), row("slow").every(3)], link());
    w.ticks(6).await;
    assert_eq!(
        w.sorted(),
        [
            s(&["fast", "slow"]),
            s(&["fast"]),
            s(&["fast"]),
            s(&["fast", "slow"]),
            s(&["fast"]),
            s(&["fast"])
        ]
    );
    assert_eq!(w.link.calls(), 6, "both sampled, so one command a tick");
}

#[tokio::test]
async fn scheduler_dividers__never_schedules_a_row_switched_off() {
    let w = World::new(vec![row("off").off()], link());
    w.ticks(5).await;
    assert_eq!(w.link.calls(), 0);
    assert_eq!(w.scheduler.stats().ticks_empty, 5);
}

#[tokio::test]
async fn scheduler_dividers__reads_a_one_shot_row_once_and_then_retires_it() {
    let w = World::new(vec![row("once").once(), row("always")], link());
    w.ticks(4).await;
    let all: Vec<String> = w.ids().into_iter().flatten().collect();
    assert_eq!(all.iter().filter(|id| *id == "once").count(), 1);
    assert_eq!(all.iter().filter(|id| *id == "always").count(), 4);
}

// ── scheduler — one frame in flight ─────────────────────────────────

#[tokio::test(start_paused = true)]
async fn scheduler_one_frame_in_flight__skips_a_tick_that_arrives_while_the_previous_frame_is_outstanding()
 {
    let w = World::new(vec![row("r")], link());
    w.link.hold(&[1]);
    let first = w.spawn_tick();
    flush().await;
    w.ticks(4).await;
    assert_eq!(
        w.link.calls(),
        1,
        "the stalled brick received exactly one frame"
    );
    assert_eq!(w.scheduler.stats().ticks_skipped, 4);

    w.link.release();
    first.await.unwrap();
    w.ticks(1).await;
    assert_eq!(w.link.calls(), 2);
}

#[tokio::test(start_paused = true)]
async fn scheduler_one_frame_in_flight__keeps_counting_ticks_while_it_stands_down() {
    let w = World::new(vec![row("slow").every(3)], link());
    w.link.hold(&[1]);
    let first = w.spawn_tick();
    flush().await;
    w.ticks(3).await;
    w.link.release();
    first.await.unwrap();

    assert_eq!(w.scheduler.stats().ticks, 4);
    // A skipped tick is a later sample, never a queued one: tick 4 is no multiple of 3, so the
    // slow row does not come up again at once.
    w.ticks(1).await;
    assert_eq!(
        w.ids().len(),
        1,
        "the slow row did not come up again on tick 4"
    );
    assert_eq!(w.link.calls(), 1);
}

#[tokio::test]
async fn scheduler_one_frame_in_flight__releases_the_in_flight_flag_when_a_send_fails() {
    let link = TestLink::answering(LIBUSB, |_| {
        Err(TelemetryError::Frame("link went away".into()))
    });
    let w = World::new(vec![row("r")], link);
    w.ticks(2).await;
    assert_eq!(
        w.link.calls(),
        2,
        "a failed frame must not wedge the scheduler shut"
    );
    assert_eq!(w.errors.lock().unwrap().len(), 2);
    assert_eq!(w.scheduler.stats().frames_failed, 2);
}

#[tokio::test(start_paused = true)]
async fn scheduler_one_frame_in_flight__ticks_on_the_timer_skip_while_a_frame_is_out() {
    // The timer keeps ticking while a frame is out; each of those ticks stands down, counted, and
    // none of them is sent later.
    let w = World::with_period(vec![row("r")], link(), 100.0);
    w.link.hold(&[1]);
    w.scheduler.start();
    tokio::time::sleep(Duration::from_millis(550)).await;
    assert_eq!(w.link.calls(), 1);
    let stats = w.scheduler.stats();
    assert_eq!((stats.ticks, stats.ticks_skipped), (5, 4));

    w.link.release();
    flush().await;
    assert_eq!(
        w.link.calls(),
        1,
        "no skipped tick was queued behind the stalled frame"
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(w.link.calls(), 2, "the next tick of the timer sends");
    w.scheduler.dispose();
}

// ── scheduler — rotating truncation ─────────────────────────────────

fn wide_rows(n: usize) -> Vec<TelemetryRow> {
    (0..n).map(|i| row(&format!("r{i}")).bytes(4, 4)).collect()
}

#[tokio::test]
async fn scheduler_rotating_truncation__gives_a_row_deferred_by_one_tick_the_front_of_the_next() {
    let rows = wide_rows(20);
    let w = World::new(rows.clone(), TestLink::new(HID));
    w.ticks(2).await;
    let ids = w.ids();
    assert!(ids[0].len() < 20, "HID could not carry every row");
    let losers: Vec<&String> = rows
        .iter()
        .map(|r| &r.id)
        .filter(|id| !ids[0].contains(id))
        .collect();
    for id in losers.iter().take(ids[1].len()) {
        assert!(ids[1].contains(id), "{id} lost twice in a row");
    }
}

#[tokio::test]
async fn scheduler_rotating_truncation__serves_every_row_within_a_few_ticks() {
    let w = World::new(wide_rows(20), TestLink::new(HID));
    w.ticks(5).await;
    let ever: std::collections::HashSet<String> = w.ids().into_iter().flatten().collect();
    assert_eq!(ever.len(), 20, "static priority starves the rest");
}

// ── scheduler — the occupancy gate ──────────────────────────────────

fn gate_rows() -> Vec<TelemetryRow> {
    vec![
        row("ports.sensor.1.value").bytes(4, 4).port("1").mode(0),
        row("ports.sensor.1.occupancy").port("1").occupancy(),
    ]
}

#[tokio::test]
async fn scheduler_the_occupancy_gate__stops_reading_a_value_once_its_port_reports_a_still_identifying_device()
 {
    // The whole reply is the type code, rather than a code at a guessed offset.
    let w = World::new(gate_rows(), filled(LIBUSB, Arc::new(Mutex::new(125))));
    w.ticks(2).await;
    let ids = w.ids();
    assert!(
        ids[0].contains(&"ports.sensor.1.value".to_owned()),
        "nothing was known yet"
    );
    assert!(!ids[1].contains(&"ports.sensor.1.value".to_owned()));
    assert!(
        ids[1].contains(&"ports.sensor.1.occupancy".to_owned()),
        "the occupancy row is never gated"
    );
}

#[tokio::test]
async fn scheduler_the_occupancy_gate__reads_the_value_again_once_the_device_finishes_identifying()
{
    let reported = Arc::new(Mutex::new(125));
    let w = World::new(gate_rows(), filled(LIBUSB, reported.clone()));
    w.ticks(2).await;
    assert!(!w.ids()[1].contains(&"ports.sensor.1.value".to_owned()));
    *reported.lock().unwrap() = 33;
    w.ticks(2).await;
    assert!(
        w.ids()[3].contains(&"ports.sensor.1.value".to_owned()),
        "the gate reopens"
    );
}

// ── scheduler — the daisy-chain layer gate ──────────────────────────

fn chain_rows() -> Vec<TelemetryRow> {
    let every = Lifetime::Repeating { divider: 1 };
    let mut rows = vec![
        sensor_value_row(0, 0, 1, 0).with_lifetime(every),
        sensor_occupancy_row(0, 1, 0).with_lifetime(every),
    ];
    for layer in [1, 2] {
        rows.push(sensor_occupancy_row(0, 1, layer).with_lifetime(every));
        rows.push(sensor_value_row(0, 0, 1, layer).with_lifetime(every));
    }
    rows.push(chain_depth_row(1).with_lifetime(every));
    rows
}

fn chain_world(brick: Arc<Mutex<ChainBrick>>, limits: FrameLimits) -> World {
    let link = TestLink::answering(limits, move |payload| {
        Ok(brick.lock().unwrap().answer(payload))
    });
    World::new(chain_rows(), link)
}

#[tokio::test]
async fn scheduler_the_daisy_chain_layer_gate__reads_no_member_row_before_the_chain_has_reported_its_depth()
 {
    let w = chain_world(Arc::new(Mutex::new(ChainBrick::chain(2))), LIBUSB);
    w.ticks(1).await;
    let first = &w.ids()[0];
    assert!(first.contains(&"chain.depth".to_owned()));
    assert!(
        first.contains(&"ports.sensor.1.value".to_owned()),
        "the master's own rows do not wait"
    );
    assert!(
        first
            .iter()
            .all(|id| !id.starts_with("chain.") || id == "chain.depth")
    );
}

#[tokio::test]
async fn scheduler_the_daisy_chain_layer_gate__opens_a_members_occupancy_to_the_depth_and_its_value_once_known()
 {
    let w = chain_world(Arc::new(Mutex::new(ChainBrick::chain(1))), LIBUSB);
    w.ticks(3).await;
    let ids = w.ids();
    assert!(ids[1].contains(&"chain.1.sensor.1.occupancy".to_owned()));
    assert!(
        !ids[1].contains(&"chain.1.sensor.1.value".to_owned()),
        "an unreported member port is closed"
    );
    assert!(ids[2].contains(&"chain.1.sensor.1.value".to_owned()));
    assert!(
        ids.iter().flatten().all(|id| !id.starts_with("chain.2.")),
        "nothing below the depth"
    );
    assert_eq!(w.scheduler.chain_depth(), Some(1));
}

#[tokio::test]
async fn scheduler_the_daisy_chain_layer_gate__closes_and_forgets_a_layer_when_the_depth_drops_below_it()
 {
    let brick = Arc::new(Mutex::new(ChainBrick::chain(2)));
    let w = chain_world(brick.clone(), LIBUSB);
    w.ticks(3).await;
    assert!(w.ids()[2].contains(&"chain.2.sensor.1.value".to_owned()));
    assert_eq!(w.scheduler.occupancy_of("2:1"), Some(30));

    *brick.lock().unwrap() = ChainBrick::chain(1);
    w.ticks(2).await;
    assert!(w.ids()[4].iter().all(|id| !id.starts_with("chain.2.")));
    assert_eq!(
        w.scheduler.occupancy_of("2:1"),
        None,
        "a layer that went away is forgotten"
    );
}

#[tokio::test]
async fn scheduler_the_daisy_chain_layer_gate__reads_no_chain_on_the_hid_fallback() {
    let w = chain_world(Arc::new(Mutex::new(ChainBrick::chain(2))), HID);
    w.ticks(6).await;
    for ids in w.ids() {
        assert!(ids.iter().all(|id| !id.starts_with("chain.")));
        assert!(ids.contains(&"ports.sensor.1.value".to_owned()));
    }
}

// ── scheduler — order by relative lateness on a tight budget ────────

fn slow(i: usize) -> TelemetryRow {
    row(&format!("slow{i}")).bytes(4, 4).every(5)
}

fn fast(i: usize) -> TelemetryRow {
    row(&format!("fast{i}")).bytes(4, 4)
}

#[tokio::test]
async fn scheduler_order_by_lateness__keeps_the_fast_rows_on_every_tick_while_there_is_room() {
    let mut rows: Vec<TelemetryRow> = (0..6).map(slow).collect();
    rows.extend((0..12).map(fast));
    let w = World::new(rows, TestLink::new(HID));
    w.ticks(5).await;
    for (tick, ids) in w.ids().iter().enumerate() {
        assert_eq!(
            ids.iter().filter(|id| id.starts_with("fast")).count(),
            12,
            "tick {tick}"
        );
    }
    let slow_seen: std::collections::HashSet<String> = w
        .ids()
        .into_iter()
        .flatten()
        .filter(|id| id.starts_with("slow"))
        .collect();
    assert_eq!(
        slow_seen.len(),
        6,
        "every slow row read within its own interval"
    );
}

#[tokio::test]
async fn scheduler_order_by_lateness__still_lets_a_slow_row_in_when_the_fast_ones_fill_the_packet()
{
    let mut rows: Vec<TelemetryRow> = (0..14).map(fast).collect();
    rows.push(slow(0));
    let w = World::new(rows, TestLink::new(HID));
    w.ticks(5).await;
    assert!(
        w.ids().iter().any(|ids| ids.contains(&"slow0".to_owned())),
        "the slow row starved"
    );
}

#[tokio::test]
async fn scheduler_order_by_lateness__lets_a_one_shot_wait_as_patiently_as_the_slowest_row() {
    let mut rows = vec![row("once").bytes(4, 4).once()];
    rows.extend((0..14).map(fast));
    rows.push(slow(0));
    let w = World::new(rows, TestLink::new(HID));
    w.ticks(1).await;
    assert_eq!(
        w.ids()[0]
            .iter()
            .filter(|id| id.starts_with("fast"))
            .count(),
        14
    );
}

#[tokio::test]
async fn scheduler_order_by_lateness__counts_a_rows_wait_afresh_once_it_has_been_sent() {
    let mut rows: Vec<TelemetryRow> = (0..13).map(fast).collect();
    rows.extend([slow(0), slow(1)]);
    let w = World::new(rows, TestLink::new(HID));
    w.ticks(6).await;
    let ids = w.ids();
    let has = |tick: usize, id: &str| ids[tick].contains(&id.to_owned());
    assert!(has(0, "slow0") && has(1, "slow1"), "slow1 waited a tick");
    assert!(
        has(5, "slow0") && !has(5, "slow1"),
        "on tick 5 both are fresh again"
    );
}

// ── scheduler — a schedule that changes while running ───────────────

#[tokio::test]
async fn scheduler_a_changing_schedule__keeps_the_phase_when_the_rows_are_replaced() {
    let w = World::new(vec![row("a")], link());
    w.ticks(2).await;
    w.scheduler
        .set_rows(vec![row("a"), row("b").every(3).tier(Tier::Event)])
        .unwrap();
    w.ticks(2).await;
    assert_eq!(w.sorted()[2..], [s(&["a"]), s(&["a", "b"])]);
}

#[tokio::test]
async fn scheduler_a_changing_schedule__does_not_read_a_retired_one_shot_again_when_the_rows_are_replaced()
 {
    let once = row("fw").once().tier(Tier::Static);
    let w = World::new(vec![row("a"), once.clone()], link());
    w.ticks(1).await;
    w.scheduler.set_rows(vec![row("a"), once]).unwrap();
    w.ticks(1).await;
    assert_eq!(w.sorted(), [s(&["a", "fw"]), s(&["a"])]);
}

#[tokio::test]
async fn scheduler_a_changing_schedule__reads_a_one_shot_added_after_the_first_tick_on_the_next_tick_once()
 {
    let w = World::new(vec![row("a")], link());
    w.ticks(2).await;
    w.scheduler
        .set_rows(vec![row("a"), row("fw").once().tier(Tier::Static)])
        .unwrap();
    w.ticks(2).await;
    assert_eq!(w.sorted()[2..], [s(&["a", "fw"]), s(&["a"])]);
}

#[tokio::test]
async fn scheduler_a_changing_schedule__keeps_the_occupancy_gate_when_the_rows_are_replaced() {
    let occupancy = row("p1.occupancy").every(5).port("1").occupancy();
    let value = row("p1.value").port("1");
    let w = World::new(
        vec![occupancy.clone(), value.clone()],
        filled(LIBUSB, Arc::new(Mutex::new(126))),
    );
    w.ticks(1).await;
    let before = w.ids().len();
    w.scheduler.set_rows(vec![occupancy, value]).unwrap();
    w.ticks(1).await;
    assert_eq!(
        w.ids().len(),
        before,
        "read an empty port after the rows were replaced"
    );
    assert_eq!(w.scheduler.port_state("1"), PortState::Empty);
}

fn wide(id: &str) -> TelemetryRow {
    row(id).bytes(20, 1)
}

#[tokio::test]
async fn scheduler_a_changing_schedule__carries_a_deferred_row_over_only_if_it_is_still_wanted() {
    let w = World::new(vec![wide("w1"), wide("w2"), wide("w3")], TestLink::new(HID));
    w.ticks(1).await;
    assert_eq!(w.scheduler.stats().carried_over, 1);
    w.scheduler
        .set_rows(vec![wide("w1").every(7), wide("w2").every(7)])
        .unwrap();
    w.ticks(1).await;
    assert_eq!(w.ids().len(), 1, "read a row nobody wants any more");
    assert_eq!(w.scheduler.stats().carried_over, 0);
}

#[tokio::test]
async fn scheduler_a_changing_schedule__refuses_a_bad_divider_or_two_rows_with_one_id_and_keeps_the_old_set()
 {
    let w = World::new(vec![row("a")], link());
    let error = w.scheduler.set_rows(vec![row("a").every(0)]).unwrap_err();
    assert!(error.to_string().contains("divider"));
    let error = w.scheduler.set_rows(vec![row("a"), row("a")]).unwrap_err();
    assert!(error.to_string().contains("twice"));
    w.ticks(1).await;
    assert_eq!(w.sorted(), [s(&["a"])]);
}

#[tokio::test(start_paused = true)]
async fn scheduler_a_changing_schedule__changes_the_period_while_running_without_a_tick_of_its_own()
{
    let w = World::new(vec![row("a")], link());
    w.scheduler.set_period(200.0).unwrap();
    w.scheduler.start();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(w.scheduler.stats().ticks, 0, "ticked before its period");
    w.scheduler.set_period(10.0).unwrap();
    tokio::time::sleep(Duration::from_millis(120)).await;
    w.scheduler.stop();
    assert!(
        w.scheduler.stats().ticks >= 4,
        "only {} ticks at 10 ms",
        w.scheduler.stats().ticks
    );
    assert_eq!(w.scheduler.tick_period_ms(), 10.0);
}

#[tokio::test]
async fn scheduler_a_changing_schedule__refuses_a_period_that_is_not_a_positive_number_of_milliseconds()
 {
    let w = World::new(vec![row("a")], link());
    for ms in [0.0, -5.0, f64::NAN, f64::INFINITY] {
        let error = w.scheduler.set_period(ms).expect_err("accepted");
        assert!(error.to_string().contains("period"));
    }
}

// ── scheduler — one mode per port, and a settle after a switch ──────

#[tokio::test]
async fn scheduler_modes__refuses_two_modes_of_one_port_in_the_active_rows_and_keeps_the_old_set() {
    let w = World::new(vec![sensor("a", 0)], link());
    assert!(
        w.scheduler
            .set_rows(vec![sensor("a", 0), sensor("b", 1)])
            .unwrap_err()
            .to_string()
            .contains("mode")
    );
    assert!(
        w.scheduler
            .set_rows(vec![sensor("a", 0), sensor("c", 0)])
            .is_ok(),
        "two reads of one mode are fine"
    );
}

#[tokio::test]
async fn scheduler_modes__refuses_two_modes_of_one_port_when_built() {
    let built = TelemetryScheduler::new(SchedulerOptions {
        rows: vec![sensor("a", 0), sensor("b", 1)],
        link: link().as_link(),
        tick_period_ms: 10.0,
        on_values: None,
        on_error: None,
        clock: WallClock::starting_at(0),
    });
    assert!(built.err().unwrap().to_string().contains("mode"));
}

#[tokio::test(start_paused = true)]
async fn scheduler_modes__withholds_a_ports_readings_after_a_mode_switch_until_one_comes_back_as_a_number()
 {
    let w = World::new(
        vec![sensor("a", 0)],
        floats(&[1.0, f32::NAN, f32::NAN, 7.0, 8.0], &[]),
    );
    w.ticks(1).await;
    w.scheduler.set_rows(vec![sensor("b", 1)]).unwrap();
    w.ticks(4).await;
    assert_eq!(w.delivered(), [s(&["a=1"]), s(&["b=7"]), s(&["b=8"])]);
}

#[tokio::test(start_paused = true)]
async fn scheduler_modes__does_not_settle_a_port_whose_mode_did_not_change() {
    let w = World::new(vec![sensor("a", 0)], floats(&[1.0, f32::NAN, 3.0], &[]));
    w.ticks(1).await;
    w.scheduler.set_rows(vec![sensor("a", 0)]).unwrap();
    w.ticks(1).await;
    assert_eq!(
        w.ids().len(),
        2,
        "withheld a reading although the mode stayed"
    );
}

// ── scheduler — one command per tick ────────────────────────────────

#[tokio::test]
async fn scheduler_one_command_per_tick__sends_every_row_coming_up_on_a_tick_in_one_command() {
    let w = World::new(
        vec![
            row("fast"),
            row("slow").every(2).tier(Tier::Event),
            row("fw").once().tier(Tier::Static),
        ],
        link(),
    );
    w.ticks(2).await;
    assert_eq!(w.sorted(), [s(&["fast", "fw", "slow"]), s(&["fast"])]);
    assert_eq!(w.link.calls(), 2);
}

#[tokio::test]
async fn scheduler_one_command_per_tick__sends_one_command_on_a_tick_with_only_event_rows_and_none_on_an_empty_tick()
 {
    let w = World::new(vec![row("slow").every(2).tier(Tier::Event)], link());
    w.ticks(2).await;
    assert_eq!(w.sorted(), [s(&["slow"])]);
    assert_eq!(w.scheduler.stats().ticks_empty, 1);
}

#[tokio::test]
async fn scheduler_one_command_per_tick__sends_one_command_a_tick_whatever_the_dividers() {
    let w = World::new(
        vec![
            row("s1"),
            row("s2").every(2),
            row("s3").every(2),
            row("m1").every(2),
            row("battery").every(10).tier(Tier::Event),
        ],
        link(),
    );
    w.ticks(20).await;
    assert_eq!(w.link.calls(), 20);
}

#[tokio::test]
async fn scheduler_one_command_per_tick__carries_a_row_truncated_on_hid_to_the_front_of_the_next_tick()
 {
    let w = World::new(
        vec![
            wide("f1"),
            wide("s1").once().tier(Tier::Static),
            wide("s2").once().tier(Tier::Static),
        ],
        TestLink::new(HID),
    );
    w.ticks(2).await;
    assert_eq!(w.sorted(), [s(&["f1", "s1"]), s(&["f1", "s2"])]);
}

// ── scheduler — rows and modes while a frame is out ─────────────────

#[tokio::test(start_paused = true)]
async fn scheduler_while_a_frame_is_out__applies_a_row_set_given_during_a_tick_only_after_that_tick()
 {
    let w = World::new(vec![row("f"), row("s").once().tier(Tier::Static)], link());
    w.link.hold(&[1]);
    let tick = w.spawn_tick();
    flush().await;
    w.scheduler.set_rows(vec![row("f")]).unwrap();
    w.link.release();
    tick.await.unwrap();
    w.ticks(1).await;
    assert_eq!(w.link.calls(), 2);
    assert_eq!(
        w.sorted(),
        [s(&["f", "s"]), s(&["f"])],
        "the first tick finished the work it began"
    );
}

#[tokio::test(start_paused = true)]
async fn scheduler_while_a_frame_is_out__does_not_resurrect_a_carried_over_row_removed_meanwhile() {
    let w = World::new(vec![wide("w1"), wide("w2"), wide("w3")], TestLink::new(HID));
    w.link.hold(&[1]);
    let tick = w.spawn_tick();
    flush().await;
    w.scheduler.set_rows(vec![wide("w1"), wide("w2")]).unwrap();
    w.link.release();
    tick.await.unwrap();
    assert_eq!(w.scheduler.stats().carried_over, 0);
}

#[tokio::test(start_paused = true)]
async fn scheduler_while_a_frame_is_out__starts_the_settle_when_a_command_really_switches_the_mode()
{
    let w = World::with_period(vec![sensor("a", 0)], floats(&[1.0, f32::NAN], &[]), 1000.0);
    w.ticks(1).await;
    w.scheduler.set_rows(vec![sensor("b", 1).every(3)]).unwrap();
    tokio::time::advance(Duration::from_millis(5000)).await;
    w.ticks(3).await;
    assert_eq!(
        w.delivered(),
        [s(&["a=1"])],
        "published the NaN of a switch that had only just happened"
    );
}

#[tokio::test(start_paused = true)]
async fn scheduler_while_a_frame_is_out__ends_the_settle_by_elapsed_time_whatever_the_period_does()
{
    let w = World::new(vec![sensor("a", 0)], floats(&[1.0, f32::NAN], &[]));
    w.ticks(1).await;
    w.scheduler.set_rows(vec![sensor("b", 1)]).unwrap();
    w.ticks(1).await;
    w.scheduler.set_period(1000.0).unwrap();
    tokio::time::advance(SETTLE_LIMIT + Duration::from_millis(1)).await;
    w.ticks(1).await;
    assert_eq!(w.delivered(), [s(&["a=1"]), s(&["b=NaN"])]);
}

#[tokio::test(start_paused = true)]
async fn scheduler_while_a_frame_is_out__does_not_let_a_reply_in_the_old_mode_end_the_new_modes_settle()
 {
    let w = World::new(vec![sensor("a", 0)], floats(&[1.0, 2.0, f32::NAN], &[]));
    w.link.hold(&[2]);
    w.ticks(1).await;
    let tick = w.spawn_tick();
    flush().await;
    w.scheduler.set_rows(vec![sensor("b", 1)]).unwrap();
    w.link.release();
    tick.await.unwrap();
    w.ticks(1).await;
    assert_eq!(w.delivered(), [s(&["a=1"]), s(&["a=2"])]);
}

#[tokio::test(start_paused = true)]
async fn scheduler_while_a_frame_is_out__retires_a_one_shot_only_once_its_reading_was_delivered() {
    let w = World::new(vec![sensor("a", 0)], floats(&[1.0, f32::NAN, 5.0], &[]));
    w.ticks(1).await;
    w.scheduler.set_rows(vec![sensor("b", 1).once()]).unwrap();
    w.ticks(3).await;
    assert_eq!(w.delivered(), [s(&["a=1"]), s(&["b=5"])]);
    assert_eq!(w.link.calls(), 3);
}

#[tokio::test]
async fn scheduler_while_a_frame_is_out__never_sends_a_row_switched_off_even_one_carried_over() {
    let w = World::new(vec![wide("w1"), wide("w2"), wide("w3")], TestLink::new(HID));
    w.ticks(1).await;
    w.scheduler
        .set_rows(vec![wide("w1"), wide("w2"), wide("w3").off()])
        .unwrap();
    w.ticks(1).await;
    assert!(w.ids().into_iter().flatten().all(|id| id != "w3"));
}

#[tokio::test]
async fn scheduler_while_a_frame_is_out__keeps_a_carried_over_row_when_the_command_carrying_it_fails()
 {
    let slow_wide = |id: &str| wide(id).every(100).tier(Tier::Event);
    let mut call = 0;
    let link = TestLink::answering(HID, move |_| {
        call += 1;
        if call == 2 {
            Err(TelemetryError::Frame("lost".into()))
        } else {
            Ok(vec![0; 64])
        }
    });
    let w = World::new(
        vec![row("f"), slow_wide("s1"), slow_wide("s2"), slow_wide("s3")],
        link,
    );
    w.ticks(3).await;
    assert!(
        w.ids().into_iter().flatten().any(|id| id == "s3"),
        "s3 vanished until tick 100"
    );
}

#[tokio::test(start_paused = true)]
async fn scheduler_while_a_frame_is_out__neither_delivers_nor_sends_anything_after_dispose() {
    let w = World::new(vec![row("f"), row("s").once().tier(Tier::Static)], link());
    w.link.hold(&[1]);
    let tick = w.spawn_tick();
    flush().await;
    w.scheduler.dispose();
    w.link.release();
    tick.await.unwrap();
    w.ticks(1).await;
    assert!(w.ids().is_empty());
    assert_eq!(w.link.calls(), 1);
}

#[tokio::test(start_paused = true)]
async fn scheduler_while_a_frame_is_out__settles_a_port_again_after_its_device_was_unplugged_and_plugged_back()
 {
    let occupancy = row("p1.occupancy").bytes(2, 1).port("1").occupancy();
    let value = sensor("p1.value", 1);
    let replies: [(u8, f32); 4] = [(30, 1.0), (126, f32::NAN), (30, f32::NAN), (30, f32::NAN)];
    let mut call = 0;
    let link = TestLink::answering(LIBUSB, move |_| {
        let (kind, reading) = replies[call.min(replies.len() - 1)];
        call += 1;
        let mut reply = float_reply(reading);
        reply[4] = kind;
        Ok(reply)
    });
    let w = World::new(vec![occupancy, value], link);
    w.ticks(4).await;
    let readings: Vec<String> = w
        .seen
        .lock()
        .unwrap()
        .iter()
        .flatten()
        .filter(|v| v.row_id == "p1.value")
        .map(|v| format!("{}", v.value.as_number().unwrap()))
        .collect();
    assert_eq!(readings, ["1", "NaN"]);
}

#[tokio::test]
async fn scheduler_while_a_frame_is_out__sends_nothing_more_when_disposed_from_a_listener() {
    let link = link();
    let me: Arc<OnceLock<TelemetryScheduler>> = Arc::new(OnceLock::new());
    let handle = me.clone();
    let scheduler = TelemetryScheduler::new(SchedulerOptions {
        rows: vec![row("f"), row("s").once().tier(Tier::Static)],
        link: link.as_link(),
        tick_period_ms: 10.0,
        on_values: Some(Arc::new(move |_: &[RowValue]| {
            handle.get().unwrap().dispose()
        })),
        on_error: None,
        clock: WallClock::starting_at(0),
    })
    .unwrap();
    me.set(scheduler.clone()).ok();
    scheduler.run_tick().await;
    scheduler.run_tick().await;
    assert_eq!(
        link.calls(),
        1,
        "sent a command after a listener disposed the loop"
    );
}

#[tokio::test(start_paused = true)]
async fn scheduler_while_a_frame_is_out__settles_afresh_after_a_switch_command_that_failed_before_reaching_the_brick()
 {
    let w = World::new(vec![sensor("a", 0)], floats(&[1.0, f32::NAN], &[2]));
    w.ticks(1).await;
    w.scheduler.set_rows(vec![sensor("b", 1)]).unwrap();
    w.ticks(1).await;
    tokio::time::advance(SETTLE_LIMIT + Duration::from_millis(100)).await;
    w.ticks(1).await;
    assert_eq!(w.delivered(), [s(&["a=1"])]);
}

#[tokio::test(start_paused = true)]
async fn scheduler_while_a_frame_is_out__remembers_the_mode_a_port_was_left_in_when_its_rows_come_back_in_another()
 {
    let w = World::new(vec![sensor("a", 0)], floats(&[1.0, 1.0, f32::NAN], &[]));
    w.ticks(1).await;
    w.scheduler.set_rows(vec![row("x")]).unwrap();
    w.ticks(1).await;
    w.scheduler.set_rows(vec![sensor("b", 1)]).unwrap();
    w.ticks(1).await;
    assert!(w.delivered().into_iter().flatten().all(|v| v != "b=NaN"));
}

#[tokio::test]
async fn scheduler_while_a_frame_is_out__resolves_the_packet_budget_per_frame() {
    // A link that falls back to 64 bytes mid-session narrows the very next frame.
    let w = World::new(wide_rows(20), link());
    w.ticks(1).await;
    assert_eq!(w.ids()[0].len(), 20);
    w.link.set_limits(HID);
    w.ticks(1).await;
    let sent = w.link.sent();
    assert!(
        sent[1].len() + 5 <= 64,
        "a {}-byte frame went out on a 64-byte link",
        sent[1].len() + 5
    );
    assert!(w.ids()[1].len() < 20);
}
