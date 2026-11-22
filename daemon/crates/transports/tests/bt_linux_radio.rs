//! A Bluetooth adapter that stopped answering, noticed through the inquiry windows and restarted
//! within its budget. Against a fake BlueZ and a fake sysfs, on a paused clock.
#![cfg(target_os = "linux")]

mod bt_linux_support;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bt_linux_support::*;
use ev3_transports::bt_linux::bluez::{BluezError, BluezObjects};
use ev3_transports::bt_linux::presence::InquiryOutcome;
use ev3_transports::bt_linux::radio_watch::{
    LINUX_BT_RESTART_RULE_PATH, RadioSysfs, RadioWatch, RadioWatchTimings, restart_advice,
};
use tokio::time::Instant;

struct FakeSysfs {
    file: Option<PathBuf>,
    writable: bool,
    fail: bool,
    writes: Mutex<Vec<(String, Instant)>>,
}

impl FakeSysfs {
    fn usb() -> Arc<Self> {
        Arc::new(Self {
            file: Some(PathBuf::from("/sys/devices/usb1/1-1/authorized")),
            writable: true,
            fail: false,
            writes: Mutex::new(Vec::new()),
        })
    }

    fn values(&self) -> Vec<String> {
        self.writes
            .lock()
            .unwrap()
            .iter()
            .map(|(v, _)| v.clone())
            .collect()
    }
}

impl RadioSysfs for FakeSysfs {
    fn authorized_file(&self, hci: &str) -> Option<PathBuf> {
        assert_eq!(hci, "hci0");
        self.file.clone()
    }
    fn writable(&self, _file: &Path) -> bool {
        self.writable
    }
    fn write(&self, _file: &Path, value: &str) -> std::io::Result<()> {
        if self.fail {
            return Err(std::io::Error::from_raw_os_error(libc::EIO));
        }
        self.writes
            .lock()
            .unwrap()
            .push((value.to_owned(), Instant::now()));
        Ok(())
    }
}

struct Rig {
    bus: Arc<FakeBus>,
    objects: Arc<BluezObjects>,
    sysfs: Arc<FakeSysfs>,
    said: Arc<Said>,
    watch: Arc<RadioWatch>,
}

fn rig_with(sysfs: Arc<FakeSysfs>) -> Rig {
    let bus = FakeBus::new(Vec::new());
    let objects = Arc::new(BluezObjects::new());
    objects.load(vec![adapter_object()]);
    let said = Arc::new(Said::default());
    let source = Arc::clone(&bus);
    let watch = RadioWatch::new(
        Arc::clone(&objects),
        move || Some(Arc::clone(&source) as _),
        Arc::clone(&sysfs) as _,
        Arc::clone(&said) as _,
        Some("/opt/extension/native/linux/71-ev3-cockpit-bluetooth-restart.rules".into()),
        RadioWatchTimings::default(),
    );
    Rig {
        bus,
        objects,
        sysfs,
        said,
        watch,
    }
}

fn rig() -> Rig {
    rig_with(FakeSysfs::usb())
}

/// BlueZ refuses to switch the adapter off, as it does for a dead radio, `times` times.
fn refuse_switching(rig: &Rig, times: usize) {
    for _ in 0..times {
        rig.bus.reply(
            "SetPowered",
            Reply::Err(BluezError::new("org.bluez.Error.Failed", "Failed")),
        );
    }
}

fn stuck() -> InquiryOutcome {
    InquiryOutcome::stuck("StopDiscovery: org.bluez.Error.InProgress")
}

#[tokio::test(start_paused = true)]
async fn two_refused_windows_in_a_row_read_a_usb_adapter_again_0_then_1() {
    let rig = rig();
    refuse_switching(&rig, 1);
    rig.watch.note_window(stuck()).await;
    assert!(rig.sysfs.values().is_empty(), "one refusal can be a race");
    rig.watch.note_window(stuck()).await;
    assert_eq!(rig.sysfs.values(), ["0", "1"]);
    let writes = rig.sysfs.writes.lock().unwrap().clone();
    assert_eq!(writes[1].1 - writes[0].1, Duration::from_secs(3));
    assert_eq!(rig.said.count_containing("has stopped answering"), 1);
    assert_eq!(rig.said.count_containing("read it again"), 1);
    assert!(!rig.watch.checks_held());
}

#[tokio::test(start_paused = true)]
async fn a_refused_window_followed_by_one_that_went_well_does_nothing() {
    let rig = rig();
    rig.watch.note_window(stuck()).await;
    rig.watch.note_window(InquiryOutcome::answered()).await;
    rig.watch.note_window(stuck()).await;
    assert!(rig.sysfs.values().is_empty());
    assert_eq!(rig.bus.count("SetPowered"), 0);
}

#[tokio::test(start_paused = true)]
async fn a_window_that_says_nothing_neither_counts_nor_breaks_a_run() {
    let rig = rig();
    refuse_switching(&rig, 1);
    rig.watch.note_window(stuck()).await;
    rig.watch.note_window(InquiryOutcome::unclear()).await;
    rig.watch.note_window(InquiryOutcome::unclear()).await;
    assert!(rig.sysfs.values().is_empty());
    rig.watch.note_window(stuck()).await;
    assert_eq!(rig.sysfs.values(), ["0", "1"]);
}

#[tokio::test(start_paused = true)]
async fn switches_it_off_and_on_when_bluez_can_and_reads_it_afresh_if_it_stops_again_soon() {
    let rig = rig();
    rig.watch.note_window(stuck()).await;
    rig.watch.note_window(stuck()).await;
    let calls = rig.bus.calls.lock().unwrap().clone();
    let switches: Vec<&str> = calls.iter().map(|c| c.args[1].as_str()).collect();
    assert_eq!(switches, ["false", "true"]);
    assert!(rig.sysfs.values().is_empty());
    assert_eq!(rig.said.count_containing("by switching it off and on"), 1);
    tokio::time::sleep(Duration::from_secs(120)).await;
    rig.watch.note_window(stuck()).await;
    rig.watch.note_window(stuck()).await;
    assert_eq!(
        rig.bus.count("SetPowered"),
        2,
        "not tried again within ten minutes"
    );
    assert_eq!(rig.sysfs.values(), ["0", "1"]);
}

#[tokio::test(start_paused = true)]
async fn when_this_user_may_not_restart_it_says_once_how_to_allow_it_and_leaves_it_alone() {
    let rig = rig_with(Arc::new(FakeSysfs {
        writable: false,
        ..Arc::into_inner(FakeSysfs::usb()).unwrap()
    }));
    refuse_switching(&rig, 2);
    rig.watch.note_window(stuck()).await;
    rig.watch.note_window(stuck()).await;
    assert!(rig.sysfs.values().is_empty());
    let warnings = rig.said.warnings();
    let advice = warnings
        .iter()
        .find(|w| w.contains("may not restart"))
        .unwrap();
    assert!(
        advice.contains("71-ev3-cockpit-bluetooth-restart.rules"),
        "{advice}"
    );
    assert!(advice.contains("plugdev"), "{advice}");
    assert!(rig.watch.checks_held());
    assert!(rig.watch.inquiry_held());
    rig.watch.note_window(stuck()).await;
    rig.watch.note_window(stuck()).await;
    assert_eq!(rig.said.count_containing("may not restart"), 1, "said once");
}

#[tokio::test(start_paused = true)]
async fn looks_again_when_the_adapter_goes_and_comes_back() {
    let rig = rig_with(Arc::new(FakeSysfs {
        file: None,
        ..Arc::into_inner(FakeSysfs::usb()).unwrap()
    }));
    refuse_switching(&rig, 1);
    rig.watch.note_window(stuck()).await;
    rig.watch.note_window(stuck()).await;
    assert!(rig.said.count_containing("not a USB adapter") == 1);
    assert!(rig.watch.checks_held());
    rig.objects.clear();
    rig.objects.load(vec![adapter_object()]);
    assert!(!rig.watch.checks_held());
    assert_eq!(rig.said.count_containing("the adapter came back"), 1);
}

#[tokio::test(start_paused = true)]
async fn looks_again_when_a_later_inquiry_finds_the_radio_answering() {
    let rig = rig_with(Arc::new(FakeSysfs {
        file: None,
        ..Arc::into_inner(FakeSysfs::usb()).unwrap()
    }));
    refuse_switching(&rig, 1);
    rig.watch.note_window(stuck()).await;
    rig.watch.note_window(stuck()).await;
    assert!(rig.watch.checks_held());
    // A probe every ten minutes.
    tokio::time::sleep(Duration::from_secs(600)).await;
    assert!(!rig.watch.inquiry_held());
    rig.watch.note_window(InquiryOutcome::answered()).await;
    assert!(!rig.watch.checks_held());
    assert_eq!(rig.said.count_containing("it answered again"), 1);
}

#[tokio::test(start_paused = true)]
async fn leaves_the_radio_alone_while_restarting_it() {
    let rig = rig();
    refuse_switching(&rig, 1);
    rig.watch.note_window(stuck()).await;
    let watch = Arc::clone(&rig.watch);
    let restart = tokio::spawn(async move { watch.note_window(stuck()).await });
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(rig.watch.checks_held());
    assert!(rig.watch.inquiry_held());
    restart.await.unwrap();
    assert!(!rig.watch.checks_held());
    assert!(!rig.watch.inquiry_held());
}

#[tokio::test(start_paused = true)]
async fn an_adapter_taken_off_is_read_again_even_when_the_window_is_dropped_or_disposed() {
    let rig = rig();
    refuse_switching(&rig, 1);
    rig.watch.note_window(stuck()).await;
    let abandoned =
        tokio::time::timeout(Duration::from_secs(1), rig.watch.note_window(stuck())).await;
    assert!(abandoned.is_err(), "the restart was still in its pause");
    assert_eq!(rig.sysfs.values(), ["0"]);
    rig.watch.dispose();
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(rig.sysfs.values(), ["0", "1"], "never left off");
    assert!(rig.watch.checks_held(), "nothing new after dispose");
}

/// One restart through the authorized file: two refused windows.
async fn one_restart(rig: &Rig) {
    refuse_switching(rig, 1);
    rig.watch.note_window(stuck()).await;
    rig.watch.note_window(stuck()).await;
}

#[tokio::test(start_paused = true)]
async fn restarts_at_most_three_times_within_15_minutes_then_leaves_it_alone_and_says_so_once() {
    let rig = rig();
    for _ in 0..3 {
        one_restart(&rig).await;
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
    assert_eq!(rig.sysfs.values().len(), 6);
    one_restart(&rig).await;
    assert_eq!(
        rig.sysfs.values().len(),
        6,
        "the fourth within 15 minutes waits"
    );
    assert_eq!(rig.said.count_containing("3 times within 15 minutes"), 1);
    assert!(rig.watch.checks_held());
    // A probe while the budget is still full waits another while, saying nothing again.
    tokio::time::sleep(Duration::from_secs(600)).await;
    rig.watch.note_window(stuck()).await;
    assert_eq!(rig.sysfs.values().len(), 6);
    assert_eq!(rig.said.count_containing("within 15 minutes"), 1);
}

#[tokio::test(start_paused = true)]
async fn after_the_pause_restarts_an_adapter_a_probe_finds_still_dead() {
    let rig = rig();
    for _ in 0..3 {
        one_restart(&rig).await;
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
    one_restart(&rig).await;
    assert!(rig.watch.left_alone().is_some());
    // The oldest restart is fifteen minutes old by now.
    tokio::time::sleep(Duration::from_secs(15 * 60)).await;
    refuse_switching(&rig, 1);
    rig.watch.note_window(stuck()).await;
    assert_eq!(
        rig.sysfs.values().len(),
        8,
        "a dead chip never answers by itself"
    );
    assert!(rig.watch.left_alone().is_none());
}

#[tokio::test(start_paused = true)]
async fn only_the_pause_for_the_budget_restarts_again_a_failed_restart_is_left_alone() {
    let rig = rig_with(Arc::new(FakeSysfs {
        fail: true,
        ..Arc::into_inner(FakeSysfs::usb()).unwrap()
    }));
    refuse_switching(&rig, 1);
    rig.watch.note_window(stuck()).await;
    rig.watch.note_window(stuck()).await;
    assert_eq!(rig.said.count_containing("failed"), 1);
    tokio::time::sleep(Duration::from_secs(20 * 60)).await;
    rig.watch.note_window(stuck()).await;
    rig.watch.note_window(stuck()).await;
    assert_eq!(rig.said.count_containing("failed"), 1);
    assert!(rig.watch.left_alone().is_some());
}

#[tokio::test(start_paused = true)]
async fn a_probe_that_finds_out_nothing_keeps_the_dead_radio_left_alone() {
    let rig = rig_with(Arc::new(FakeSysfs {
        writable: false,
        ..Arc::into_inner(FakeSysfs::usb()).unwrap()
    }));
    refuse_switching(&rig, 1);
    rig.watch.note_window(stuck()).await;
    rig.watch.note_window(stuck()).await;
    tokio::time::sleep(Duration::from_secs(600)).await;
    rig.watch.note_window(InquiryOutcome::unclear()).await;
    assert!(rig.watch.checks_held());
    assert!(
        rig.watch.inquiry_held(),
        "the next probe is ten minutes away again"
    );
}

#[tokio::test(start_paused = true)]
async fn its_own_replug_keeps_the_budget_an_adapter_plugged_in_by_hand_starts_afresh() {
    let rig = rig();
    for _ in 0..3 {
        one_restart(&rig).await;
        // Its own replug: the adapter goes and comes back within a minute.
        rig.objects.clear();
        rig.objects.load(vec![adapter_object()]);
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
    one_restart(&rig).await;
    assert_eq!(
        rig.sysfs.values().len(),
        6,
        "the budget stood across its own replugs"
    );
    // Plugged in again by hand, long after the last replug.
    rig.objects.clear();
    rig.objects.load(vec![adapter_object()]);
    assert!(rig.watch.left_alone().is_none());
    one_restart(&rig).await;
    assert_eq!(rig.sysfs.values().len(), 8, "a fresh start");
}

#[test]
fn names_the_shipped_rule_in_its_advice() {
    assert!(restart_advice(None).contains(LINUX_BT_RESTART_RULE_PATH));
    assert!(restart_advice(Some("/x/rule.rules")).contains("/x/rule.rules"));
}
