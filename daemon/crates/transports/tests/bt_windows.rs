//! The Bluetooth provider on Windows, driven through fakes of the Windows calls and the RFCOMM
//! connector: discovery, sessions, the connect rules (one attempt, the gap after a close, the
//! recovery after a failure), presence, pairing and forget. Also the Winsock data path's rules
//! over in-memory streams, and the pairing ceremony's rules over fake WinRT steps.
#![cfg(windows)]

mod common;

use std::collections::{HashMap, VecDeque};
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use async_trait::async_trait;
use common::{reply_packet, request};
use ev3_protocol::packet::decode_ev3_packet;
use ev3_transports::bt::presence::{PresenceTimings, ScannedBrick};
use ev3_transports::bt::queue::{BtConnectionQueue, QueueTimings, SlotKind};
use ev3_transports::bt_windows::discovery::{DeviceRecord, PlatformError};
use ev3_transports::bt_windows::forget::{unpair_result, windows_residue};
use ev3_transports::bt_windows::pairing::{
    EV3_OFFER, PAIRING_CANCELLED, PROVIDE_PIN, PairResult, PairingCancel, PairingOffer,
    PairingSteps, answer_pairing_request, describe_status, outcome_of_status, run_pairing,
    status_name,
};
use ev3_transports::bt_windows::sdp::SdpAnswer;
use ev3_transports::bt_windows::winsock::{
    ConnectFailure, PendingConnect, RfcommConnector, RfcommLink, StreamLink, finish_connect,
};
use ev3_transports::bt_windows::{BluetoothPlatform, BtWindowsSettings, WindowsBtProvider};
use ev3_transports::{
    BrickKey, ErrorCode, Exchanger, LinkIo, NameSource, PairingOutcome, SendOptions, SignalInfo,
    Transport, TransportError, TransportProvider,
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::time::{Instant, sleep};

const AAA: &str = "00:16:53:AA:BB:CC";
const AAA_ADDRESS: u64 = 0x0016_53aa_bbcc;
const BBB: &str = "00:16:53:AA:BB:DD";
const CCC: &str = "00:16:53:AA:BB:EE";
const STRANGER: &str = "00:16:53:00:00:99";

fn key(mac: &str) -> BrickKey {
    BrickKey::new(Transport::Bt, mac).unwrap()
}

fn address(mac: &str) -> u64 {
    ev3_transports::bt::parse_mac(mac).unwrap()
}

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

// ── Fakes ───────────────────────────────────────────────────────────────

/// Windows, as a test sets it up.
#[derive(Default)]
struct FakeWindows {
    devices: Mutex<Vec<DeviceRecord>>,
    list_fails: Mutex<Option<PlatformError>>,
    /// What `BluetoothRemoveDevice` answers; 0 by default.
    remove_code: Mutex<u32>,
    removed: Mutex<Vec<u64>>,
    /// Presence answers per address, in order; silence once they run out.
    sdp: Mutex<HashMap<u64, VecDeque<bool>>>,
    sdp_delay: Mutex<Option<Duration>>,
    sdp_calls: AtomicUsize,
    inquiry: Mutex<Vec<ScannedBrick>>,
    pairing: Mutex<Option<PairingOutcome>>,
    pair_calls: AtomicUsize,
    /// A pairing blocks until cancelled.
    pair_blocks: AtomicBool,
}

impl FakeWindows {
    fn paired(self, mac: &str, name: &str) -> Self {
        self.devices.lock().unwrap().push(DeviceRecord {
            address: address(mac),
            name: name.into(),
            connected: false,
            remembered: true,
            authenticated: true,
            class_of_device: 0x0804,
        });
        self
    }

    fn answering(self, mac: &str, answers: &[bool]) -> Self {
        self.sdp
            .lock()
            .unwrap()
            .insert(address(mac), answers.iter().copied().collect());
        self
    }
}

impl BluetoothPlatform for FakeWindows {
    fn list_devices(&self) -> Result<Vec<DeviceRecord>, PlatformError> {
        if let Some(error) = self.list_fails.lock().unwrap().clone() {
            return Err(error);
        }
        Ok(self.devices.lock().unwrap().clone())
    }

    fn remove_device(&self, address: u64) -> u32 {
        self.removed.lock().unwrap().push(address);
        let code = *self.remove_code.lock().unwrap();
        if code == 0 {
            // As Windows does: the pairing goes, the in-memory record stays until a restart, so
            // the cache still lists the device, unpaired.
            for device in self.devices.lock().unwrap().iter_mut() {
                if device.address == address {
                    device.remembered = false;
                    device.authenticated = false;
                }
            }
        }
        code
    }

    fn serial_port_records(&self, address: u64) -> SdpAnswer {
        self.sdp_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(delay) = *self.sdp_delay.lock().unwrap() {
            std::thread::sleep(delay);
        }
        let answered = self
            .sdp
            .lock()
            .unwrap()
            .get_mut(&address)
            .and_then(VecDeque::pop_front)
            .unwrap_or(false);
        SdpAnswer {
            records: u32::from(answered),
            error: (!answered).then(|| "WSA 10108".into()),
        }
    }

    fn inquire(&self, _window: Duration) -> Result<Vec<ScannedBrick>, PlatformError> {
        Ok(self.inquiry.lock().unwrap().clone())
    }

    fn pair(&self, _address: u64, _window: Duration, cancel: &PairingCancel) -> PairingOutcome {
        self.pair_calls.fetch_add(1, Ordering::SeqCst);
        if self.pair_blocks.load(Ordering::SeqCst) {
            while !cancel.is_cancelled() {
                std::thread::sleep(ms(5));
            }
            return PairingOutcome {
                ok: false,
                reason: Some(PAIRING_CANCELLED.into()),
                status: None,
            };
        }
        self.pairing
            .lock()
            .unwrap()
            .clone()
            .unwrap_or(PairingOutcome {
                ok: true,
                reason: None,
                status: Some("Paired".into()),
            })
    }

    fn radio_name(&self) -> Option<String> {
        Some("HOSTA".into())
    }
}

/// When each brick's link was last closed, by address.
type CloseTimes = Arc<Mutex<HashMap<u64, Instant>>>;

/// A brick at the far end of a fake link: answers each request with its payload plus one, and
/// notes when its link is closed.
struct FakeBrick {
    waiting: Vec<u8>,
    broken: bool,
    address: u64,
    closed_at: CloseTimes,
}

impl Drop for FakeBrick {
    fn drop(&mut self) {
        self.closed_at
            .lock()
            .unwrap()
            .insert(self.address, Instant::now());
    }
}

/// The fake brick hangs up on this payload.
const HANG_UP: u8 = 0xee;
/// The fake brick never answers this payload.
const SILENT: u8 = 0xdd;

#[async_trait]
impl LinkIo for FakeBrick {
    async fn write_packet(&mut self, packet: &[u8]) -> Result<(), TransportError> {
        if self.broken {
            return Err(TransportError::transport_failed(
                "BT connection closed by the brick.",
            ));
        }
        let decoded = decode_ev3_packet(packet).unwrap();
        match decoded.payload.first().copied() {
            Some(HANG_UP) => self.broken = true,
            Some(SILENT) => {}
            _ => {
                let payload: Vec<u8> = decoded.payload.iter().map(|b| b.wrapping_add(1)).collect();
                self.waiting
                    .extend(reply_packet(decoded.message_counter, &payload));
            }
        }
        Ok(())
    }

    async fn read_some(&mut self, into: &mut Vec<u8>) -> Result<(), TransportError> {
        if self.broken {
            return Err(TransportError::transport_failed(
                "BT connection closed by the brick.",
            ));
        }
        if self.waiting.is_empty() {
            return std::future::pending().await;
        }
        into.append(&mut self.waiting);
        Ok(())
    }
}

impl RfcommLink for FakeBrick {
    fn is_broken(&self) -> bool {
        self.broken
    }
}

enum Open {
    Fail(ConnectFailure),
    /// Opens only once released.
    Held(Arc<tokio::sync::Notify>),
}

/// The RFCOMM connector, scripted per brick; a brick with no script opens at once.
#[derive(Default)]
struct FakeConnector {
    scripts: Mutex<HashMap<u64, VecDeque<Open>>>,
    opens: Mutex<Vec<(u64, Instant)>>,
    order: Mutex<Vec<String>>,
    closed_at: CloseTimes,
    /// A connect this soon after the brick's link was closed fails with WSA 10064, as a real
    /// brick's did 0-2 s after a clean close.
    refuses_within: Mutex<Option<Duration>>,
}

impl FakeConnector {
    fn then(&self, mac: &str, open: Open) {
        self.scripts
            .lock()
            .unwrap()
            .entry(address(mac))
            .or_default()
            .push_back(open);
    }

    fn opens_of(&self, mac: &str) -> Vec<Instant> {
        self.opens
            .lock()
            .unwrap()
            .iter()
            .filter(|(a, _)| *a == address(mac))
            .map(|(_, at)| *at)
            .collect()
    }
}

#[async_trait]
impl RfcommConnector for FakeConnector {
    async fn open(
        &self,
        address: u64,
        _deadline: Duration,
    ) -> Result<Box<dyn RfcommLink>, ConnectFailure> {
        self.opens.lock().unwrap().push((address, Instant::now()));
        self.order.lock().unwrap().push(format!("open {address:x}"));
        let refuses_within = *self.refuses_within.lock().unwrap();
        let closed_at = self.closed_at.lock().unwrap().get(&address).copied();
        if let (Some(within), Some(closed)) = (refuses_within, closed_at)
            && closed.elapsed() < within
        {
            return Err(ConnectFailure::from_code(10064));
        }
        let next = self
            .scripts
            .lock()
            .unwrap()
            .get_mut(&address)
            .and_then(VecDeque::pop_front);
        match next {
            Some(Open::Fail(failure)) => return Err(failure),
            Some(Open::Held(release)) => {
                release.notified().await;
                self.order
                    .lock()
                    .unwrap()
                    .push(format!("opened {address:x}"));
            }
            None => {}
        }
        Ok(Box::new(FakeBrick {
            waiting: Vec::new(),
            broken: false,
            address,
            closed_at: Arc::clone(&self.closed_at),
        }))
    }
}

fn quick_settings() -> BtWindowsSettings {
    BtWindowsSettings {
        reconnect_gap: ms(150),
        startup_busy_window: Duration::ZERO,
        presence_check_timeout: ms(300),
        pairing_timeout: Duration::from_secs(5),
        queue: QueueTimings {
            inter_connection_cooldown: Duration::ZERO,
            error_recovery_cooldown: Duration::ZERO,
            error_backoff_max: Duration::from_secs(30),
            acquire_timeout: Duration::from_secs(2),
        },
        presence: PresenceTimings::default(),
        ..BtWindowsSettings::default()
    }
}

struct Rig {
    provider: WindowsBtProvider,
    windows: Arc<FakeWindows>,
    connector: Arc<FakeConnector>,
}

fn rig_with(windows: FakeWindows, settings: BtWindowsSettings) -> Rig {
    let windows = Arc::new(windows);
    let connector = Arc::new(FakeConnector::default());
    let provider = WindowsBtProvider::new(
        Arc::clone(&windows) as Arc<dyn BluetoothPlatform>,
        Arc::clone(&connector) as Arc<dyn RfcommConnector>,
        Arc::new(BtConnectionQueue::new(settings.queue)),
        settings,
    );
    Rig {
        provider,
        windows,
        connector,
    }
}

fn rig(windows: FakeWindows) -> Rig {
    rig_with(windows, quick_settings())
}

fn expecting(counter: u16) -> SendOptions {
    SendOptions {
        expected_message_counter: Some(counter),
        ..SendOptions::default()
    }
}

// ── What it declares ────────────────────────────────────────────────────

#[test]
fn ships_the_measured_timings() {
    let settings = BtWindowsSettings::default();
    assert_eq!(settings.connect_timeout, Duration::from_secs(15));
    assert_eq!(settings.send_timeout, Duration::from_secs(2));
    assert_eq!(settings.reconnect_gap, Duration::from_secs(5));
    assert_eq!(settings.presence_check_timeout, Duration::from_secs(10));
    assert_eq!(settings.inquiry_window, Duration::from_secs(10));
    assert_eq!(settings.pairing_inquiry_window, Duration::from_secs(30));
    assert_eq!(settings.pairing_timeout, Duration::from_secs(120));
    assert_eq!(settings.queue, QueueTimings::default());
}

#[test]
fn declares_bluetooth_between_a_cable_and_wifi_and_what_it_offers() {
    let rig = rig(FakeWindows::default());
    assert_eq!(rig.provider.transport(), Transport::Bt);
    assert_eq!(rig.provider.priority(), 20);
    let caps = rig.provider.capabilities();
    assert!(caps.supports_forget && caps.supports_pairing && caps.supports_presence);
    assert!(caps.supports_recover && caps.supports_telemetry_frames);
    assert!(
        caps.rejoin_on_evidence_only,
        "every attempt pages the one radio"
    );
    assert!(!caps.supports_probe && !caps.supports_signal_info);
}

// ── Discovery ───────────────────────────────────────────────────────────

#[tokio::test]
async fn lists_a_paired_brick_under_its_cached_name() {
    let rig = rig(FakeWindows::default().paired(AAA, "AAA"));
    let items = rig.provider.discover().await.unwrap().items;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].brick_key, key(AAA));
    assert_eq!(items[0].display_name, "AAA");
    assert_eq!(items[0].name_source, Some(NameSource::BtCache));
    assert_eq!(items[0].paired, Some(true));
    assert!(items[0].remembered);
    assert_eq!(items[0].heard, None, "nothing checked yet");
}

#[tokio::test]
async fn falls_back_to_the_address_when_the_cache_has_no_name_which_is_the_usual_case() {
    let rig = rig(FakeWindows::default().paired(AAA, ""));
    let items = rig.provider.discover().await.unwrap().items;
    assert_eq!(items[0].display_name, "001653AABBCC");
    assert_eq!(items[0].name_source, Some(NameSource::Fallback));
}

#[tokio::test]
async fn lists_only_lego_devices_however_they_are_named() {
    let windows = FakeWindows::default().paired(AAA, "AAA");
    windows.devices.lock().unwrap().push(DeviceRecord {
        address: 0x0012_3456_789a,
        name: "EV3 phone".into(),
        connected: false,
        remembered: true,
        authenticated: true,
        class_of_device: 0x0804,
    });
    let rig = rig(windows);
    let items = rig.provider.discover().await.unwrap().items;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].brick_key, key(AAA));
}

#[tokio::test]
async fn a_failed_enumeration_is_a_failed_scan_not_an_empty_one() {
    let rig = rig(FakeWindows::default().paired(AAA, "AAA"));
    *rig.windows.list_fails.lock().unwrap() = Some(PlatformError::Failed("bthprops".into()));
    let error = rig.provider.discover().await.unwrap_err();
    assert_eq!(error.code, ErrorCode::TransportFailed);
    assert!(
        error.message.starts_with("BT discovery failed"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn names_the_paired_bricks_without_a_session_as_the_ones_to_check() {
    let rig = rig(FakeWindows::default().paired(AAA, "").paired(BBB, ""));
    rig.provider.discover().await.unwrap();
    assert_eq!(rig.provider.paired_without_session(), [AAA, BBB]);
    rig.provider.connect(&key(AAA)).await.unwrap();
    assert_eq!(rig.provider.paired_without_session(), [BBB]);
    let items = rig.provider.discover().await.unwrap().items;
    assert!(items.iter().any(|i| i.brick_key == key(AAA) && i.connected));
}

#[tokio::test]
async fn keeps_listing_a_paired_brick_that_stopped_answering_flagged_as_not_heard() {
    let rig = rig(FakeWindows::default()
        .paired(AAA, "AAA")
        .answering(AAA, &[false, false, false]));
    rig.provider.discover().await.unwrap();
    for _ in 0..3 {
        rig.provider.run_presence_checks().await;
    }
    let items = rig.provider.discover().await.unwrap().items;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].heard, Some(false));
}

#[tokio::test]
async fn a_paired_brick_that_answered_is_heard_with_the_time_it_answered() {
    let rig = rig(FakeWindows::default()
        .paired(AAA, "AAA")
        .answering(AAA, &[true]));
    rig.provider.discover().await.unwrap();
    rig.provider.run_presence_checks().await;
    let items = rig.provider.discover().await.unwrap().items;
    assert_eq!(items[0].heard, Some(true));
    assert!(items[0].heard_at.is_some());
}

#[tokio::test]
async fn lists_an_unpaired_brick_the_inquiry_heard_with_its_signal() {
    let windows = FakeWindows::default().paired(AAA, "AAA");
    *windows.inquiry.lock().unwrap() = vec![
        ScannedBrick {
            mac: STRANGER.into(),
            name: "XYZ".into(),
            paired: false,
            signal: Some(-55),
        },
        ScannedBrick {
            mac: "00:12:34:56:78:9A".into(),
            name: "a phone".into(),
            paired: false,
            signal: Some(-40),
        },
    ];
    let rig = rig(windows);
    rig.provider.run_inquiry().await;
    let items = rig.provider.discover().await.unwrap().items;
    let stranger = items.iter().find(|i| i.brick_key == key(STRANGER)).unwrap();
    assert_eq!(stranger.paired, Some(false));
    assert_eq!(stranger.display_name, "XYZ");
    assert_eq!(
        stranger.signal_info,
        Some(SignalInfo {
            rssi: Some(-55),
            strength: None
        })
    );
    assert_eq!(items.len(), 2, "the phone is not a brick");
}

// ── Connecting ──────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn connects_to_the_brick_address_and_exchanges() {
    let rig = rig(FakeWindows::default());
    let handle = rig.provider.connect(&key(AAA)).await.unwrap();
    assert_eq!(handle.transport, Transport::Bt);
    assert_eq!(rig.connector.opens.lock().unwrap()[0].0, AAA_ADDRESS);
    let answer = rig
        .provider
        .send_packet(&key(AAA), &request(1, &[0x10]), &expecting(1))
        .await
        .unwrap();
    assert_eq!(answer, reply_packet(1, &[0x11]));
}

#[tokio::test(start_paused = true)]
async fn lets_a_second_brick_connect_while_the_first_stays_connected() {
    let rig = rig(FakeWindows::default());
    rig.provider.connect(&key(AAA)).await.unwrap();
    let second = rig.provider.connect(&key(BBB)).await.unwrap();
    assert_eq!(second.brick_key, key(BBB));
}

#[tokio::test(start_paused = true)]
async fn still_opens_one_connection_at_a_time() {
    let rig = rig(FakeWindows::default());
    let release = Arc::new(tokio::sync::Notify::new());
    rig.connector.then(AAA, Open::Held(Arc::clone(&release)));
    let provider = Arc::new(rig.provider);
    let first = {
        let provider = Arc::clone(&provider);
        tokio::spawn(async move { provider.connect(&key(AAA)).await })
    };
    tokio::task::yield_now().await;
    let second = {
        let provider = Arc::clone(&provider);
        tokio::spawn(async move { provider.connect(&key(BBB)).await })
    };
    sleep(ms(30)).await;
    assert_eq!(
        *rig.connector.order.lock().unwrap(),
        ["open 1653aabbcc"],
        "the second open must wait for the first"
    );
    release.notify_one();
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    assert_eq!(
        *rig.connector.order.lock().unwrap(),
        ["open 1653aabbcc", "opened 1653aabbcc", "open 1653aabbdd"]
    );
}

#[tokio::test(start_paused = true)]
async fn answers_two_connects_to_one_brick_with_one_link() {
    let rig = rig(FakeWindows::default());
    let release = Arc::new(tokio::sync::Notify::new());
    rig.connector.then(AAA, Open::Held(Arc::clone(&release)));
    let provider = Arc::new(rig.provider);
    let attempts: Vec<_> = (0..2)
        .map(|_| {
            let provider = Arc::clone(&provider);
            tokio::spawn(async move { provider.connect(&key(AAA)).await })
        })
        .collect();
    sleep(ms(10)).await;
    release.notify_one();
    for attempt in attempts {
        assert_eq!(attempt.await.unwrap().unwrap().brick_key, key(AAA));
    }
    assert_eq!(rig.connector.opens_of(AAA).len(), 1);
    let again = provider.connect(&key(AAA)).await.unwrap_err();
    assert!(
        again.message.contains("already connected"),
        "{}",
        again.message
    );
}

#[tokio::test(start_paused = true)]
async fn a_failed_connect_ends_the_attempt_and_the_next_waits_out_the_recovery() {
    let settings = BtWindowsSettings {
        queue: QueueTimings::default(),
        ..quick_settings()
    };
    let rig = rig_with(FakeWindows::default(), settings);
    rig.connector
        .then(AAA, Open::Fail(ConnectFailure::from_code(10064)));
    let error = rig.provider.connect(&key(AAA)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::TransportFailed);
    assert!(
        error.message.contains("WSA error 10064"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("did not answer"),
        "{}",
        error.message
    );
    assert_eq!(
        rig.connector.opens_of(AAA).len(),
        1,
        "no second try inside the attempt"
    );

    rig.provider.connect(&key(AAA)).await.unwrap();
    let opens = rig.connector.opens_of(AAA);
    assert!(
        opens[1] - opens[0] >= Duration::from_secs(30),
        "reopened after {:?}, inside the recovery",
        opens[1] - opens[0]
    );
}

#[tokio::test(start_paused = true)]
async fn a_connect_deadline_closes_the_attempt_and_leaves_bluetooth_usable_for_the_next() {
    let rig = rig(FakeWindows::default());
    rig.connector.then(
        AAA,
        Open::Fail(ConnectFailure::TimedOut(Duration::from_secs(15))),
    );
    let error = rig.provider.connect(&key(AAA)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(rig.provider.queue().active(), 0, "the slot is not kept");
    rig.provider.connect(&key(AAA)).await.unwrap();
    assert_eq!(
        rig.connector.opens_of(AAA).len(),
        2,
        "the next connect reached the stack"
    );
}

#[tokio::test(start_paused = true)]
async fn gives_a_brick_its_gap_after_a_close_before_connecting_to_it_again() {
    let rig = rig(FakeWindows::default());
    rig.provider.connect(&key(AAA)).await.unwrap();
    rig.provider.disconnect(&key(AAA)).await.unwrap();
    rig.provider.connect(&key(AAA)).await.unwrap();
    let opens = rig.connector.opens_of(AAA);
    assert!(
        opens[1] - opens[0] >= ms(150),
        "reopened after {:?}",
        opens[1] - opens[0]
    );
}

/// A brick that answers WSA 10064 to a connect 0-2 s after its link was closed, as every brick
/// measured did; from 5 s on it opened.
fn rig_refusing_soon_after_a_close(reconnect_gap: Duration) -> Rig {
    let rig = rig_with(
        FakeWindows::default(),
        BtWindowsSettings {
            reconnect_gap,
            ..quick_settings()
        },
    );
    *rig.connector.refuses_within.lock().unwrap() = Some(Duration::from_secs(2));
    rig
}

#[tokio::test(start_paused = true)]
async fn the_shipped_gap_after_a_close_keeps_a_reconnect_clear_of_wsa_10064() {
    let rig = rig_refusing_soon_after_a_close(Duration::from_secs(5));
    rig.provider.connect(&key(AAA)).await.unwrap();
    rig.provider.disconnect(&key(AAA)).await.unwrap();
    rig.provider.connect(&key(AAA)).await.unwrap();
    let opens = rig.connector.opens_of(AAA);
    assert!(opens[1] - opens[0] >= Duration::from_secs(5));
}

#[tokio::test(start_paused = true)]
async fn wsa_10064_after_a_close_reads_as_a_brick_that_did_not_answer() {
    let rig = rig_refusing_soon_after_a_close(Duration::ZERO);
    rig.provider.connect(&key(AAA)).await.unwrap();
    rig.provider.disconnect(&key(AAA)).await.unwrap();
    let error = rig.provider.connect(&key(AAA)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::TransportFailed);
    assert!(
        error.message.contains("WSA error 10064"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("did not answer"),
        "{}",
        error.message
    );
}

/// A daemon that has just replaced another: the shipped five-second window, started now.
fn rig_just_started() -> Rig {
    rig_with(
        FakeWindows::default(),
        BtWindowsSettings {
            daemon_started: Instant::now(),
            startup_busy_window: Duration::from_secs(5),
            ..quick_settings()
        },
    )
}

#[tokio::test(start_paused = true)]
async fn a_first_connect_refused_with_wsa_10064_just_after_the_start_is_tried_again_at_five_seconds()
 {
    let rig = rig_just_started();
    let started = Instant::now();
    rig.connector
        .then(AAA, Open::Fail(ConnectFailure::from_code(10064)));
    rig.provider.connect(&key(AAA)).await.unwrap();
    let opens = rig.connector.opens_of(AAA);
    assert_eq!(opens.len(), 2);
    assert!(opens[0] - started < Duration::from_secs(1));
    assert!(opens[1] - started >= Duration::from_secs(5));
}

#[tokio::test(start_paused = true)]
async fn wsa_10064_after_the_first_five_seconds_is_not_tried_again() {
    let rig = rig_just_started();
    sleep(Duration::from_secs(6)).await;
    rig.connector
        .then(AAA, Open::Fail(ConnectFailure::from_code(10064)));
    let error = rig.provider.connect(&key(AAA)).await.unwrap_err();
    assert!(
        error.message.contains("WSA error 10064"),
        "{}",
        error.message
    );
    assert_eq!(rig.connector.opens_of(AAA).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn wsa_10064_on_a_second_connect_just_after_the_start_is_not_tried_again() {
    let rig = rig_just_started();
    rig.provider.connect(&key(AAA)).await.unwrap();
    rig.provider.disconnect(&key(AAA)).await.unwrap();
    rig.connector
        .then(AAA, Open::Fail(ConnectFailure::from_code(10064)));
    assert!(rig.provider.connect(&key(AAA)).await.is_err());
    assert_eq!(rig.connector.opens_of(AAA).len(), 2);
}

#[tokio::test(start_paused = true)]
async fn another_refusal_just_after_the_start_is_not_tried_again() {
    let rig = rig_just_started();
    rig.connector
        .then(AAA, Open::Fail(ConnectFailure::from_code(10060)));
    assert!(rig.provider.connect(&key(AAA)).await.is_err());
    assert_eq!(rig.connector.opens_of(AAA).len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_disconnect_ends_an_exchange_in_flight_at_once() {
    let rig = rig(FakeWindows::default());
    rig.provider.connect(&key(AAA)).await.unwrap();
    let provider = Arc::new(rig.provider);
    let send = {
        let provider = Arc::clone(&provider);
        tokio::spawn(async move {
            provider
                .send_packet(
                    &key(AAA),
                    &request(1, &[SILENT]),
                    &SendOptions {
                        // The timer disabled: without the close signal this waits forever.
                        timeout: Some(Duration::ZERO),
                        expected_message_counter: Some(1),
                    },
                )
                .await
        })
    };
    sleep(ms(10)).await;
    tokio::time::timeout(Duration::from_secs(1), provider.disconnect(&key(AAA)))
        .await
        .expect("the disconnect waited for the exchange")
        .unwrap();
    let error = send.await.unwrap().unwrap_err();
    assert!(
        error.message.contains("closed while waiting"),
        "{}",
        error.message
    );
    assert!(
        !rig.connector.closed_at.lock().unwrap().is_empty(),
        "the link is closed"
    );
}

#[tokio::test(start_paused = true)]
async fn a_dispose_ends_an_exchange_in_flight_at_once() {
    let rig = rig(FakeWindows::default());
    rig.provider.connect(&key(AAA)).await.unwrap();
    let provider = Arc::new(rig.provider);
    let send = {
        let provider = Arc::clone(&provider);
        tokio::spawn(async move {
            provider
                .send_packet(
                    &key(AAA),
                    &request(1, &[SILENT]),
                    &SendOptions {
                        timeout: Some(Duration::ZERO),
                        expected_message_counter: Some(1),
                    },
                )
                .await
        })
    };
    sleep(ms(10)).await;
    tokio::time::timeout(Duration::from_secs(1), provider.dispose())
        .await
        .expect("the dispose waited for the exchange");
    assert!(send.await.unwrap().is_err());
}

#[tokio::test(start_paused = true)]
async fn does_not_make_another_brick_wait_for_that_gap() {
    let rig = rig(FakeWindows::default());
    let started = Instant::now();
    rig.provider.connect(&key(AAA)).await.unwrap();
    rig.provider.disconnect(&key(AAA)).await.unwrap();
    rig.provider.connect(&key(BBB)).await.unwrap();
    assert!(rig.connector.opens_of(BBB)[0] - started < ms(100));
}

#[tokio::test(start_paused = true)]
async fn a_brick_that_hangs_up_ends_its_session() {
    let rig = rig(FakeWindows::default());
    rig.provider.connect(&key(AAA)).await.unwrap();
    let error = rig
        .provider
        .send_packet(
            &key(AAA),
            &request(1, &[HANG_UP]),
            &SendOptions {
                timeout: Some(Duration::from_secs(5)),
                expected_message_counter: Some(1),
            },
        )
        .await
        .unwrap_err();
    assert!(
        error.message.contains("closed by the brick"),
        "{}",
        error.message
    );
    let after = rig
        .provider
        .send_packet(&key(AAA), &request(2, &[0x01]), &expecting(2))
        .await
        .unwrap_err();
    assert!(after.message.contains("not connected"), "{}", after.message);
}

#[tokio::test(start_paused = true)]
async fn times_out_an_exchange_the_brick_never_answers_and_stays_usable() {
    let rig = rig(FakeWindows::default());
    rig.provider.connect(&key(AAA)).await.unwrap();
    let silent = rig
        .provider
        .send_packet(
            &key(AAA),
            &request(1, &[SILENT]),
            &SendOptions {
                timeout: Some(ms(30)),
                expected_message_counter: Some(1),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(silent.code, ErrorCode::Timeout);
    let answer = rig
        .provider
        .send_packet(&key(AAA), &request(2, &[0x01]), &expecting(2))
        .await
        .unwrap();
    assert_eq!(answer, reply_packet(2, &[0x02]));
}

#[tokio::test(start_paused = true)]
async fn refuses_a_key_that_holds_no_address() {
    let rig = rig(FakeWindows::default());
    let error = rig
        .provider
        .connect(&key("not-an-address"))
        .await
        .unwrap_err();
    assert!(error.message.contains("Cannot extract a Bluetooth address"));
    assert!(rig.connector.opens.lock().unwrap().is_empty());
}

// ── Presence ────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_presence_round_over_three_paired_bricks_does_not_hold_a_user_connect_behind_it() {
    // The shipped pauses, and checks that take as long as a switched-off brick's, scaled down.
    let settings = BtWindowsSettings {
        queue: QueueTimings::default(),
        presence_check_timeout: Duration::from_secs(2),
        ..quick_settings()
    };
    let windows = FakeWindows::default()
        .paired(AAA, "")
        .paired(BBB, "")
        .paired(CCC, "");
    *windows.sdp_delay.lock().unwrap() = Some(ms(200));
    let rig = rig_with(windows, settings);
    rig.provider.discover().await.unwrap();
    let provider = Arc::new(rig.provider);
    let round = {
        let provider = Arc::clone(&provider);
        tokio::spawn(async move { provider.run_presence_checks().await })
    };
    sleep(ms(50)).await;
    let queued = std::time::Instant::now();
    provider.connect(&key(STRANGER)).await.unwrap();
    let waited = queued.elapsed();
    assert!(
        waited < ms(400),
        "the connect waited {waited:?}: behind the whole round, or behind a pause"
    );
    assert_eq!(
        rig.windows.sdp_calls.load(Ordering::SeqCst),
        1,
        "the connect went between the first check and the second"
    );
    // The rest of the round now waits out the gap the connect's release started.
    round.abort();
}

#[tokio::test]
async fn a_presence_check_holds_the_queue_for_mutual_exclusion_only() {
    let settings = BtWindowsSettings {
        queue: QueueTimings {
            inter_connection_cooldown: Duration::from_secs(15),
            error_recovery_cooldown: Duration::from_secs(30),
            ..QueueTimings::default()
        },
        ..quick_settings()
    };
    let rig = rig_with(FakeWindows::default().answering(AAA, &[true]), settings);
    assert!(rig.provider.check_presence(&key(AAA)).await.unwrap());
    assert!(!rig.provider.check_presence(&key(AAA)).await.unwrap());
    let queued = std::time::Instant::now();
    let slot = rig
        .provider
        .queue()
        .acquire("connect", SlotKind::Open)
        .await
        .unwrap();
    slot.release(false);
    assert!(queued.elapsed() < ms(200), "a check started a pause");
}

#[tokio::test]
async fn a_check_that_outlives_its_deadline_counts_as_not_heard() {
    let windows = FakeWindows::default().answering(AAA, &[true]);
    *windows.sdp_delay.lock().unwrap() = Some(ms(800));
    let rig = rig(windows);
    let started = std::time::Instant::now();
    assert!(!rig.provider.check_presence(&key(AAA)).await.unwrap());
    assert!(
        started.elapsed() < ms(700),
        "the check was waited out, not abandoned"
    );
}

// ── Pairing ─────────────────────────────────────────────────────────────

/// WinRT, as a pairing test sets it up.
#[derive(Default)]
struct FakeSteps {
    paired_in_records: bool,
    /// Per window: whether the brick appeared.
    windows: VecDeque<bool>,
    found_paired: bool,
    result: Option<PairResult>,
    watched: usize,
    offered: Option<PairingOffer>,
    cancel_during_watch: bool,
}

impl PairingSteps for FakeSteps {
    type Found = ();

    fn is_paired(&mut self, _address: u64) -> Result<bool, String> {
        Ok(self.paired_in_records)
    }

    fn watch(
        &mut self,
        _address: u64,
        _window: Duration,
        cancel: &PairingCancel,
    ) -> Result<Option<()>, String> {
        self.watched += 1;
        if self.cancel_during_watch {
            cancel.cancel();
            return Ok(None);
        }
        Ok(self.windows.pop_front().unwrap_or(false).then_some(()))
    }

    fn found_is_paired(&self, _found: &()) -> bool {
        self.found_paired
    }

    fn pair(
        &mut self,
        _found: (),
        offer: &PairingOffer,
        _cancel: &PairingCancel,
    ) -> Result<PairResult, String> {
        self.offered = Some(*offer);
        Ok(self
            .result
            .clone()
            .unwrap_or(PairResult::Status("Paired".into())))
    }
}

fn pair_with(steps: &mut FakeSteps) -> PairingOutcome {
    run_pairing(steps, AAA_ADDRESS, ms(10), &PairingCancel::default())
}

#[test]
fn a_pairing_offers_only_provide_pin_and_answers_only_that_kind_with_1234() {
    let mut steps = FakeSteps {
        windows: VecDeque::from([true]),
        ..FakeSteps::default()
    };
    let outcome = pair_with(&mut steps);
    assert!(outcome.ok);
    assert_eq!(outcome.status.as_deref(), Some("Paired"));
    assert_eq!(steps.offered, Some(EV3_OFFER));
    assert_eq!(EV3_OFFER.kinds, PROVIDE_PIN, "ProvidePin and nothing else");
    assert_eq!(EV3_OFFER.pin, "1234");

    assert_eq!(
        answer_pairing_request(&EV3_OFFER, PROVIDE_PIN),
        Some("1234")
    );
    // ConfirmOnly, DisplayPin, ConfirmPinMatch, ProvidePasswordCredential: left unanswered.
    for kind in [1, 2, 8, 16] {
        assert_eq!(
            answer_pairing_request(&EV3_OFFER, kind),
            None,
            "kind {kind}"
        );
    }
}

#[test]
fn a_brick_already_paired_is_answered_from_the_records_without_an_inquiry() {
    let mut steps = FakeSteps {
        paired_in_records: true,
        ..FakeSteps::default()
    };
    let outcome = pair_with(&mut steps);
    assert!(outcome.ok);
    assert_eq!(outcome.status.as_deref(), Some("AlreadyPaired"));
    assert_eq!(steps.watched, 0);
}

#[test]
fn a_brick_the_first_window_missed_gets_a_second_one() {
    let mut steps = FakeSteps {
        windows: VecDeque::from([false, true]),
        ..FakeSteps::default()
    };
    assert!(pair_with(&mut steps).ok);
    assert_eq!(steps.watched, 2);
}

#[test]
fn explains_a_brick_two_inquiry_windows_never_saw() {
    let mut steps = FakeSteps::default();
    let outcome = pair_with(&mut steps);
    assert_eq!(steps.watched, 2, "two windows, not more");
    assert!(!outcome.ok);
    assert_eq!(outcome.status.as_deref(), Some("NotFound"));
    let reason = outcome.reason.unwrap();
    assert!(reason.contains("switched on"), "{reason}");
    assert!(reason.contains("another Bluetooth device"), "{reason}");
    assert!(steps.offered.is_none(), "nothing to pair");
}

#[test]
fn a_brick_the_watcher_reports_paired_is_already_paired() {
    let mut steps = FakeSteps {
        windows: VecDeque::from([true]),
        found_paired: true,
        ..FakeSteps::default()
    };
    let outcome = pair_with(&mut steps);
    assert_eq!(outcome.status.as_deref(), Some("AlreadyPaired"));
    assert!(steps.offered.is_none());
}

#[test]
fn says_who_has_to_act_when_nobody_confirms_on_the_brick() {
    let mut steps = FakeSteps {
        windows: VecDeque::from([true]),
        result: Some(PairResult::Status("AuthenticationTimeout".into())),
        ..FakeSteps::default()
    };
    let outcome = pair_with(&mut steps);
    assert!(!outcome.ok);
    assert_eq!(outcome.status.as_deref(), Some("AuthenticationTimeout"));
    let reason = outcome.reason.unwrap();
    assert!(reason.contains("confirm"), "{reason}");
    assert!(reason.contains("another Bluetooth device"), "{reason}");
}

#[test]
fn a_cancelled_pairing_reports_cancelled_not_failed() {
    // Cancelled on the brick or by Windows.
    let mut steps = FakeSteps {
        windows: VecDeque::from([true]),
        result: Some(PairResult::Status("PairingCanceled".into())),
        ..FakeSteps::default()
    };
    let outcome = pair_with(&mut steps);
    assert!(!outcome.ok);
    assert_eq!(outcome.reason.as_deref(), Some(PAIRING_CANCELLED));

    // Cancelled from outside while the ceremony ran.
    let mut steps = FakeSteps {
        windows: VecDeque::from([true]),
        result: Some(PairResult::Cancelled),
        ..FakeSteps::default()
    };
    assert_eq!(
        pair_with(&mut steps).reason.as_deref(),
        Some(PAIRING_CANCELLED)
    );

    // Cancelled while the watcher waited.
    let mut steps = FakeSteps {
        cancel_during_watch: true,
        ..FakeSteps::default()
    };
    let outcome = pair_with(&mut steps);
    assert_eq!(outcome.reason.as_deref(), Some(PAIRING_CANCELLED));
    assert_eq!(steps.watched, 1, "no second window after a cancel");
}

#[test]
fn reads_windows_pairing_statuses_by_name() {
    assert_eq!(status_name(0), "Paired");
    assert_eq!(status_name(7), "AuthenticationTimeout");
    assert_eq!(status_name(14), "PairingCanceled");
    assert_eq!(status_name(19), "Failed");
    assert!(outcome_of_status("Paired").ok);
    assert!(
        !outcome_of_status("AlreadyPaired").ok,
        "only Paired is a pairing"
    );
    assert_eq!(
        describe_status("AccessDenied"),
        "Windows refused the pairing (AccessDenied)."
    );
    assert_eq!(
        describe_status("HardwareFailure"),
        "Pairing did not complete (HardwareFailure)."
    );
}

#[tokio::test]
async fn pairing_takes_an_opening_slot_and_notes_the_fresh_pairing_for_presence() {
    let rig = rig(FakeWindows::default()
        .paired(AAA, "")
        .answering(AAA, &[false, false, false]));
    rig.provider.discover().await.unwrap();
    for _ in 0..3 {
        rig.provider.run_presence_checks().await;
    }
    assert_eq!(
        rig.provider.presence().presence_of(AAA).map(|p| p.heard),
        Some(false)
    );

    let outcome = rig.provider.pair(&key(AAA)).await.unwrap();
    assert!(outcome.ok);
    assert_eq!(rig.windows.pair_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        rig.provider.presence().presence_of(AAA),
        None,
        "a check older than the pairing still speaks for the brick"
    );
}

#[tokio::test]
async fn a_pairing_waits_for_the_slot_and_answers_rather_than_fails_when_refused() {
    let settings = BtWindowsSettings {
        queue: QueueTimings {
            acquire_timeout: ms(100),
            ..quick_settings().queue
        },
        ..quick_settings()
    };
    let rig = rig_with(FakeWindows::default(), settings);
    let held = rig
        .provider
        .queue()
        .acquire("connect", SlotKind::Open)
        .await
        .unwrap();
    let outcome = rig.provider.pair(&key(AAA)).await.unwrap();
    assert!(!outcome.ok);
    assert!(outcome.reason.unwrap().contains("busy"));
    assert_eq!(rig.windows.pair_calls.load(Ordering::SeqCst), 0);
    held.release(false);
}

#[tokio::test]
async fn a_forget_cancels_a_pairing_of_the_same_brick_waiting_for_its_slot() {
    let rig = rig(FakeWindows::default().paired(AAA, ""));
    let provider = Arc::new(rig.provider);
    let held = provider
        .queue()
        .acquire("connect", SlotKind::Open)
        .await
        .unwrap();
    let pairing = {
        let provider = Arc::clone(&provider);
        tokio::spawn(async move { provider.pair(&key(AAA)).await })
    };
    sleep(ms(20)).await;
    let _ = provider.forget(&key(AAA)).await;
    let outcome = pairing.await.unwrap().unwrap();
    assert_eq!(outcome.reason.as_deref(), Some(PAIRING_CANCELLED));
    assert_eq!(
        rig.windows.pair_calls.load(Ordering::SeqCst),
        0,
        "it never ran"
    );
    held.release(false);
}

#[tokio::test]
async fn a_forget_stops_a_pairing_of_the_same_brick_that_is_running() {
    let windows = FakeWindows::default();
    windows.pair_blocks.store(true, Ordering::SeqCst);
    let rig = rig(windows);
    let provider = Arc::new(rig.provider);
    let pairing = {
        let provider = Arc::clone(&provider);
        tokio::spawn(async move { provider.pair(&key(AAA)).await })
    };
    sleep(ms(50)).await;
    assert_eq!(rig.windows.pair_calls.load(Ordering::SeqCst), 1);
    provider.forget(&key(AAA)).await.unwrap();
    let outcome = pairing.await.unwrap().unwrap();
    assert_eq!(outcome.reason.as_deref(), Some(PAIRING_CANCELLED));
    assert!(!outcome.ok);
}

// ── Forgetting ──────────────────────────────────────────────────────────

#[tokio::test]
async fn forget_removes_the_windows_pairing_so_the_brick_does_not_return_as_paired() {
    let rig = rig(FakeWindows::default().paired(AAA, "AAA"));
    rig.provider.discover().await.unwrap();
    rig.provider.forget(&key(AAA)).await.unwrap();
    assert_eq!(*rig.windows.removed.lock().unwrap(), [AAA_ADDRESS]);
    let items = rig.provider.discover().await.unwrap().items;
    // Windows keeps its in-memory record until a restart, so the scan may still list the
    // brick, but never as paired again.
    let brick = items.iter().find(|i| i.brick_key == key(AAA)).unwrap();
    assert_eq!(brick.paired, Some(false), "the brick came back paired");
    assert!(!brick.remembered);
    assert!(rig.provider.paired_without_session().is_empty());
}

#[tokio::test]
async fn reports_a_refused_unpair_instead_of_claiming_success() {
    let rig = rig(FakeWindows::default().paired(AAA, ""));
    *rig.windows.remove_code.lock().unwrap() = 5;
    let error = rig.provider.forget(&key(AAA)).await.unwrap_err();
    assert!(error.message.contains("error 5"), "{}", error.message);
    assert!(error.message.contains("001653AABBCC"), "{}", error.message);
}

#[test]
fn counts_a_pairing_that_is_already_gone_as_removed() {
    assert_eq!(unpair_result(0), Ok(()));
    assert_eq!(unpair_result(1168), Ok(()));
    assert_eq!(
        unpair_result(5),
        Err("Windows refused to remove the pairing (error 5).".into())
    );
}

#[tokio::test]
async fn names_the_registry_key_and_the_in_memory_record_windows_keeps() {
    let rig = rig(FakeWindows::default());
    let residue = rig.provider.forget(&key(AAA)).await.unwrap();
    assert_eq!(residue, windows_residue(AAA));
    assert_eq!(residue.len(), 2);
    assert_eq!(
        residue[0].location,
        "HKLM\\SYSTEM\\CurrentControlSet\\Services\\BTHPORT\\Parameters\\Devices\\001653aabbcc"
    );
    assert!(residue[0].reason.contains("SYSTEM"));
    assert!(residue[1].location.contains("001653AABBCC"));
    assert!(residue[1].reason.contains("restart"));
}

#[tokio::test]
async fn stops_presence_checking_a_forgotten_brick_and_drops_what_presence_knew() {
    let windows = FakeWindows::default()
        .paired(AAA, "")
        .answering(AAA, &[true]);
    *windows.inquiry.lock().unwrap() = vec![ScannedBrick {
        mac: AAA.into(),
        name: "AAA".into(),
        paired: false,
        signal: None,
    }];
    let rig = rig(windows);
    rig.provider.discover().await.unwrap();
    rig.provider.run_presence_checks().await;
    rig.provider.run_inquiry().await;
    assert_eq!(rig.provider.paired_without_session(), [AAA]);

    rig.provider.forget(&key(AAA)).await.unwrap();

    assert!(rig.provider.paired_without_session().is_empty());
    assert_eq!(rig.provider.presence().presence_of(AAA), None);
    assert!(rig.provider.presence().unpaired_bricks().is_empty());
}

#[tokio::test(start_paused = true)]
async fn does_not_hold_back_the_next_connect_to_a_forgotten_brick() {
    let rig = rig_with(
        FakeWindows::default(),
        BtWindowsSettings {
            reconnect_gap: ms(500),
            ..quick_settings()
        },
    );
    rig.provider.connect(&key(AAA)).await.unwrap();
    rig.provider.forget(&key(AAA)).await.unwrap();
    rig.provider.connect(&key(AAA)).await.unwrap();
    let opens = rig.connector.opens_of(AAA);
    assert!(
        opens[1] - opens[0] < ms(100),
        "reopened after {:?}",
        opens[1] - opens[0]
    );
}

// ── Lifetime ────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn refuses_connect_and_discover_after_the_dispose_and_closes_sessions() {
    let rig = rig(FakeWindows::default().paired(AAA, ""));
    rig.provider.connect(&key(AAA)).await.unwrap();
    rig.provider.dispose().await;
    assert!(rig.provider.connect(&key(BBB)).await.is_err());
    assert!(rig.provider.discover().await.is_err());
    assert!(
        rig.provider
            .send_packet(&key(AAA), &request(1, &[1]), &expecting(1))
            .await
            .is_err()
    );
    assert_eq!(rig.connector.opens_of(BBB).len(), 0);
}

#[tokio::test]
async fn reads_this_computers_radio_name() {
    let rig = rig(FakeWindows::default());
    assert_eq!(rig.provider.radio_name().await.as_deref(), Some("HOSTA"));
}

// ── The Winsock data path ───────────────────────────────────────────────

#[test]
fn a_connect_the_brick_never_answered_is_unreachable_and_carries_its_code() {
    for code in [10060, 10064, 10065] {
        assert_eq!(
            ConnectFailure::from_code(code),
            ConnectFailure::Unreachable(code)
        );
        let error = ConnectFailure::from_code(code).into_error(AAA);
        assert!(error.message.contains(&format!("WSA error {code}")));
        assert!(error.message.contains("did not answer"));
        assert!(error.message.contains("001653AABBCC"));
    }
    for code in [10013, 10061] {
        assert_eq!(
            ConnectFailure::from_code(code),
            ConnectFailure::Failed(code)
        );
        let error = ConnectFailure::from_code(code).into_error(AAA);
        assert!(error.message.contains(&format!("WSA error {code}")));
        assert!(!error.message.contains("did not answer"));
        assert_eq!(ConnectFailure::from_code(code).wsa_code(), Some(code));
    }
    let timed_out = ConnectFailure::TimedOut(Duration::from_secs(15)).into_error(AAA);
    assert_eq!(timed_out.code, ErrorCode::Timeout);
    assert!(timed_out.message.contains("15000 ms"));
}

#[test]
fn a_failed_connect_says_what_helped_on_hardware() {
    // A brick that did not answer: on with Bluetooth visible, and Wi-Fi off on a shared card.
    let silent = ConnectFailure::from_code(10060).into_error(AAA);
    assert!(
        silent.message.contains("switching Wi-Fi off"),
        "{}",
        silent.message
    );
    // One that could not be reached at all: a pairing the brick no longer knows.
    let unreachable = ConnectFailure::from_code(10051).into_error(AAA);
    assert!(
        unreachable.message.contains("WSA error 10051"),
        "{}",
        unreachable.message
    );
    assert!(
        unreachable.message.contains("ev3 forget"),
        "{}",
        unreachable.message
    );
    assert!(
        unreachable.message.contains("ev3 pair"),
        "{}",
        unreachable.message
    );
    // Any other refusal makes no such claim.
    let refused = ConnectFailure::from_code(10061).into_error(AAA);
    assert!(!refused.message.contains("Wi-Fi") && !refused.message.contains("ev3 forget"));
}

#[test]
fn the_bluetooth_socket_address_is_packed_to_30_bytes() {
    use windows_sys::Win32::Devices::Bluetooth::SOCKADDR_BTH;
    assert_eq!(std::mem::size_of::<SOCKADDR_BTH>(), 30);
}

/// A connect under way, as a test stages it.
struct FakePending {
    ready: Option<io::Result<()>>,
    so_error: i32,
    closed: Arc<AtomicBool>,
}

impl PendingConnect for FakePending {
    fn writable(&self) -> Pin<Box<dyn std::future::Future<Output = io::Result<()>> + Send + '_>> {
        match &self.ready {
            None => Box::pin(std::future::pending()),
            Some(Ok(())) => Box::pin(std::future::ready(Ok(()))),
            Some(Err(error)) => {
                let code = error.raw_os_error().unwrap_or(0);
                Box::pin(std::future::ready(Err(io::Error::from_raw_os_error(code))))
            }
        }
    }

    fn socket_error(&self) -> i32 {
        self.so_error
    }
}

impl Drop for FakePending {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::SeqCst);
    }
}

fn pending(ready: Option<io::Result<()>>, so_error: i32) -> (FakePending, Arc<AtomicBool>) {
    let closed = Arc::new(AtomicBool::new(false));
    (
        FakePending {
            ready,
            so_error,
            closed: Arc::clone(&closed),
        },
        closed,
    )
}

#[tokio::test(start_paused = true)]
async fn gives_up_on_a_connect_that_never_answers_and_closes_the_socket() {
    let (connect, closed) = pending(None, 0);
    let started = Instant::now();
    let failure = finish_connect(connect, ms(20)).await.err().unwrap();
    assert_eq!(failure, ConnectFailure::TimedOut(ms(20)));
    assert_eq!(started.elapsed(), ms(20), "never waited past the deadline");
    assert!(
        closed.load(Ordering::SeqCst),
        "the socket is closed, nothing left parked"
    );
}

#[tokio::test]
async fn reports_the_error_the_connect_actually_ended_with() {
    // Readiness means the connect finished, not that it succeeded: SO_ERROR says how.
    let (connect, closed) = pending(Some(Ok(())), 10064);
    let failure = finish_connect(connect, Duration::from_secs(1))
        .await
        .err()
        .unwrap();
    assert_eq!(failure, ConnectFailure::Unreachable(10064));
    assert!(closed.load(Ordering::SeqCst));

    let (connect, closed) = pending(Some(Ok(())), 0);
    let connected = finish_connect(connect, Duration::from_secs(1)).await;
    assert!(connected.is_ok());
    assert!(!closed.load(Ordering::SeqCst), "a connected socket is kept");
    drop(connected);

    let (connect, _) = pending(Some(Err(io::Error::from_raw_os_error(10061))), 0);
    let failure = finish_connect(connect, Duration::from_secs(1))
        .await
        .err()
        .unwrap();
    assert_eq!(failure, ConnectFailure::Failed(10061));
}

/// A byte stream that does what a test needs: accept writes in pieces, fail, stall, deliver
/// replies in chunks, close.
#[derive(Default)]
struct Scripted {
    accept_per_write: Option<usize>,
    writes_before_failure: Option<usize>,
    write_zero: bool,
    /// After the first accepted write, every later write stays pending.
    stall_after_first: bool,
    writes: usize,
    written: Vec<u8>,
    inbound: VecDeque<Vec<u8>>,
    eof: bool,
}

impl AsyncWrite for Scripted {
    fn poll_write(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if self.write_zero {
            return Poll::Ready(Ok(0));
        }
        if self.stall_after_first && self.writes > 0 {
            return Poll::Pending;
        }
        if self.writes_before_failure == Some(self.writes) {
            return Poll::Ready(Err(io::Error::from_raw_os_error(10054)));
        }
        let accepted = self.accept_per_write.unwrap_or(buf.len()).min(buf.len());
        self.writes += 1;
        self.written.extend_from_slice(&buf[..accepted]);
        Poll::Ready(Ok(accepted))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncRead for Scripted {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if let Some(chunk) = self.inbound.pop_front() {
            buf.put_slice(&chunk);
            return Poll::Ready(Ok(()));
        }
        if self.eof {
            return Poll::Ready(Ok(()));
        }
        Poll::Pending
    }
}

/// Connects over a real loopback socket to a fake brick that answers each request with its
/// payload plus one: the provider's whole send path over the same stream type the daemon uses.
struct LoopbackConnector {
    port: u16,
}

#[async_trait]
impl RfcommConnector for LoopbackConnector {
    async fn open(
        &self,
        _address: u64,
        _deadline: Duration,
    ) -> Result<Box<dyn RfcommLink>, ConnectFailure> {
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", self.port))
            .await
            .map_err(|_| ConnectFailure::Failed(0))?;
        Ok(Box::new(StreamLink::new(stream)))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exchanges_over_a_real_socket_through_the_provider() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        loop {
            let mut head = [0u8; 2];
            if socket.read_exact(&mut head).await.is_err() {
                return;
            }
            let mut body = vec![0u8; usize::from(u16::from_le_bytes(head))];
            socket.read_exact(&mut body).await.unwrap();
            let counter = u16::from_le_bytes([body[0], body[1]]);
            let payload: Vec<u8> = body[3..].iter().map(|b| b.wrapping_add(1)).collect();
            socket
                .write_all(&reply_packet(counter, &payload))
                .await
                .unwrap();
        }
    });
    let settings = quick_settings();
    let provider = WindowsBtProvider::new(
        Arc::new(FakeWindows::default()),
        Arc::new(LoopbackConnector { port }),
        Arc::new(BtConnectionQueue::new(settings.queue)),
        settings,
    );
    provider.connect(&key(AAA)).await.unwrap();
    for counter in 1..=20u16 {
        let answer = provider
            .send_packet(&key(AAA), &request(counter, &[0x10]), &expecting(counter))
            .await
            .unwrap();
        assert_eq!(answer, reply_packet(counter, &[0x11]));
    }
    provider.dispose().await;
}

#[tokio::test]
async fn reassembles_a_reply_split_across_two_reads() {
    let whole = reply_packet(3, &[0x02, 0x11, 0x22]);
    let stream = Scripted {
        inbound: VecDeque::from([whole[..3].to_vec(), whole[3..].to_vec()]),
        ..Scripted::default()
    };
    let mut link = StreamLink::new(stream);
    let mut exchanger = Exchanger::new("BT", Duration::from_secs(2));
    let answer = exchanger
        .exchange(&mut link, &request(3, &[0x01]), &expecting(3))
        .await
        .unwrap();
    assert_eq!(answer, whole);
}

#[tokio::test]
async fn writes_the_whole_packet_even_when_the_stack_accepts_it_in_pieces() {
    let mut link = StreamLink::new(Scripted {
        accept_per_write: Some(4),
        ..Scripted::default()
    });
    let packet = request(1, &[5, 6, 7, 8, 9, 10, 11]);
    link.write_packet(&packet).await.unwrap();
    assert!(!link.is_broken());
    assert_eq!(
        link.get_ref().written,
        packet,
        "a truncated command the brick acts on"
    );
    assert!(link.get_ref().writes > 1);
}

#[tokio::test]
async fn fails_the_exchange_when_the_stack_refuses_the_write_and_keeps_the_link() {
    let mut link = StreamLink::new(Scripted {
        writes_before_failure: Some(0),
        ..Scripted::default()
    });
    let error = link.write_packet(&request(1, &[1])).await.unwrap_err();
    assert!(error.message.contains("10054"), "{}", error.message);
    assert!(
        !link.is_broken(),
        "nothing reached the stream: the link is as good as before"
    );
}

#[tokio::test]
async fn breaks_the_link_when_the_write_fails_part_way() {
    let mut link = StreamLink::new(Scripted {
        accept_per_write: Some(4),
        writes_before_failure: Some(1),
        ..Scripted::default()
    });
    let error = link
        .write_packet(&request(1, &[5, 6, 7, 8, 9, 10, 11]))
        .await
        .unwrap_err();
    assert!(error.message.contains("10054"), "{}", error.message);
    assert!(
        link.is_broken(),
        "a cut-off command would join the next one"
    );
    assert!(link.write_packet(&request(2, &[1])).await.is_err());
}

#[tokio::test]
async fn fails_rather_than_spins_when_the_write_stalls_at_zero() {
    let mut link = StreamLink::new(Scripted {
        write_zero: true,
        ..Scripted::default()
    });
    let error = link.write_packet(&request(1, &[1])).await.unwrap_err();
    assert!(error.message.contains("stalled"), "{}", error.message);
}

#[tokio::test(start_paused = true)]
async fn an_exchange_abandoned_with_a_command_cut_off_breaks_the_link() {
    let mut link = StreamLink::new(Scripted {
        accept_per_write: Some(4),
        stall_after_first: true,
        ..Scripted::default()
    });
    let mut exchanger = Exchanger::new("BT", Duration::from_secs(2));
    let timed_out = exchanger
        .exchange(
            &mut link,
            &request(1, &[5, 6, 7, 8, 9, 10, 11]),
            &SendOptions {
                timeout: Some(ms(20)),
                expected_message_counter: Some(1),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(timed_out.code, ErrorCode::Timeout);
    assert!(link.is_broken());
    let next = link.write_packet(&request(2, &[1])).await.unwrap_err();
    assert!(next.message.contains("cut off"), "{}", next.message);
}

#[tokio::test]
async fn a_brick_that_hangs_up_reads_as_closed_by_the_brick() {
    let mut link = StreamLink::new(Scripted {
        eof: true,
        ..Scripted::default()
    });
    let mut exchanger = Exchanger::new("BT", Duration::from_secs(5));
    let error = exchanger
        .exchange(&mut link, &request(1, &[1]), &expecting(1))
        .await
        .unwrap_err();
    assert!(
        error.message.contains("closed by the brick"),
        "{}",
        error.message
    );
    assert!(link.is_broken());
}
