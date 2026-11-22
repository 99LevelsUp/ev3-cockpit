//! The USB provider: which backend a connection lands on and what it says about it, probes that
//! a connect waits for, devices a link holds that nothing else opens, and a dispose that gives
//! every device back.

mod usb_fake;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use ev3_transports::usb::{
    NodeAccess, Platform, UsbBackendKind, UsbError, UsbLog, UsbProviderOptions,
    UsbTransportProvider,
};
use ev3_transports::{BrickKey, ErrorCode, SendOptions, Transport, TransportProvider};
use usb_fake::{FakeBus, FakeHid, Spec, command_of, padded, reply_packet};

const SERIAL: &str = "001653AABBCC";
const OTHER: &str = "001653DDEEFF";

fn key(serial: &str) -> BrickKey {
    BrickKey::new(Transport::Usb, serial).unwrap()
}

#[derive(Default)]
struct Lines {
    info: Mutex<Vec<String>>,
    warn: Mutex<Vec<String>>,
}

impl UsbLog for Lines {
    fn info(&self, message: &str) {
        self.info.lock().unwrap().push(message.into());
    }

    fn warn(&self, message: &str) {
        self.warn.lock().unwrap().push(message.into());
    }
}

impl Lines {
    fn warnings(&self) -> Vec<String> {
        self.warn.lock().unwrap().clone()
    }
}

struct Rig {
    provider: UsbTransportProvider,
    bus: Arc<FakeBus>,
    hid: Arc<FakeHid>,
    lines: Arc<Lines>,
}

fn rig_with(platform: Platform, specs: Vec<Spec>, hid: FakeHid, rule: Option<&str>) -> Rig {
    let bus = FakeBus::new(specs);
    let hid = Arc::new(hid);
    let lines = Arc::new(Lines::default());
    let provider = UsbTransportProvider::with_backends(
        bus.clone(),
        Some(hid.clone()),
        UsbProviderOptions {
            platform,
            udev_rule_path: rule.map(str::to_owned),
            log: Some(lines.clone()),
            send_timeout: Duration::from_secs(1),
        },
    );
    Rig {
        provider,
        bus,
        hid,
        lines,
    }
}

fn hid_brick(serial: &str) -> FakeHid {
    FakeHid::new(vec![FakeHid::brick("hidraw3", serial, Some("AAA"))])
}

fn rig(specs: Vec<Spec>) -> Rig {
    rig_with(Platform::Windows, specs, hid_brick(SERIAL), None)
}

// ── Backend selection ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn prefers_libusb_and_never_opens_the_hid_path_when_it_succeeds() {
    let rig = rig(vec![Spec::serial(SERIAL)]);
    let handle = rig.provider.connect(&key(SERIAL)).await.unwrap();
    assert_eq!(handle.brick_key, key(SERIAL));
    assert_eq!(
        rig.provider.backend_for(&key(SERIAL)),
        Some(UsbBackendKind::Libusb)
    );
    assert_eq!(rig.provider.max_packet_bytes(&key(SERIAL)), Some(1024));
    assert!(rig.hid.log.lock().unwrap().opened.is_empty());
    assert!(
        rig.lines
            .info
            .lock()
            .unwrap()
            .iter()
            .any(|line| line.contains("1024-byte frames"))
    );
}

#[tokio::test]
async fn falls_back_to_hid_and_says_what_that_costs() {
    let rig = rig(vec![Spec {
        claim_error: Some(UsbError::Access),
        ..Spec::serial(SERIAL)
    }]);
    rig.provider.connect(&key(SERIAL)).await.unwrap();
    assert_eq!(
        rig.provider.backend_for(&key(SERIAL)),
        Some(UsbBackendKind::Hid)
    );
    assert_eq!(rig.provider.max_packet_bytes(&key(SERIAL)), Some(64));
    let warnings = rig.lines.warnings();
    assert_eq!(warnings.len(), 1, "a degraded link must not be silent");
    assert!(
        warnings[0].contains("LIBUSB_ERROR_ACCESS"),
        "{}",
        warnings[0]
    );
    assert!(
        warnings[0].contains("copy/move cannot be sent at all"),
        "{}",
        warnings[0]
    );
}

#[tokio::test]
async fn names_both_failures_when_neither_backend_opens_and_warns_of_no_fallback() {
    let mut hid = hid_brick(SERIAL);
    hid.open_error = Some("no HID device".into());
    let rig = rig_with(
        Platform::Windows,
        vec![Spec {
            claim_error: Some(UsbError::Access),
            ..Spec::serial(SERIAL)
        }],
        hid,
        None,
    );
    let error = rig.provider.connect(&key(SERIAL)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::TransportFailed);
    assert!(
        error.message.contains(
            "libusb: Could not claim USB interface 0 on the brick. (LIBUSB_ERROR_ACCESS). HID: "
        ),
        "{}",
        error.message
    );
    assert!(error.message.contains("no HID device"), "{}", error.message);
    // While a cable is out every reconnect fails both ways; a warning per attempt about a
    // fallback that never happened filled the log during a cable pull.
    assert!(rig.lines.warnings().is_empty());
    assert_eq!(rig.provider.backend_for(&key(SERIAL)), None);
}

#[tokio::test]
async fn reports_no_packet_size_for_a_brick_that_is_not_connected() {
    let rig = rig(vec![Spec::serial(SERIAL)]);
    assert_eq!(rig.provider.max_packet_bytes(&key(SERIAL)), None);
    assert_eq!(rig.provider.backend_for(&key(SERIAL)), None);
}

#[tokio::test]
async fn forgets_the_backend_on_disconnect_and_gives_the_device_back() {
    let rig = rig(vec![Spec::serial(SERIAL)]);
    rig.provider.connect(&key(SERIAL)).await.unwrap();
    rig.provider.disconnect(&key(SERIAL)).await.unwrap();
    assert_eq!(rig.provider.max_packet_bytes(&key(SERIAL)), None);
    assert_eq!(rig.provider.backend_for(&key(SERIAL)), None);
    let events = rig.bus.log.events();
    assert_eq!(events[events.len() - 2..], ["release", "close"]);
}

#[tokio::test]
async fn a_second_connect_to_a_connected_brick_is_refused() {
    let rig = rig(vec![Spec::serial(SERIAL)]);
    rig.provider.connect(&key(SERIAL)).await.unwrap();
    let error = rig.provider.connect(&key(SERIAL)).await.unwrap_err();
    assert_eq!(error.message, "001653AABBCC USB is already connected.");
}

#[tokio::test]
async fn sends_over_the_session_and_refuses_a_brick_without_one() {
    let rig = rig(vec![Spec {
        replies: vec![padded(1, &[0x02, 0x00])],
        ..Spec::serial(SERIAL)
    }]);
    rig.provider.connect(&key(SERIAL)).await.unwrap();
    let options = SendOptions {
        expected_message_counter: Some(1),
        ..SendOptions::default()
    };
    let reply = rig
        .provider
        .send_packet(&key(SERIAL), &command_of(1, 7), &options)
        .await
        .unwrap();
    assert_eq!(reply, reply_packet(1, &[0x02, 0x00]));
    let error = rig
        .provider
        .send_packet(&key(OTHER), &command_of(1, 7), &options)
        .await
        .unwrap_err();
    assert_eq!(error.message, "001653DDEEFF USB is not connected.");
}

#[tokio::test]
async fn declares_what_it_offers() {
    let rig = rig(vec![]);
    assert_eq!(rig.provider.transport(), Transport::Usb);
    assert_eq!(rig.provider.priority(), 30);
    let capabilities = rig.provider.capabilities();
    assert!(capabilities.supports_probe);
    assert!(capabilities.supports_telemetry_frames);
    assert!(!capabilities.supports_recover);
    assert!(!capabilities.supports_forget);
    assert!(!capabilities.rejoin_on_evidence_only);
}

// ── A device this user may not open (Linux) ───────────────────────────────────────────────

fn refused_by_libusb() -> Spec {
    Spec {
        open_error: Some(UsbError::Access),
        ..Spec::serial(SERIAL)
    }
}

fn hid_refusing(access: NodeAccess) -> FakeHid {
    let mut hid = hid_brick(SERIAL);
    hid.open_error = Some("open failed".into());
    hid.access = access;
    hid
}

#[tokio::test]
async fn says_permission_when_libusb_is_refused_and_the_hidraw_node_is_refused_too() {
    let rig = rig_with(
        Platform::Linux,
        vec![refused_by_libusb()],
        hid_refusing(NodeAccess::Denied),
        None,
    );
    let error = rig.provider.connect(&key(SERIAL)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::TransportFailed);
    assert!(error.message.contains("udev rule"), "{}", error.message);
    assert!(
        error.message.contains("hidraw3"),
        "the HID half stays in the message for the log: {}",
        error.message
    );
}

#[tokio::test]
async fn gives_the_advice_once_with_the_rule_where_this_install_keeps_it() {
    let rule = "/opt/example/ev3-cockpit/native/linux/70-lego-ev3.rules";
    let rig = rig_with(
        Platform::Linux,
        vec![refused_by_libusb()],
        hid_refusing(NodeAccess::Denied),
        Some(rule),
    );
    let message = rig
        .provider
        .connect(&key(SERIAL))
        .await
        .unwrap_err()
        .message;
    assert_eq!(
        message.matches("Install the udev rule").count(),
        1,
        "{message}"
    );
    assert!(
        message.contains(&format!("copy {rule} to /etc/udev/rules.d/")),
        "{message}"
    );
    assert!(message.contains("group plugdev"), "{message}");
    assert!(
        message.contains("libusb: refused (LIBUSB_ERROR_ACCESS)"),
        "{message}"
    );
}

#[tokio::test]
async fn still_falls_back_to_hid_when_hid_may_open_it() {
    let rig = rig_with(
        Platform::Linux,
        vec![refused_by_libusb()],
        hid_brick(SERIAL),
        None,
    );
    rig.provider.connect(&key(SERIAL)).await.unwrap();
    assert_eq!(
        rig.provider.backend_for(&key(SERIAL)),
        Some(UsbBackendKind::Hid)
    );
    assert_eq!(rig.lines.warnings().len(), 1);
}

#[tokio::test]
async fn says_permission_when_only_the_hidraw_node_is_refused_whatever_libusb_said() {
    let rig = rig_with(
        Platform::Linux,
        vec![Spec {
            claim_error: Some(UsbError::Busy),
            ..Spec::serial(SERIAL)
        }],
        hid_refusing(NodeAccess::Denied),
        None,
    );
    let message = rig
        .provider
        .connect(&key(SERIAL))
        .await
        .unwrap_err()
        .message;
    assert!(
        message.contains("native/linux/70-lego-ev3.rules"),
        "{message}"
    );
}

#[tokio::test]
async fn does_not_send_a_user_to_the_udev_rule_when_the_hidraw_node_is_open_to_them() {
    let rig = rig_with(
        Platform::Linux,
        vec![refused_by_libusb()],
        hid_refusing(NodeAccess::Granted),
        None,
    );
    let message = rig
        .provider
        .connect(&key(SERIAL))
        .await
        .unwrap_err()
        .message;
    // The plain form, naming both failures; not the permission form, which would tell the user
    // the device is closed to them when the rule is plainly in place for hidraw.
    assert!(
        message.starts_with("Connect failed for 001653AABBCC USB. libusb: "),
        "{message}"
    );
    assert!(!message.contains("this user may not open the EV3's USB device. "));
}

#[tokio::test]
async fn never_checks_the_hidraw_node_on_windows() {
    let rig = rig_with(
        Platform::Windows,
        vec![refused_by_libusb()],
        hid_refusing(NodeAccess::Denied),
        None,
    );
    let message = rig
        .provider
        .connect(&key(SERIAL))
        .await
        .unwrap_err()
        .message;
    assert!(!message.contains("udev"), "{message}");
    assert!(rig.hid.log.lock().unwrap().access_asked.is_empty());
}

// ── Probes ────────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_connect_waits_for_an_open_probe_so_it_lands_on_libusb_rather_than_hid() {
    let rig = Arc::new(rig(vec![Spec::serial(SERIAL)]));
    let mut probe = rig.provider.open_probe(&key(SERIAL)).await.unwrap();
    let connecting = tokio::spawn({
        let rig = rig.clone();
        async move { rig.provider.connect(&key(SERIAL)).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        rig.provider.backend_for(&key(SERIAL)),
        None,
        "the connect must wait for the probe"
    );
    probe.close().await;
    connecting.await.unwrap().unwrap();
    assert_eq!(
        rig.provider.backend_for(&key(SERIAL)),
        Some(UsbBackendKind::Libusb)
    );
}

#[tokio::test]
async fn refuses_a_probe_of_a_brick_that_has_a_session() {
    let rig = rig(vec![Spec::serial(SERIAL)]);
    rig.provider.connect(&key(SERIAL)).await.unwrap();
    let error = rig.provider.open_probe(&key(SERIAL)).await.err().unwrap();
    assert_eq!(
        error.message,
        "001653AABBCC USB has a session; ask it instead."
    );
}

#[tokio::test]
async fn a_probe_asks_outside_the_session_over_libusb() {
    let rig = rig(vec![Spec {
        replies: vec![padded(1, &[0x41])],
        ..Spec::serial(SERIAL)
    }]);
    let mut probe = rig.provider.open_probe(&key(SERIAL)).await.unwrap();
    let options = SendOptions {
        expected_message_counter: Some(1),
        ..SendOptions::default()
    };
    let reply = probe
        .send_packet(&command_of(1, 7), &options)
        .await
        .unwrap();
    assert_eq!(reply, reply_packet(1, &[0x41]));
    probe.close().await;
    assert_eq!(rig.bus.log.get().released, 1);
}

#[tokio::test]
async fn nothing_opens_a_device_an_open_probe_holds() {
    let rig = rig_with(
        Platform::Windows,
        vec![Spec::serial(SERIAL), Spec::serial(OTHER)],
        FakeHid::new(vec![
            FakeHid::brick("hid-1", SERIAL, None),
            FakeHid::brick("hid-2", OTHER, None),
        ]),
        None,
    );
    let mut probe = rig.provider.open_probe(&key(SERIAL)).await.unwrap();
    rig.bus.log.get().opened.clear();
    rig.provider.discover().await.unwrap();
    rig.provider.connect(&key(OTHER)).await.unwrap();
    assert!(
        !rig.bus.log.get().opened.contains(&SERIAL.to_owned()),
        "neither a scan nor another connect may open the probed brick"
    );
    probe.close().await;
}

#[tokio::test]
async fn a_closing_probe_keeps_its_device_in_use_until_libusb_lets_go() {
    let rig = Arc::new(rig(vec![Spec {
        hold_reads: 1,
        ..Spec::serial(SERIAL)
    }]));
    let mut probe = rig.provider.open_probe(&key(SERIAL)).await.unwrap();
    let options = SendOptions {
        timeout: Some(Duration::from_millis(10)),
        expected_message_counter: Some(1),
    };
    let _ = probe.send_packet(&command_of(1, 7), &options).await;
    let closing = tokio::spawn(async move { probe.close().await });
    tokio::time::sleep(Duration::from_millis(30)).await;
    rig.bus.log.get().opened.clear();
    rig.provider.discover().await.unwrap();
    assert!(
        rig.bus.log.get().opened.is_empty(),
        "the device is closing, not free: a read is still with libusb"
    );
    rig.bus.log.answer_read(Err(UsbError::Interrupted));
    closing.await.unwrap();
    rig.provider.discover().await.unwrap();
    assert_eq!(rig.bus.log.get().opened, [SERIAL]);
}

// ── Lifetime ──────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn answers_two_connects_to_one_brick_with_one_link() {
    let rig = rig(vec![Spec::serial(SERIAL)]);
    let brick = key(SERIAL);
    let (a, b) = tokio::join!(rig.provider.connect(&brick), rig.provider.connect(&brick));
    assert_eq!(a.unwrap(), b.unwrap());
    assert_eq!(rig.bus.log.get().claimed, 1);
}

#[tokio::test]
async fn dispose_closes_every_session_and_probe_before_it_returns() {
    let rig = rig_with(
        Platform::Windows,
        vec![Spec::serial(SERIAL), Spec::serial(OTHER)],
        FakeHid::new(vec![]),
        None,
    );
    rig.provider.connect(&key(SERIAL)).await.unwrap();
    let _probe = rig.provider.open_probe(&key(OTHER)).await.unwrap();
    rig.provider.dispose().await;
    assert_eq!(rig.bus.log.get().released, 2);
    assert_eq!(rig.provider.backend_for(&key(SERIAL)), None);
}

#[tokio::test]
async fn refuses_every_operation_after_the_dispose_and_opens_nothing() {
    let rig = rig(vec![Spec::serial(SERIAL)]);
    rig.provider.dispose().await;
    let disposed = "The USB provider has been disposed.";
    assert_eq!(
        rig.provider
            .connect(&key(SERIAL))
            .await
            .unwrap_err()
            .message,
        disposed
    );
    assert_eq!(
        rig.provider
            .open_probe(&key(SERIAL))
            .await
            .err()
            .unwrap()
            .message,
        disposed
    );
    assert_eq!(rig.provider.discover().await.unwrap_err().message, disposed);
    assert!(rig.bus.log.get().opened.is_empty());
}

#[tokio::test]
async fn a_dispose_ends_a_connect_waiting_on_a_lock_a_probe_holds() {
    let rig = Arc::new(rig(vec![Spec::serial(SERIAL)]));
    let _probe = rig.provider.open_probe(&key(SERIAL)).await.unwrap();
    let connecting = tokio::spawn({
        let rig = rig.clone();
        async move { rig.provider.connect(&key(SERIAL)).await }
    });
    tokio::time::sleep(Duration::from_millis(30)).await;
    rig.provider.dispose().await;
    let error = connecting.await.unwrap().unwrap_err();
    assert_eq!(error.message, "The USB provider has been disposed.");
    assert_eq!(
        rig.bus.log.get().claimed,
        1,
        "only the probe's link was made"
    );
}

#[tokio::test]
async fn a_connect_whose_open_lands_after_the_dispose_keeps_no_session_and_tries_no_hid() {
    let rig = Arc::new(rig_with(
        Platform::Linux,
        vec![Spec {
            kernel_driver_active: true,
            hold_clear_halt: true,
            ..Spec::serial(SERIAL)
        }],
        hid_brick(SERIAL),
        None,
    ));
    let connecting = tokio::spawn({
        let rig = rig.clone();
        async move { rig.provider.connect(&key(SERIAL)).await }
    });
    rig.bus
        .log
        .wait_until("the clear-halt", |log| log.held_clear_halts.len() == 1)
        .await;
    let disposing = tokio::spawn({
        let rig = rig.clone();
        async move { rig.provider.dispose().await }
    });
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        !disposing.is_finished(),
        "the dispose waits for the open on the bus"
    );
    rig.bus.log.answer_clear_halt(0);
    rig.bus
        .log
        .wait_until("the second clear-halt", |log| {
            log.held_clear_halts.len() == 1
        })
        .await;
    rig.bus.log.answer_clear_halt(0);
    let error = connecting.await.unwrap().unwrap_err();
    assert_eq!(error.message, "The USB provider has been disposed.");
    disposing.await.unwrap();
    assert_eq!(rig.provider.backend_for(&key(SERIAL)), None);
    assert_eq!(rig.bus.log.get().released, 1);
    assert!(rig.hid.log.lock().unwrap().opened.is_empty());
}
