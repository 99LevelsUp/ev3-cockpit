//! The switch from the Node daemon: the user's channel takes over its debts and settings and
//! removes what only it used; a test channel never does.

mod common;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use common::TempRoot;
use ev3_cockpitd::log::Log;
use ev3_cockpitd::migrate::{migrate, old_root};
use ev3_cockpitd::paths::Paths;
use ev3_cockpitd::settings::SettingsStore;
use ev3_contract::{AccessMode, SettingScalar};
use ev3_runtime::{LedgerFile, TransferDebt};

const BRICK_A: &str = "001653F00A0A";
const BRICK_B: &str = "001653F00B0B";
const BRICK_C: &str = "001653F00C0C";

/// The Node daemon's root with the native root inside it, as on a user's machine.
struct Layout {
    _temp: TempRoot,
    old: PathBuf,
    native: Paths,
    log: Log,
}

impl Layout {
    fn new(tag: &str) -> Self {
        Self::on_channel(tag, None)
    }

    fn on_channel(tag: &str, channel: Option<&str>) -> Self {
        let temp = TempRoot::new(&format!("migrate-{tag}"));
        let old = temp.path().join("ev3-cockpit");
        let native_root = old.join("native");
        let native = Paths::new(&native_root, channel);
        std::fs::create_dir_all(&native.dir).expect("native dir");
        let log = Log::open(&native.log);
        Self {
            _temp: temp,
            old,
            native,
            log,
        }
    }

    fn old_file(&self, name: &str, text: &str) {
        let path = self.old.join(name);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("dir");
        std::fs::write(path, text).expect("write");
    }

    fn run(&self) -> ev3_cockpitd::migrate::Migration {
        migrate(&self.old, &self.native, &self.log)
    }

    fn native_debts(&self, brick: &str) -> Vec<TransferDebt> {
        LedgerFile::open(&self.native.ledger)
            .expect("the native ledger reads")
            .load(brick)
    }

    fn log_text(&self) -> String {
        std::fs::read_to_string(&self.native.log).unwrap_or_default()
    }

    /// Every file under the old root (the native one included) and its bytes; the log aside.
    fn snapshot(&self) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut all = BTreeMap::new();
        walk(&self.old, &mut all);
        all.remove(&self.native.log);
        all
    }
}

fn walk(dir: &Path, all: &mut BTreeMap<PathBuf, Vec<u8>>) {
    for entry in std::fs::read_dir(dir).expect("list").flatten() {
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path).expect("stat");
        if meta.is_dir() {
            all.insert(path.clone(), b"<dir>".to_vec());
            walk(&path, all);
        } else {
            all.insert(path.clone(), std::fs::read(&path).unwrap_or_default());
        }
    }
}

/// What the Node daemon leaves on a user's machine: debts, settings and its own files.
fn node_state(layout: &Layout) {
    layout.old_file(
        "ledger.json",
        r#"{
  "001653F00A0A": [
    { "kind": "slot", "handle": 7, "deletePath": "/home/root/lms2012/prjs/demo/demo.rbf" },
    { "kind": "unknown" }
  ],
  "001653F00B0B": [
    { "kind": "slot", "handle": 12, "uncertain": true },
    { "kind": "delete", "path": "/home/root/lms2012/prjs/demo/sound.rsf" }
  ]
}
"#,
    );
    layout.old_file(
        "settings.json",
        r#"{
  "transfer.tcpPacketBytes": 512,
  "rememberBricks": "auto"
}
"#,
    );
    layout.old_file("key", "0123456789abcdef0123456789abcdef");
    layout.old_file("hardware.lock", "");
    layout.old_file("hardware.lock.4242", r#"{"pid":4242,"at":1}"#);
    layout.old_file("hardware.lock.17", r#"{"pid":17,"channel":"dev","at":1}"#);
    layout.old_file("handover.json", r#"{"successorVersion":"0.2.1","at":1}"#);
    layout.old_file("handover-state.json", r#"{"from":"0.2.0","at":1}"#);
    layout.old_file("install.json", r#"{"command":"node"}"#);
    layout.old_file("channels/dev/settings.json", "{}");
    layout.old_file("channels/dev/ledger.json", "{}");
}

fn slot(handle: u8, delete: Option<&str>) -> TransferDebt {
    TransferDebt::slot(handle, delete.map(str::to_string))
}

#[test]
fn a_debt_the_node_daemon_recorded_is_still_owed_after_the_switch() {
    let layout = Layout::new("owed");
    node_state(&layout);

    let done = layout.run();

    assert_eq!(
        layout.native_debts(BRICK_A),
        vec![
            slot(7, Some("/home/root/lms2012/prjs/demo/demo.rbf")),
            TransferDebt::Unknown { delete_path: None },
        ]
    );
    assert_eq!(
        layout.native_debts(BRICK_B),
        vec![
            TransferDebt::uncertain_slot(12, None),
            TransferDebt::Delete {
                path: "/home/root/lms2012/prjs/demo/sound.rsf".into()
            },
        ]
    );
    assert_eq!(done.debts_added, 4);
    assert!(done.ledger_taken);
    assert!(
        !layout.old.join("ledger.json").exists(),
        "a taken ledger leaves its name, or paid debts would come back"
    );
    assert!(layout.log_text().contains("4 debt(s) added for 2 brick(s)"));
}

#[test]
fn old_debts_merge_into_a_native_ledger_that_holds_others_without_doubling_a_slot() {
    let layout = Layout::new("merge");
    let native = LedgerFile::open(&layout.native.ledger).expect("empty");
    native.save(
        BRICK_A,
        &[slot(7, None), TransferDebt::Delete { path: "/x".into() }],
    );
    native.save(BRICK_C, &[slot(3, None)]);
    assert_eq!(native.last_error(), None);
    layout.old_file(
        "ledger.json",
        r#"{
  "001653F00A0A": [
    { "kind": "slot", "handle": 7, "deletePath": "/p" },
    { "kind": "slot", "handle": 9 },
    { "kind": "delete", "path": "/x" },
    { "kind": "delete", "path": "/q" }
  ],
  "001653F00B0B": [ { "kind": "unknown", "deletePath": "/u" } ]
}
"#,
    );

    let done = layout.run();

    assert_eq!(
        layout.native_debts(BRICK_A),
        vec![
            slot(7, None),
            TransferDebt::Delete { path: "/x".into() },
            slot(9, None),
            TransferDebt::Delete { path: "/q".into() },
        ],
        "the native debts stay first, the same slot and the same file are not owed twice"
    );
    assert_eq!(
        layout.native_debts(BRICK_B),
        vec![TransferDebt::Unknown {
            delete_path: Some("/u".into())
        }]
    );
    assert_eq!(
        layout.native_debts(BRICK_C),
        vec![slot(3, None)],
        "a brick the old ledger does not name keeps its debts"
    );
    assert_eq!(done.debts_added, 3);
    assert!(!layout.old.join("ledger.json").exists());
}

#[test]
fn old_settings_are_in_effect_when_the_native_daemon_had_none() {
    let layout = Layout::new("settings");
    layout.old_file(
        "settings.json",
        r#"{ "transfer.tcpPacketBytes": 512, "rememberBricks": "auto", "accessMode": "full", "transfer.btPacketBytes": 10, "bogus": 1 }"#,
    );

    let done = layout.run();

    assert!(done.settings_copied);
    let store = SettingsStore::load(&layout.native.settings, |_| {});
    assert_eq!(store.number("transfer.tcpPacketBytes"), Some(512.0));
    let remember = store
        .list()
        .into_iter()
        .find(|s| s.spec.key == "rememberBricks")
        .expect("rememberBricks");
    assert!(matches!(remember.value, SettingScalar::String(ref v) if v == "auto"));
    assert_eq!(store.number("transfer.btPacketBytes"), Some(1024.0));
    assert_eq!(store.access_mode(), AccessMode::Safe);
    let written = std::fs::read_to_string(&layout.native.settings).expect("written");
    assert!(!written.contains("accessMode"), "{written}");
    assert!(!written.contains("bogus"), "{written}");
}

#[test]
fn native_settings_that_exist_are_left_untouched() {
    let layout = Layout::new("settings-kept");
    let native = "{\n  \"transfer.tcpPacketBytes\": 2048\n}\n";
    std::fs::write(&layout.native.settings, native).expect("native settings");
    layout.old_file("settings.json", r#"{ "transfer.tcpPacketBytes": 512 }"#);

    let done = layout.run();

    assert!(!done.settings_copied);
    assert_eq!(
        std::fs::read_to_string(&layout.native.settings).expect("read"),
        native
    );
    let store = SettingsStore::load(&layout.native.settings, |_| {});
    assert_eq!(store.number("transfer.tcpPacketBytes"), Some(2048.0));
}

#[test]
fn what_only_the_node_daemon_used_is_removed_and_nothing_else() {
    let layout = Layout::new("removed");
    node_state(&layout);
    layout.old_file("held.json", "[]");
    layout.old_file("logs/daemon.log", "a line");
    layout.old_file("hardware.lock.tmp", "not a claim");
    layout.old_file("channels/ci/settings.json", "{}");
    std::fs::write(&layout.native.key, b"native key").expect("native key");

    let done = layout.run();

    for gone in [
        "key",
        "hardware.lock",
        "hardware.lock.4242",
        "hardware.lock.17",
        "handover.json",
        "handover-state.json",
        "install.json",
        "channels/dev",
    ] {
        assert!(!layout.old.join(gone).exists(), "{gone} is still there");
    }
    assert_eq!(done.removed.len(), 8, "{:?}", done.removed);
    for kept in [
        "held.json",
        "logs/daemon.log",
        "hardware.lock.tmp",
        "channels/ci/settings.json",
        "settings.json",
    ] {
        assert!(layout.old.join(kept).exists(), "{kept} was removed");
    }
    assert_eq!(
        std::fs::read(&layout.native.key).expect("the native key stays"),
        b"native key"
    );
    assert!(
        layout
            .log_text()
            .contains("Removed what only the previous daemon used")
    );
}

#[test]
fn a_second_start_changes_nothing() {
    let layout = Layout::new("twice");
    node_state(&layout);
    let first = layout.run();
    assert!(first.debts_added > 0 && first.settings_copied && !first.removed.is_empty());
    let before = layout.snapshot();

    let second = layout.run();

    assert_eq!(layout.snapshot(), before);
    assert_eq!(
        second,
        ev3_cockpitd::migrate::Migration {
            ran: true,
            ..Default::default()
        }
    );
}

#[test]
fn a_node_daemon_that_writes_its_ledger_again_does_not_double_a_debt() {
    let layout = Layout::new("again");
    let text = r#"{ "001653F00A0A": [ { "kind": "slot", "handle": 7 }, { "kind": "unknown" } ] }"#;
    layout.old_file("ledger.json", text);
    layout.run();
    layout.old_file("ledger.json", text);

    let done = layout.run();

    assert_eq!(done.debts_added, 0);
    assert_eq!(
        layout.native_debts(BRICK_A),
        vec![slot(7, None), TransferDebt::Unknown { delete_path: None }]
    );
    assert!(!layout.old.join("ledger.json").exists());
}

#[test]
fn a_damaged_old_ledger_is_left_in_place_and_the_rest_goes_on() {
    let layout = Layout::new("damaged");
    layout.old_file("ledger.json", "{ not json");
    layout.old_file("settings.json", r#"{ "transfer.tcpPacketBytes": 512 }"#);
    layout.old_file("key", "old key");

    let done = layout.run();

    assert_eq!(
        std::fs::read_to_string(layout.old.join("ledger.json")).expect("kept"),
        "{ not json"
    );
    assert!(!layout.native.ledger.exists(), "no native ledger was made");
    assert!(!done.ledger_taken);
    assert!(done.settings_copied, "the settings are still taken over");
    assert!(!layout.old.join("key").exists(), "the old key still goes");
    assert!(
        layout.log_text().contains("transfer ledger")
            && layout.log_text().contains("cannot be read"),
        "{}",
        layout.log_text()
    );
}

#[test]
fn a_damaged_native_ledger_keeps_the_old_one_for_a_later_start() {
    let layout = Layout::new("native-damaged");
    std::fs::write(&layout.native.ledger, "{ not json").expect("damaged");
    let text = r#"{ "001653F00A0A": [ { "kind": "slot", "handle": 7 } ] }"#;
    layout.old_file("ledger.json", text);

    let done = layout.run();

    assert_eq!(done.debts_added, 0);
    assert_eq!(
        std::fs::read_to_string(&layout.native.ledger).expect("native"),
        "{ not json",
        "never written over: the runtime moves it aside"
    );
    assert_eq!(
        std::fs::read_to_string(layout.old.join("ledger.json")).expect("old"),
        text
    );
    assert!(layout.log_text().contains("taken over at a later start"));
}

#[test]
fn a_test_channel_never_takes_anything_over() {
    let layout = Layout::on_channel("test-channel", Some("ci"));
    node_state(&layout);
    let before = layout.snapshot();

    let done = layout.run();

    assert!(!done.ran);
    assert_eq!(layout.snapshot(), before);
    assert!(!layout.native.ledger.exists());
    assert!(!layout.native.settings.exists());
}

fn link_dir(target: &Path, link: &Path) {
    #[cfg(windows)]
    {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(std::process::Stdio::null())
            .status()
            .expect("mklink");
        assert!(status.success(), "mklink /J failed");
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).expect("symlink");
}

#[test]
fn a_channels_link_out_of_the_old_root_is_not_followed() {
    let layout = Layout::new("channels-link");
    let elsewhere = layout._temp.path().join("elsewhere");
    std::fs::create_dir_all(elsewhere.join("dev")).expect("elsewhere");
    std::fs::write(elsewhere.join("dev").join("work.txt"), b"keep").expect("file");
    std::fs::create_dir_all(&layout.old).expect("old");
    link_dir(&elsewhere, &layout.old.join("channels"));

    layout.run();

    assert_eq!(
        std::fs::read(elsewhere.join("dev").join("work.txt")).expect("still there"),
        b"keep"
    );
    assert!(layout.log_text().contains("is a link"));
}

#[test]
fn a_dev_channel_that_is_a_link_goes_as_a_link() {
    let layout = Layout::new("dev-link");
    let elsewhere = layout._temp.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).expect("elsewhere");
    std::fs::write(elsewhere.join("work.txt"), b"keep").expect("file");
    std::fs::create_dir_all(layout.old.join("channels")).expect("channels");
    link_dir(&elsewhere, &layout.old.join("channels").join("dev"));

    let done = layout.run();

    assert!(std::fs::symlink_metadata(layout.old.join("channels").join("dev")).is_err());
    assert_eq!(
        std::fs::read(elsewhere.join("work.txt")).expect("still there"),
        b"keep"
    );
    assert_eq!(done.removed.len(), 1);
}

#[cfg(unix)]
#[test]
fn an_old_key_that_is_a_link_goes_as_a_link_and_a_linked_ledger_is_not_read() {
    let layout = Layout::new("file-link");
    let elsewhere = layout._temp.path().join("elsewhere");
    std::fs::create_dir_all(&elsewhere).expect("elsewhere");
    std::fs::write(elsewhere.join("secret"), b"keep").expect("file");
    std::fs::write(
        elsewhere.join("ledger.json"),
        r#"{ "001653F00A0A": [ { "kind": "slot", "handle": 7 } ] }"#,
    )
    .expect("ledger");
    std::fs::create_dir_all(&layout.old).expect("old");
    std::os::unix::fs::symlink(elsewhere.join("secret"), layout.old.join("key")).expect("link");
    std::os::unix::fs::symlink(
        elsewhere.join("ledger.json"),
        layout.old.join("ledger.json"),
    )
    .expect("link");

    let done = layout.run();

    assert!(std::fs::symlink_metadata(layout.old.join("key")).is_err());
    assert_eq!(
        std::fs::read(elsewhere.join("secret")).expect("kept"),
        b"keep"
    );
    assert_eq!(done.debts_added, 0);
    assert!(layout.old.join("ledger.json").exists(), "left where it is");
}

#[test]
fn the_old_root_is_the_parent_of_the_native_one() {
    let base = PathBuf::from(if cfg!(windows) { "C:\\s" } else { "/s" });
    assert_eq!(
        old_root(&base.join("ev3-cockpit").join("native")),
        Some(base.join("ev3-cockpit"))
    );
    assert_eq!(old_root(&base.join("ev3-cockpit")), None);
    let native = ev3_cockpitd::paths::default_state_root().expect("a state root");
    assert_eq!(
        old_root(&native).and_then(|old| old.file_name().map(|n| n.to_os_string())),
        Some("ev3-cockpit".into()),
        "the Node daemon's root, as its paths.ts places it"
    );
}
