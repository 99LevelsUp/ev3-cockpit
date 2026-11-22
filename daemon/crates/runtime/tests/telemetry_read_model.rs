//! The read model and the delivery. Ports of `telemetryReadModel.test.ts`, `chainModel.test.ts`
//! (the stale depth) and the delivery cases of `cockpitApiTelemetry.test.ts`. Names are
//! `<describe>__<it>` in snake case.

#![allow(non_snake_case)]

mod support_telemetry;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ev3_contract::{TelemetryUpdate, TelemetryUpdateKind};
use ev3_runtime::chain::ChainDepth;
use ev3_runtime::telemetry::claims::RowRate;
use ev3_runtime::telemetry::delivery::{DeliveryTarget, TelemetryDelivery};
use ev3_runtime::telemetry::read_model::{ReadModelChange, ReadValue, TelemetryReadModel};
use ev3_runtime::telemetry::service::TelemetryEvent;
use ev3_runtime::telemetry::{Reading, RowValue, StaleSettings, WallClock};
use support_telemetry::flush;

const A: &str = "AAA";
const B: &str = "BBB";
const TACHO: &str = "ports.motor.A.tacho";
const BATTERY: &str = "system.battery.level";
const FIRMWARE: &str = "system.firmwareVersion";

#[derive(Clone, Copy)]
enum P {
    Ms(f64),
    Once,
}

struct World {
    model: TelemetryReadModel,
    clock: WallClock,
    changes: Arc<Mutex<Vec<ReadModelChange>>>,
}

fn world(stale_factor: f64, stale_timeout_ms: f64) -> World {
    let clock = WallClock::starting_at(0);
    let model = TelemetryReadModel::new(
        StaleSettings {
            stale_factor,
            stale_timeout_ms,
        },
        clock,
    )
    .unwrap();
    let changes = Arc::new(Mutex::new(Vec::new()));
    let sink = changes.clone();
    model.listen(Arc::new(move |change: &ReadModelChange| {
        sink.lock().unwrap().push(change.clone())
    }));
    World {
        model,
        clock,
        changes,
    }
}

fn default_world() -> World {
    world(3.0, 1000.0)
}

impl World {
    fn plan(&self, brick: &str, rows: &[(&str, P)]) {
        let intervals = rows
            .iter()
            .map(|(id, p)| {
                let rate = match p {
                    P::Ms(ms) => RowRate::Every(*ms),
                    P::Once => RowRate::Once,
                };
                ((*id).to_owned(), rate)
            })
            .collect();
        self.model.apply(&TelemetryEvent::PlanChanged {
            brick_id: brick.into(),
            intervals,
        });
    }

    fn sample(&self, brick: &str, rows: &[(&str, Reading)]) {
        let now = self.clock.now_ms();
        let values = rows
            .iter()
            .map(|(id, value)| RowValue {
                row_id: (*id).into(),
                value: value.clone(),
                unit: None,
                mode: None,
                sampled_at: now,
            })
            .collect();
        self.model.apply(&TelemetryEvent::Values {
            brick_id: brick.into(),
            values,
        });
    }

    fn end(&self, brick: &str) {
        self.model.apply(&TelemetryEvent::SessionEnded {
            brick_id: brick.into(),
        });
    }

    /// Moves the clock without running the timer: a timer the runtime has not reached yet.
    async fn jump(&self, ms: u64) {
        tokio::time::advance(Duration::from_millis(ms)).await;
    }

    /// Runs the timer now, late.
    fn fire(&self) {
        self.model.tick();
    }

    /// Moves the clock, running the timer each time it comes due on the way. A timer that keeps
    /// coming due at the same moment would be a busy loop: it fails here, not hangs.
    async fn advance(&self, ms: u64) {
        let until = self.clock.now_ms() + ms;
        let mut rounds = 0;
        while let Some(next) = self.model.next_deadline_ms() {
            if next > until as f64 {
                break;
            }
            rounds += 1;
            assert!(
                rounds < 10_000,
                "the read model's timer keeps coming due: a busy loop"
            );
            let at = (next.ceil() as u64).max(self.clock.now_ms());
            tokio::time::advance(Duration::from_millis(at - self.clock.now_ms())).await;
            self.model.tick();
        }
        let now = self.clock.now_ms();
        tokio::time::advance(Duration::from_millis(until - now)).await;
    }

    fn take(&self) -> Vec<ReadModelChange> {
        std::mem::take(&mut *self.changes.lock().unwrap())
    }

    fn value(&self, brick: &str, row: &str) -> Option<ReadValue> {
        self.model.value_of(brick, row)
    }
}

fn n(value: f64) -> Reading {
    Reading::Number(value)
}

fn rows_of(change: Option<&ReadModelChange>) -> Vec<(String, Reading, bool)> {
    change
        .map(|c| {
            c.rows
                .iter()
                .map(|r| (r.row_id.clone(), r.value.clone(), r.stale))
                .collect()
        })
        .unwrap_or_default()
}

fn row(id: &str, value: Reading, stale: bool) -> (String, Reading, bool) {
    (id.to_owned(), value, stale)
}

fn removed(brick: &str, ids: &[&str]) -> ReadModelChange {
    ReadModelChange {
        brick_id: brick.into(),
        rows: Vec::new(),
        removed: ids.iter().map(|id| (*id).to_owned()).collect(),
    }
}

// ── telemetry read model ────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn read_model__keeps_the_last_value_of_a_row_with_when_it_was_sampled_and_its_interval() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.advance(40).await;
    w.sample(A, &[(TACHO, n(90.0))]);
    assert_eq!(
        w.value(A, TACHO),
        Some(ReadValue {
            row_id: TACHO.into(),
            value: n(90.0),
            unit: None,
            mode: None,
            sampled_at: 40,
            effective: Some(RowRate::Every(100.0)),
            stale: false
        })
    );
    assert_eq!(rows_of(w.take().first()), [row(TACHO, n(90.0), false)]);
}

#[tokio::test(start_paused = true)]
async fn read_model__makes_no_change_for_a_sample_that_changed_nothing_but_keeps_its_time() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.take();
    w.advance(100).await;
    w.sample(A, &[(TACHO, n(90.0))]);
    assert!(w.take().is_empty());
    assert_eq!(w.value(A, TACHO).unwrap().sampled_at, 100);
    w.sample(A, &[(TACHO, n(f64::NAN))]);
    w.take();
    w.sample(A, &[(TACHO, n(f64::NAN))]);
    assert!(w.take().is_empty(), "NaN again is no change");
}

#[tokio::test(start_paused = true)]
async fn read_model__marks_a_value_stale_once_it_is_stale_factor_of_its_intervals_old_not_before() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.take();
    w.advance(299).await;
    assert!(!w.value(A, TACHO).unwrap().stale);
    assert!(w.take().is_empty());
    w.advance(1).await;
    assert!(w.value(A, TACHO).unwrap().stale);
    assert_eq!(rows_of(w.take().first()), [row(TACHO, n(90.0), true)]);
}

#[tokio::test(start_paused = true)]
async fn read_model__marks_a_value_stale_at_once_when_its_row_stops_being_read() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0)), (BATTERY, P::Ms(500.0))]);
    w.sample(A, &[(TACHO, n(90.0)), (BATTERY, n(80.0))]);
    w.take();
    w.plan(A, &[(BATTERY, P::Ms(500.0))]);
    assert_eq!(rows_of(w.take().first()), [row(TACHO, n(90.0), true)]);
    assert!(!w.value(A, BATTERY).unwrap().stale);
}

#[tokio::test(start_paused = true)]
async fn read_model__loses_nothing_in_an_outage() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.take();
    w.plan(A, &[]);
    assert_eq!(rows_of(w.take().first()), [row(TACHO, n(90.0), true)]);
    w.advance(500).await;
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    let after = w.take();
    assert_eq!(rows_of(after.last()), [row(TACHO, n(90.0), false)]);
}

#[tokio::test(start_paused = true)]
async fn read_model__drops_a_stale_value_after_stale_timeout_not_before_and_says_so() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.plan(A, &[]);
    w.take();
    w.advance(999).await;
    assert!(w.value(A, TACHO).is_some());
    w.advance(1).await;
    assert!(w.value(A, TACHO).is_none());
    assert_eq!(w.take(), [removed(A, &[TACHO])]);
}

#[tokio::test(start_paused = true)]
async fn read_model__clears_a_brick_at_once_when_its_session_ends() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0)), (FIRMWARE, P::Once)]);
    w.sample(
        A,
        &[(TACHO, n(90.0)), (FIRMWARE, Reading::Text("V1.09D".into()))],
    );
    w.take();
    w.end(A);
    assert!(w.model.snapshot(A, None).is_empty());
    let changes = w.take();
    assert_eq!(changes.len(), 1);
    let mut gone = changes[0].removed.clone();
    gone.sort();
    assert_eq!(gone, [TACHO, FIRMWARE]);
    assert!(changes[0].rows.is_empty());
}

#[tokio::test(start_paused = true)]
async fn read_model__keeps_a_static_row_fresh_for_the_whole_session_read_or_not() {
    let w = default_world();
    w.plan(A, &[(FIRMWARE, P::Once)]);
    w.sample(A, &[(FIRMWARE, Reading::Text("V1.09D".into()))]);
    w.take();
    w.plan(A, &[]);
    w.advance(60_000).await;
    assert!(!w.value(A, FIRMWARE).unwrap().stale);
    assert!(w.take().is_empty());
}

#[tokio::test(start_paused = true)]
async fn read_model__says_when_a_rows_effective_interval_changes_value_or_not() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.take();
    w.plan(A, &[(TACHO, P::Ms(250.0))]);
    let changes = w.take();
    assert_eq!(
        changes[0]
            .rows
            .iter()
            .map(|r| r.effective)
            .collect::<Vec<_>>(),
        [Some(RowRate::Every(250.0))]
    );
}

#[tokio::test(start_paused = true)]
async fn read_model__keeps_bricks_apart() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.plan(B, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(1.0))]);
    w.sample(B, &[(TACHO, n(2.0))]);
    w.end(A);
    assert!(w.value(A, TACHO).is_none());
    assert_eq!(w.value(B, TACHO).unwrap().value, n(2.0));
}

#[tokio::test(start_paused = true)]
async fn read_model__follows_a_settings_change_at_once_and_refuses_settings_out_of_range() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.advance(250).await;
    w.take();
    w.model
        .configure(StaleSettings {
            stale_factor: 2.0,
            stale_timeout_ms: 1000.0,
        })
        .unwrap();
    assert!(
        w.value(A, TACHO).unwrap().stale,
        "250 ms is past 2 intervals of 100"
    );
    assert!(
        w.model
            .configure(StaleSettings {
                stale_factor: 0.0,
                stale_timeout_ms: 1000.0
            })
            .unwrap_err()
            .to_string()
            .contains("staleFactor")
    );
    assert!(
        w.model
            .configure(StaleSettings {
                stale_factor: 3.0,
                stale_timeout_ms: -1.0
            })
            .unwrap_err()
            .to_string()
            .contains("staleTimeoutMs")
    );
}

#[tokio::test(start_paused = true)]
async fn read_model__keeps_a_row_that_left_the_plan_stale_when_a_late_reply_still_brings_it() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.plan(A, &[]);
    w.take();
    w.advance(50).await;
    w.sample(A, &[(TACHO, n(91.0))]);
    let late = w.value(A, TACHO).unwrap();
    assert_eq!(
        (late.value, late.stale, late.effective),
        (n(91.0), true, None)
    );
    w.advance(950).await;
    assert!(
        w.value(A, TACHO).is_none(),
        "dropped 1000 ms after it stopped being read"
    );
}

#[tokio::test(start_paused = true)]
async fn read_model__announces_an_outage_even_when_a_sample_beats_the_late_timer_to_it() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.take();
    w.jump(400).await;
    w.sample(A, &[(TACHO, n(90.0))]);
    let changes: Vec<_> = w.take().iter().map(|c| rows_of(Some(c))).collect();
    assert_eq!(
        changes,
        [
            vec![row(TACHO, n(90.0), true)],
            vec![row(TACHO, n(90.0), false)]
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn read_model__counts_a_stale_values_time_from_when_it_went_stale() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.take();
    w.jump(2000).await;
    w.fire();
    assert!(w.value(A, TACHO).is_none());
    assert_eq!(
        w.take(),
        [
            ReadModelChange {
                brick_id: A.into(),
                rows: vec![ReadValue {
                    row_id: TACHO.into(),
                    value: n(90.0),
                    unit: None,
                    mode: None,
                    sampled_at: 0,
                    effective: Some(RowRate::Every(100.0)),
                    stale: true
                }],
                removed: Vec::new(),
            },
            removed(A, &[TACHO]),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn read_model__says_a_value_went_stale_before_it_says_it_is_gone_even_with_no_time_between() {
    let w = world(3.0, 0.0);
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.take();
    w.advance(300).await;
    let changes: Vec<_> = w
        .take()
        .iter()
        .map(|c| (rows_of(Some(c)), c.removed.clone()))
        .collect();
    assert_eq!(
        changes,
        [
            (vec![row(TACHO, n(90.0), true)], vec![]),
            (vec![], vec![TACHO.to_owned()])
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn read_model__takes_a_never_stale_factor_without_a_deadline_that_overflows() {
    let w = world(3.0, 2f64.powi(40));
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.plan(A, &[]);
    w.model
        .configure(StaleSettings {
            stale_factor: f64::MAX,
            stale_timeout_ms: 1000.0,
        })
        .unwrap();
    w.model.start_timer();
    w.advance(5000).await;
    assert!(
        w.value(A, TACHO).is_none(),
        "stale since it left the plan, gone a second later"
    );
}

#[tokio::test(start_paused = true)]
async fn read_model__learns_what_a_brick_is_already_read_for_when_it_follows_a_running_service() {
    // A model attached to a service that already runs takes its current plans first.
    let bricks = support_telemetry::FakeBricks::new();
    let service = bricks.service(ev3_runtime::telemetry::service::TelemetryServiceOptions {
        start_loops: false,
        ..Default::default()
    });
    bricks.connect(A, ev3_transports::Transport::Usb);
    bricks.set_active(Some(A));
    let w = default_world();
    w.model.follow(&service);
    w.sample(A, &[(TACHO, n(90.0))]);
    assert_eq!(
        w.value(A, TACHO).unwrap().effective,
        Some(RowRate::Every(100.0))
    );
    w.advance(300).await;
    assert!(w.value(A, TACHO).unwrap().stale);
}

#[tokio::test(start_paused = true)]
async fn read_model__says_a_row_is_no_longer_read_the_moment_it_leaves_the_plan_stale_already_or_not()
 {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0)), (BATTERY, P::Ms(500.0))]);
    w.sample(A, &[(TACHO, n(90.0)), (BATTERY, n(80.0))]);
    w.advance(300).await;
    w.take();
    w.plan(A, &[]);
    let mut rows: Vec<_> = w
        .take()
        .into_iter()
        .flat_map(|c| c.rows)
        .map(|r| (r.row_id, r.stale, r.effective))
        .collect();
    rows.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        rows,
        [
            (TACHO.to_owned(), true, None),
            (BATTERY.to_owned(), true, None)
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn read_model__lets_no_plan_change_hide_an_overdue_outage_or_put_off_a_drop() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.take();
    w.jump(400).await;
    w.plan(A, &[(TACHO, P::Ms(1000.0))]);
    assert!(
        w.value(A, TACHO).unwrap().stale,
        "stale it went, and stays until a sample"
    );
    assert!(w.take()[0].rows[0].stale);
    w.plan(A, &[]);
    w.advance(900).await;
    assert!(w.value(A, TACHO).is_none());
}

#[tokio::test(start_paused = true)]
async fn read_model__takes_no_late_reply_for_a_brick_whose_session_ended_until_it_is_read_again() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.end(A);
    w.take();
    w.sample(A, &[(TACHO, n(91.0))]);
    assert!(w.model.snapshot(A, None).is_empty());
    assert!(w.take().is_empty());
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(92.0))]);
    assert_eq!(w.value(A, TACHO).unwrap().value, n(92.0));
}

#[tokio::test(start_paused = true)]
async fn read_model__takes_no_sample_for_a_brick_a_listener_ended_while_hearing_about_it() {
    let w = default_world();
    let model = w.model.clone();
    w.model.listen(Arc::new(move |change: &ReadModelChange| {
        if change.rows.iter().any(|r| r.stale) {
            model.apply(&TelemetryEvent::SessionEnded { brick_id: A.into() });
        }
    }));
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.jump(400).await;
    w.sample(A, &[(TACHO, n(91.0))]);
    assert!(w.model.snapshot(A, None).is_empty());
}

#[tokio::test(start_paused = true)]
async fn read_model__takes_no_late_reply_for_a_row_whose_stale_time_has_run_out_since_it_stopped() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.advance(10).await;
    w.plan(A, &[]);
    w.advance(490).await;
    w.plan(A, &[(BATTERY, P::Ms(500.0))]);
    w.advance(600).await;
    w.take();
    w.sample(A, &[(TACHO, n(91.0))]);
    assert!(w.value(A, TACHO).is_none());
    assert!(w.take().is_empty());
}

#[tokio::test(start_paused = true)]
async fn read_model__keeps_a_static_row_fresh_when_its_first_reply_comes_after_it_left_the_plan() {
    let w = default_world();
    w.plan(A, &[(FIRMWARE, P::Once), (TACHO, P::Ms(100.0))]);
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(FIRMWARE, Reading::Text("V1.10E".into()))]);
    w.advance(60_000).await;
    let fw = w.value(A, FIRMWARE).unwrap();
    assert_eq!((fw.stale, fw.effective), (false, Some(RowRate::Once)));
}

#[tokio::test(start_paused = true)]
async fn read_model__keeps_a_dropped_row_dropped_until_it_is_read_again() {
    let w = default_world();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.advance(400).await;
    w.plan(A, &[]);
    w.advance(950).await;
    w.take();
    w.sample(A, &[(TACHO, n(91.0))]);
    assert!(w.value(A, TACHO).is_none());
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(92.0))]);
    assert_eq!(w.value(A, TACHO).unwrap().value, n(92.0));
}

#[tokio::test(start_paused = true)]
async fn read_model__marks_and_drops_on_its_own_timer() {
    let w = default_world();
    w.model.start_timer();
    w.plan(A, &[(TACHO, P::Ms(100.0))]);
    w.sample(A, &[(TACHO, n(90.0))]);
    w.take();
    tokio::time::sleep(Duration::from_millis(301)).await;
    assert!(w.value(A, TACHO).unwrap().stale);
    tokio::time::sleep(Duration::from_millis(1000)).await;
    assert!(w.value(A, TACHO).is_none());
    assert_eq!(w.take().len(), 2, "stale, then gone");
}

// ── the daisy chain model ───────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn daisy_chain_model__knows_nothing_of_a_chain_whose_depth_has_not_been_read() {
    let w = default_world();
    assert_eq!(w.model.chain_depth(A), None);
}

#[tokio::test(start_paused = true)]
async fn daisy_chain_model__says_when_the_depth_it_was_built_from_is_stale() {
    let w = default_world();
    w.plan(A, &[("chain.depth", P::Ms(500.0))]);
    w.sample(A, &[("chain.depth", n(2.0))]);
    assert_eq!(
        w.model.chain_depth(A),
        Some(ChainDepth {
            depth: 2,
            stale: false
        })
    );
    w.plan(A, &[]);
    assert_eq!(
        w.model.chain_depth(A),
        Some(ChainDepth {
            depth: 2,
            stale: true
        })
    );
}

#[tokio::test(start_paused = true)]
async fn daisy_chain_model__tells_only_a_change_of_the_chain_and_when_it_is_unknown_again() {
    let w = world(3.0, 1000.0);
    let heard = Arc::new(Mutex::new(Vec::new()));
    let sink = heard.clone();
    w.model
        .listen_chain(Arc::new(move |brick: &str, depth: Option<ChainDepth>| {
            sink.lock().unwrap().push((brick.to_owned(), depth));
        }));
    w.plan(A, &[("chain.depth", P::Ms(500.0))]);
    w.sample(A, &[("chain.depth", n(1.0))]);
    w.advance(100).await;
    w.sample(A, &[("chain.depth", n(1.0))]);
    w.plan(A, &[("chain.depth", P::Ms(250.0))]);
    w.sample(A, &[("chain.depth", n(2.0))]);
    w.plan(A, &[]);
    w.advance(1000).await;
    let fresh = |depth| {
        Some(ChainDepth {
            depth,
            stale: false,
        })
    };
    assert_eq!(
        *heard.lock().unwrap(),
        [
            (A.to_owned(), fresh(1)),
            (A.to_owned(), fresh(2)),
            (
                A.to_owned(),
                Some(ChainDepth {
                    depth: 2,
                    stale: true
                })
            ),
            (A.to_owned(), None),
        ],
        "the same depth again and a new interval tell nothing"
    );
}

// ── telemetry delivery ──────────────────────────────────────────────

#[tokio::test]
async fn telemetry_delivery__releases_nothing_twice_when_a_listener_closes_on_hearing_ended() {
    let d = delivery();
    let heard: Heard = Arc::default();
    let handle: Arc<OnceLock<ev3_runtime::telemetry::delivery::DeliveryHandle>> =
        Arc::new(OnceLock::new());
    let closes = Arc::new(Mutex::new(Vec::new()));
    let (slot, record, sink) = (handle.clone(), closes.clone(), heard.clone());
    let mut t = target("s1", "c1", &[TACHO], &heard);
    t.listener = Arc::new(move |update: TelemetryUpdate| {
        let ended = update.kind == TelemetryUpdateKind::Ended;
        sink.lock().unwrap().push(update);
        if ended {
            record.lock().unwrap().push(slot.get().unwrap().close());
        }
    });
    handle.set(d.open(t, Vec::new)).ok();
    d.claims_ended(A, &["c1".into()]);
    flush().await;
    assert_eq!(
        *closes.lock().unwrap(),
        [false],
        "the claim ended with its brick: nothing to release"
    );
    assert!(!handle.get().unwrap().close());
}

// ── telemetry delivery, order ───────────────────────────────────────

type Heard = Arc<Mutex<Vec<TelemetryUpdate>>>;

fn target(id: &str, handle: &str, rows: &[&str], heard: &Heard) -> DeliveryTarget {
    let sink = heard.clone();
    DeliveryTarget {
        subscription_id: id.into(),
        brick_id: A.into(),
        handle: handle.into(),
        rows: rows.iter().map(|r| (*r).to_owned()).collect(),
        listener: Arc::new(move |update| sink.lock().unwrap().push(update)),
        owner: id.into(),
        on_ended: Arc::new(|| {}),
    }
}

fn change(rows: &[(&str, f64)]) -> ReadModelChange {
    ReadModelChange {
        brick_id: A.into(),
        rows: rows
            .iter()
            .map(|(id, v)| ReadValue {
                row_id: (*id).into(),
                value: n(*v),
                unit: None,
                mode: None,
                sampled_at: 1,
                effective: None,
                stale: false,
            })
            .collect(),
        removed: Vec::new(),
    }
}

fn kinds(heard: &Heard) -> Vec<(TelemetryUpdateKind, Vec<String>)> {
    heard
        .lock()
        .unwrap()
        .iter()
        .map(|u| (u.kind, u.values.iter().map(|v| v.row_id.clone()).collect()))
        .collect()
}

fn num(value: &ev3_contract::TelemetryValueValue) -> Option<f64> {
    match value {
        ev3_contract::TelemetryValueValue::Number(n) => Some(*n),
        _ => None,
    }
}

fn delivery() -> TelemetryDelivery {
    TelemetryDelivery::new(Arc::new(|_| {}))
}

#[tokio::test]
async fn telemetry_delivery__sends_a_snapshot_first_then_only_the_rows_of_this_subscription_that_changed()
 {
    let d = delivery();
    let heard: Heard = Arc::default();
    let _h = d.open(target("s1", "c1", &[TACHO], &heard), Vec::new);
    d.change(&change(&[(TACHO, 1.0), (BATTERY, 80.0)]));
    d.change(&change(&[(BATTERY, 79.0)]));
    d.change(&change(&[(TACHO, 2.0)]));
    flush().await;
    assert_eq!(
        kinds(&heard),
        [
            (TelemetryUpdateKind::Snapshot, vec![]),
            (TelemetryUpdateKind::Change, vec![TACHO.to_owned()]),
            (TelemetryUpdateKind::Change, vec![TACHO.to_owned()]),
        ]
    );
    assert!(
        heard
            .lock()
            .unwrap()
            .iter()
            .all(|u| u.subscription_id == "s1" && u.brick_id == A)
    );
}

#[tokio::test]
async fn telemetry_delivery__tells_nothing_inside_the_call_that_subscribes() {
    let d = delivery();
    let heard: Heard = Arc::default();
    let _h = d.open(target("s1", "c1", &[TACHO], &heard), Vec::new);
    assert!(heard.lock().unwrap().is_empty());
    flush().await;
    assert_eq!(heard.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn telemetry_delivery__stops_on_close_including_what_was_already_on_its_way() {
    let d = delivery();
    let heard: Heard = Arc::default();
    let handle = d.open(target("s1", "c1", &[TACHO], &heard), Vec::new);
    d.change(&change(&[(TACHO, 1.0)]));
    assert!(handle.close(), "the claim is still held: release it");
    assert!(!handle.close(), "closed already: release nothing twice");
    flush().await;
    assert!(heard.lock().unwrap().is_empty());
}

#[tokio::test]
async fn telemetry_delivery__ends_with_the_brick_says_so_once_and_releases_nothing_that_ended() {
    let d = delivery();
    let heard: Heard = Arc::default();
    let ended = Arc::new(Mutex::new(0));
    let count = ended.clone();
    let mut t = target("s1", "c1", &[TACHO], &heard);
    t.on_ended = Arc::new(move || *count.lock().unwrap() += 1);
    let handle = d.open(t, Vec::new);
    d.claims_ended(A, &["c1".into()]);
    d.change(&change(&[(TACHO, 1.0)]));
    d.claims_ended(A, &["c1".into()]);
    flush().await;
    assert_eq!(
        kinds(&heard).iter().map(|k| k.0).collect::<Vec<_>>(),
        [TelemetryUpdateKind::Snapshot, TelemetryUpdateKind::Ended]
    );
    assert_eq!(*ended.lock().unwrap(), 1);
    assert!(!handle.close(), "the claim ended with its brick");
}

#[tokio::test]
async fn telemetry_delivery__releases_nothing_for_a_subscription_closed_after_its_brick_went_before_its_snapshot()
 {
    let d = delivery();
    let heard: Heard = Arc::default();
    let handle = d.open(target("s1", "c1", &[TACHO], &heard), Vec::new);
    d.claims_ended(A, &["c1".into()]);
    assert!(!handle.close());
}

#[tokio::test]
async fn telemetry_delivery__loses_no_queued_change_when_the_snapshot_listener_itself_ends_the_brick()
 {
    let d = delivery();
    let heard: Heard = Arc::default();
    let me = d.clone();
    let sink = heard.clone();
    let mut t = target("s1", "c1", &[TACHO], &heard);
    t.listener = Arc::new(move |update: TelemetryUpdate| {
        let snapshot = update.kind == TelemetryUpdateKind::Snapshot;
        sink.lock().unwrap().push(update);
        if snapshot {
            me.claims_ended(A, &["c1".into()]);
        }
    });
    let _h = d.open(t, Vec::new);
    d.change(&change(&[(TACHO, 1.0)]));
    flush().await;
    assert_eq!(
        kinds(&heard).iter().map(|k| k.0).collect::<Vec<_>>(),
        [
            TelemetryUpdateKind::Snapshot,
            TelemetryUpdateKind::Change,
            TelemetryUpdateKind::Ended
        ]
    );
}

#[tokio::test]
async fn telemetry_delivery__does_not_let_one_consumers_listener_cut_another_consumers_change_short()
 {
    let d = delivery();
    let first: Heard = Arc::default();
    let second: Heard = Arc::default();
    let me = d.clone();
    let sink = first.clone();
    let mut t = target("s1", "c1", &[TACHO], &first);
    t.listener = Arc::new(move |update: TelemetryUpdate| {
        let is_change = update.kind == TelemetryUpdateKind::Change;
        sink.lock().unwrap().push(update);
        if is_change {
            me.claims_ended(A, &["c1".into(), "c2".into()]);
        }
    });
    let _h1 = d.open(t, Vec::new);
    let _h2 = d.open(target("s2", "c2", &[TACHO], &second), Vec::new);
    d.change(&change(&[(TACHO, 1.0)]));
    flush().await;
    assert_eq!(
        kinds(&second).iter().map(|k| k.0).collect::<Vec<_>>(),
        [
            TelemetryUpdateKind::Snapshot,
            TelemetryUpdateKind::Change,
            TelemetryUpdateKind::Ended
        ]
    );
}

#[tokio::test]
async fn telemetry_delivery__tells_every_subscription_the_older_change_first_when_a_listener_causes_a_newer_one()
 {
    let d = delivery();
    let first: Heard = Arc::default();
    let second: Heard = Arc::default();
    let me = d.clone();
    let sink = first.clone();
    let mut t = target("s1", "c1", &[TACHO], &first);
    t.listener = Arc::new(move |update: TelemetryUpdate| {
        let older = update.values.first().and_then(|v| num(&v.value)) == Some(1.0);
        sink.lock().unwrap().push(update);
        if older {
            me.change(&change(&[(TACHO, 2.0)]));
        }
    });
    let _h1 = d.open(t, Vec::new);
    let _h2 = d.open(target("s2", "c2", &[TACHO], &second), Vec::new);
    flush().await;
    d.change(&change(&[(TACHO, 1.0)]));
    flush().await;
    let values: Vec<_> = second
        .lock()
        .unwrap()
        .iter()
        .skip(1)
        .map(|u| num(&u.values[0].value))
        .collect();
    assert_eq!(values, [Some(1.0), Some(2.0)]);
}

#[tokio::test]
async fn telemetry_delivery__gives_a_subscription_made_inside_a_listener_the_change_in_its_snapshot_and_not_again()
 {
    let d = delivery();
    let first: Heard = Arc::default();
    let later: Heard = Arc::default();
    let opened: Arc<OnceLock<ev3_runtime::telemetry::delivery::DeliveryHandle>> =
        Arc::new(OnceLock::new());
    let (me, slot, late_sink, sink) = (d.clone(), opened.clone(), later.clone(), first.clone());
    let mut t = target("s1", "c1", &[TACHO], &first);
    t.listener = Arc::new(move |update: TelemetryUpdate| {
        let is_change = update.kind == TelemetryUpdateKind::Change;
        sink.lock().unwrap().push(update);
        if is_change && slot.get().is_none() {
            let snapshot = change(&[(TACHO, 1.0)])
                .rows
                .iter()
                .map(ReadValue::to_contract)
                .collect();
            slot.set(me.open(target("s2", "c2", &[TACHO], &late_sink), move || snapshot))
                .ok();
        }
    });
    let _h = d.open(t, Vec::new);
    d.change(&change(&[(TACHO, 1.0)]));
    flush().await;
    assert_eq!(
        kinds(&later),
        [(TelemetryUpdateKind::Snapshot, vec![TACHO.to_owned()])]
    );
}

#[tokio::test]
async fn telemetry_delivery__keeps_the_runtime_responsive_when_every_change_a_listener_hears_makes_another()
 {
    let d = delivery();
    let heard: Heard = Arc::default();
    let me = d.clone();
    let sink = heard.clone();
    let mut t = target("s1", "c1", &[TACHO], &heard);
    t.listener = Arc::new(move |update: TelemetryUpdate| {
        sink.lock().unwrap().push(update);
        me.change(&change(&[(TACHO, 1.0)]));
    });
    let _h = d.open(t, Vec::new);
    // On a current-thread runtime this test task only runs again if a turn ends.
    for _ in 0..3 {
        tokio::task::yield_now().await;
    }
    let told = heard.lock().unwrap().len();
    assert!(
        (1..1000).contains(&told),
        "told {told} updates before the test ran again"
    );
    d.dispose();
}

#[tokio::test]
async fn telemetry_delivery__does_not_let_a_panicking_listener_cost_another_consumer_anything() {
    let warned = Arc::new(Mutex::new(Vec::new()));
    let sink = warned.clone();
    let d = TelemetryDelivery::new(Arc::new(move |message: &str| {
        sink.lock().unwrap().push(message.to_owned())
    }));
    let heard: Heard = Arc::default();
    let mut t = target("bad", "c1", &[TACHO], &heard);
    t.listener = Arc::new(|_| panic!("a consumer bug"));
    let _h1 = d.open(t, Vec::new);
    let _h2 = d.open(target("good", "c2", &[TACHO], &heard), Vec::new);
    d.change(&change(&[(TACHO, 1.0)]));
    flush().await;
    assert_eq!(
        kinds(&heard).len(),
        2,
        "the good consumer heard its snapshot and the change"
    );
    assert!(warned.lock().unwrap().iter().any(|m| m.contains("bad")));
}

#[tokio::test]
async fn telemetry_delivery__tells_nothing_once_it_is_disposed() {
    let d = delivery();
    let heard: Heard = Arc::default();
    let _h = d.open(target("s1", "c1", &[TACHO], &heard), Vec::new);
    d.dispose();
    let handle = d.open(target("s2", "c2", &[TACHO], &heard), Vec::new);
    d.change(&change(&[(TACHO, 1.0)]));
    flush().await;
    assert!(heard.lock().unwrap().is_empty());
    assert!(
        !handle.close(),
        "a subscription refused by a disposed delivery holds nothing"
    );
}

#[tokio::test(start_paused = true)]
async fn telemetry_delivery__works_end_to_end_over_the_service_and_the_read_model() {
    let bricks = support_telemetry::FakeBricks::new();
    let service = bricks.service(ev3_runtime::telemetry::service::TelemetryServiceOptions {
        start_loops: false,
        clock: WallClock::starting_at(0),
        ..Default::default()
    });
    let model =
        TelemetryReadModel::new(StaleSettings::default(), WallClock::starting_at(0)).unwrap();
    model.follow(&service);
    let d = delivery();
    d.follow(&model, &service);
    bricks.connect(A, ev3_transports::Transport::Usb);
    let request = ev3_runtime::telemetry::claims::ClaimRequest {
        row_ids: vec![TACHO.into()],
        interval_ms: 200.0,
        modes: BTreeMap::new(),
    };
    let ticket = service.claim(A, &request, "ev3-c").unwrap();
    let heard: Heard = Arc::default();
    let rows = vec![TACHO.to_owned()];
    let snapshot_model = model.clone();
    let _h = d.open(target("s1", &ticket.handle, &[TACHO], &heard), move || {
        snapshot_model
            .snapshot(A, Some(&rows))
            .iter()
            .map(ReadValue::to_contract)
            .collect()
    });
    service.loop_for(A).unwrap().run_tick().await;
    flush().await;
    bricks.sign_out(A);
    flush().await;
    assert_eq!(
        kinds(&heard),
        [
            (TelemetryUpdateKind::Snapshot, vec![]),
            (TelemetryUpdateKind::Change, vec![TACHO.to_owned()]),
            (TelemetryUpdateKind::Ended, vec![]),
        ]
    );
}
