//! The Linux Bluetooth provider, put together over a fake BlueZ, a fake RFCOMM connector and a
//! fake presence probe, on a paused clock.
#![cfg(target_os = "linux")]

mod bt_linux_support;

use std::collections::HashMap;
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use bt_linux_support::*;
use ev3_transports::bt::presence::PresenceFailure;
use ev3_transports::bt::queue::{BtConnectionQueue, QueueTimings};
use ev3_transports::bt_linux::bluez::{BluezError, ERROR_IN_PROGRESS};
use ev3_transports::bt_linux::presence::PresenceProber;
use ev3_transports::bt_linux::radio_watch::RadioSysfs;
use ev3_transports::bt_linux::rfcomm::{ConnectFailure, FdLink, RfcommConnector, RfcommLink};
use ev3_transports::bt_linux::{BtLinuxParts, BtLinuxSettings, LinuxBtProvider};
use ev3_transports::provider::{NameSource, TransportProvider};
use ev3_transports::{BrickKey, LinkIo, SendOptions, Transport, TransportError};
use tokio::time::Instant;

const AAA_ADDRESS: u64 = 0x0016_53F0_0A0A;

fn key(mac: &str) -> BrickKey {
    BrickKey::new(Transport::Bt, mac).unwrap()
}

/// A brick as measured after its channel is closed: 0 s after the close `EBUSY`, within 2 s
/// `ECONNREFUSED`, from 2.5 s it connects.
#[derive(Default)]
struct MeasuredBrick {
    closed_at: Arc<Mutex<Option<Instant>>>,
    opened_at: Mutex<Vec<Instant>>,
    attempts: Mutex<Vec<(Instant, Result<(), i32>)>>,
}

struct BrickLink {
    closed_at: Arc<Mutex<Option<Instant>>>,
}

impl Drop for BrickLink {
    fn drop(&mut self) {
        *self.closed_at.lock().unwrap() = Some(Instant::now());
    }
}

#[async_trait]
impl LinkIo for BrickLink {
    async fn write_packet(&mut self, _packet: &[u8]) -> Result<(), TransportError> {
        Ok(())
    }
    async fn read_some(&mut self, _into: &mut Vec<u8>) -> Result<(), TransportError> {
        std::future::pending().await
    }
}

impl RfcommLink for BrickLink {
    fn is_broken(&self) -> bool {
        false
    }
}

#[async_trait]
impl RfcommConnector for MeasuredBrick {
    async fn open(
        &self,
        address: u64,
        _deadline: Duration,
    ) -> Result<Box<dyn RfcommLink>, ConnectFailure> {
        assert_eq!(address, AAA_ADDRESS);
        let now = Instant::now();
        let since_close = self
            .closed_at
            .lock()
            .unwrap()
            .map(|at| now.saturating_duration_since(at));
        let answer = match since_close {
            Some(since) if since < Duration::from_millis(500) => Err(libc::EBUSY),
            Some(since) if since < Duration::from_millis(2_500) => Err(libc::ECONNREFUSED),
            _ => Ok(()),
        };
        self.attempts.lock().unwrap().push((now, answer));
        match answer {
            Ok(()) => {
                self.opened_at.lock().unwrap().push(now);
                Ok(Box::new(BrickLink {
                    closed_at: Arc::clone(&self.closed_at),
                }))
            }
            Err(code) => Err(ConnectFailure::from_errno(code)),
        }
    }
}

/// A probe that answers per address: on, off, or failing.
#[derive(Default)]
struct Probe {
    on: Mutex<HashMap<u64, Result<bool, PresenceFailure>>>,
    asked: Mutex<Vec<u64>>,
}

#[async_trait]
impl PresenceProber for Probe {
    async fn probe(&self, address: u64, _deadline: Duration) -> Result<bool, PresenceFailure> {
        self.asked.lock().unwrap().push(address);
        self.on
            .lock()
            .unwrap()
            .get(&address)
            .cloned()
            .unwrap_or(Ok(false))
    }
}

#[derive(Default)]
struct Sysfs {
    writes: Mutex<Vec<String>>,
    /// The udev rule is not installed: this user may not write the file.
    locked: std::sync::atomic::AtomicBool,
}

impl RadioSysfs for Sysfs {
    fn authorized_file(&self, _hci: &str) -> Option<PathBuf> {
        Some(PathBuf::from("/sys/devices/usb1/1-1/authorized"))
    }
    fn writable(&self, _file: &Path) -> bool {
        !self.locked.load(std::sync::atomic::Ordering::SeqCst)
    }
    fn write(&self, _file: &Path, value: &str) -> std::io::Result<()> {
        self.writes.lock().unwrap().push(value.to_owned());
        Ok(())
    }
}

fn quick_queue() -> QueueTimings {
    QueueTimings {
        inter_connection_cooldown: Duration::ZERO,
        error_recovery_cooldown: Duration::ZERO,
        error_backoff_max: Duration::ZERO,
        ..QueueTimings::default()
    }
}

struct Rig {
    provider: LinuxBtProvider,
    bus: Arc<FakeBus>,
    probe: Arc<Probe>,
    sysfs: Arc<Sysfs>,
    said: Arc<Said>,
}

async fn rig_with(
    bus: Arc<FakeBus>,
    connector: Arc<dyn RfcommConnector>,
    settings: BtLinuxSettings,
) -> Rig {
    let said = Arc::new(Said::default());
    let session = ready_session(Arc::clone(&bus), Arc::clone(&said)).await;
    let probe = Arc::new(Probe::default());
    let sysfs = Arc::new(Sysfs::default());
    let provider = LinuxBtProvider::new(
        BtLinuxParts {
            session,
            connector,
            prober: Arc::clone(&probe) as _,
            sysfs: Arc::clone(&sysfs) as _,
            queue: Arc::new(BtConnectionQueue::new(settings.queue)),
            activity: Arc::clone(&said) as _,
            rule_path: None,
        },
        settings,
    );
    Rig {
        provider,
        bus,
        probe,
        sysfs,
        said,
    }
}

async fn rig(bus: Arc<FakeBus>) -> Rig {
    let settings = BtLinuxSettings {
        queue: quick_queue(),
        ..BtLinuxSettings::default()
    };
    rig_with(bus, Arc::new(MeasuredBrick::default()), settings).await
}

fn three_bricks() -> Arc<FakeBus> {
    FakeBus::new(vec![
        adapter_object(),
        device_object(AAA_PATH, AAA, Some("AAA"), true, None),
        device_object(BBB_PATH, BBB, None, true, None),
        device_object(CCC_PATH, CCC, Some("CCC"), false, None),
        device_object(
            "/org/bluez/hci0/dev_00_00_5E_00_53_99",
            "00:00:5E:00:53:99",
            Some("phone"),
            true,
            None,
        ),
    ])
}

#[tokio::test(start_paused = true)]
async fn a_connect_right_after_a_close_waits_out_the_gap_and_lands() {
    let brick = Arc::new(MeasuredBrick::default());
    let settings = BtLinuxSettings {
        queue: quick_queue(),
        ..BtLinuxSettings::default()
    };
    let rig = rig_with(three_bricks(), Arc::clone(&brick) as _, settings).await;
    let aaa = key(AAA);
    rig.provider.connect(&aaa).await.unwrap();
    rig.provider.disconnect(&aaa).await.unwrap();
    let closed = brick.closed_at.lock().unwrap().unwrap();
    rig.provider.connect(&aaa).await.unwrap();
    let attempts = brick.attempts.lock().unwrap().clone();
    assert_eq!(attempts.len(), 2, "one attempt per connect, and it landed");
    assert!(attempts[1].0 - closed >= Duration::from_millis(2_500));
    assert_eq!(attempts[1].1, Ok(()));
}

#[tokio::test(start_paused = true)]
async fn a_connect_0_s_after_a_close_reports_ebusy_and_one_from_2_5_s_lands() {
    let brick = Arc::new(MeasuredBrick::default());
    let settings = BtLinuxSettings {
        queue: quick_queue(),
        reconnect_gap: Duration::ZERO,
        ..BtLinuxSettings::default()
    };
    let rig = rig_with(three_bricks(), Arc::clone(&brick) as _, settings).await;
    let aaa = key(AAA);
    rig.provider.connect(&aaa).await.unwrap();
    rig.provider.disconnect(&aaa).await.unwrap();
    let error = rig.provider.connect(&aaa).await.unwrap_err();
    assert!(
        error.message.contains("closed a moment ago"),
        "{}",
        error.message
    );
    tokio::time::sleep(Duration::from_secs(1)).await;
    let error = rig.provider.connect(&aaa).await.unwrap_err();
    assert!(
        error
            .message
            .contains(&format!("errno {}", libc::ECONNREFUSED)),
        "{}",
        error.message
    );
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    rig.provider.connect(&aaa).await.unwrap();
    let attempts = brick.attempts.lock().unwrap().clone();
    let answers: Vec<_> = attempts.iter().map(|(_, answer)| *answer).collect();
    assert_eq!(
        answers,
        [Ok(()), Err(libc::EBUSY), Err(libc::ECONNREFUSED), Ok(())]
    );
}

/// A connector that answers the scripted errnos in order, then opens.
#[derive(Default)]
struct ScriptedBrick {
    errnos: Mutex<Vec<i32>>,
    attempts: Mutex<Vec<Instant>>,
}

#[async_trait]
impl RfcommConnector for ScriptedBrick {
    async fn open(
        &self,
        _address: u64,
        _deadline: Duration,
    ) -> Result<Box<dyn RfcommLink>, ConnectFailure> {
        self.attempts.lock().unwrap().push(Instant::now());
        let next = {
            let mut errnos = self.errnos.lock().unwrap();
            (!errnos.is_empty()).then(|| errnos.remove(0))
        };
        match next {
            Some(code) => Err(ConnectFailure::from_errno(code)),
            None => Ok(Box::new(BrickLink {
                closed_at: Arc::default(),
            })),
        }
    }
}

/// A daemon that has just replaced another: the shipped five-second window, started now.
async fn rig_just_started(errnos: &[i32]) -> (Rig, Arc<ScriptedBrick>, Instant) {
    let brick = Arc::new(ScriptedBrick {
        errnos: Mutex::new(errnos.to_vec()),
        ..ScriptedBrick::default()
    });
    let started = Instant::now();
    let settings = BtLinuxSettings {
        queue: quick_queue(),
        reconnect_gap: Duration::from_millis(150),
        daemon_started: started,
        startup_busy_window: Duration::from_secs(5),
        ..BtLinuxSettings::default()
    };
    let rig = rig_with(three_bricks(), Arc::clone(&brick) as _, settings).await;
    (rig, brick, started)
}

#[tokio::test(start_paused = true)]
async fn a_first_connect_refused_with_ebusy_just_after_the_start_is_tried_again_at_five_seconds() {
    let (rig, brick, started) = rig_just_started(&[libc::EBUSY]).await;
    rig.provider.connect(&key(AAA)).await.unwrap();
    let attempts = brick.attempts.lock().unwrap().clone();
    assert_eq!(attempts.len(), 2);
    assert!(attempts[0] - started < Duration::from_secs(1));
    assert!(attempts[1] - started >= Duration::from_secs(5));
}

#[tokio::test(start_paused = true)]
async fn ebusy_after_the_first_five_seconds_is_not_tried_again() {
    let (rig, brick, _) = rig_just_started(&[libc::EBUSY]).await;
    tokio::time::sleep(Duration::from_secs(6)).await;
    assert!(rig.provider.connect(&key(AAA)).await.is_err());
    assert_eq!(brick.attempts.lock().unwrap().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn ebusy_on_a_second_connect_just_after_the_start_is_not_tried_again() {
    let (rig, brick, _) = rig_just_started(&[]).await;
    rig.provider.connect(&key(AAA)).await.unwrap();
    rig.provider.disconnect(&key(AAA)).await.unwrap();
    brick.errnos.lock().unwrap().push(libc::EBUSY);
    assert!(rig.provider.connect(&key(AAA)).await.is_err());
    assert_eq!(brick.attempts.lock().unwrap().len(), 2);
}

struct PairConnector {
    brick_side: Mutex<Option<UnixStream>>,
}

#[async_trait]
impl RfcommConnector for PairConnector {
    async fn open(
        &self,
        _address: u64,
        _deadline: Duration,
    ) -> Result<Box<dyn RfcommLink>, ConnectFailure> {
        let (ours, brick) = UnixStream::pair().unwrap();
        *self.brick_side.lock().unwrap() = Some(brick);
        Ok(Box::new(FdLink::new(OwnedFd::from(ours)).unwrap()))
    }
}

#[tokio::test]
async fn sends_a_packet_over_the_opened_channel_and_returns_the_reply() {
    use std::io::{Read, Write};
    let connector = Arc::new(PairConnector {
        brick_side: Mutex::new(None),
    });
    let settings = BtLinuxSettings {
        queue: quick_queue(),
        ..BtLinuxSettings::default()
    };
    let rig = rig_with(three_bricks(), Arc::clone(&connector) as _, settings).await;
    let aaa = key(AAA);
    rig.provider.connect(&aaa).await.unwrap();
    let mut brick = connector.brick_side.lock().unwrap().take().unwrap();
    let answering = std::thread::spawn(move || {
        let mut request = [0u8; 5];
        brick.read_exact(&mut request).unwrap();
        brick.write_all(&[3, 0, 1, 0, 0x02]).unwrap();
        request
    });
    let options = SendOptions {
        timeout: None,
        expected_message_counter: Some(1),
    };
    let reply = rig
        .provider
        .send_packet(&aaa, &[3, 0, 1, 0, 0x01], &options)
        .await
        .unwrap();
    assert_eq!(reply, [3, 0, 1, 0, 0x02]);
    assert_eq!(answering.join().unwrap(), [3, 0, 1, 0, 0x01]);
}

#[tokio::test(start_paused = true)]
async fn presence_answers_on_for_an_on_brick_and_nothing_not_an_error_for_an_off_one() {
    let rig = rig(three_bricks()).await;
    rig.probe.on.lock().unwrap().insert(AAA_ADDRESS, Ok(true));
    assert!(rig.provider.check_presence(&key(AAA)).await.unwrap());
    assert!(!rig.provider.check_presence(&key(BBB)).await.unwrap());

    rig.provider.discover().await.unwrap();
    let mut paired = rig.provider.paired_without_session();
    paired.sort();
    assert_eq!(paired, [AAA, BBB]);
    for _ in 0..3 {
        rig.provider.run_presence_checks().await;
    }
    let presence = rig.provider.presence();
    assert!(presence.presence_of(AAA).unwrap().heard);
    assert!(!presence.presence_of(BBB).unwrap().heard);
    assert!(!presence.is_stopped());
    let items = rig.provider.discover().await.unwrap().items;
    let bbb = items
        .iter()
        .find(|item| item.brick_key == key(BBB))
        .unwrap();
    assert_eq!(bbb.heard, Some(false), "listed, flagged not heard");
}

#[tokio::test(start_paused = true)]
async fn two_refused_windows_restart_the_adapter_and_hold_the_checks_meanwhile() {
    let rig = rig(three_bricks()).await;
    rig.probe.on.lock().unwrap().insert(AAA_ADDRESS, Ok(true));
    // Two windows the radio refused, and a radio that cannot be switched: restarted through
    // sysfs, and while that runs nothing is asked.
    for _ in 0..2 {
        rig.bus.reply(
            "StopDiscovery",
            Reply::Err(BluezError::new(ERROR_IN_PROGRESS, "busy")),
        );
        rig.bus.reply(
            "SetPowered",
            Reply::Err(BluezError::new("org.bluez.Error.Failed", "Failed")),
        );
    }
    rig.provider.run_inquiry().await;
    let restart = {
        let provider_radio = Arc::clone(rig.provider.radio());
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(16)).await;
            provider_radio.checks_held()
        })
    };
    rig.provider.run_inquiry().await;
    assert!(
        restart.await.unwrap(),
        "checks were held during the restart"
    );
    assert_eq!(*rig.sysfs.writes.lock().unwrap(), ["0", "1"]);
    assert!(rig.said.count_containing("restarting it") == 1);
}

/// Two windows in which the radio refused, and BlueZ cannot switch it.
fn radio_stops_answering(rig: &Rig) {
    for _ in 0..2 {
        rig.bus.reply(
            "StopDiscovery",
            Reply::Err(BluezError::new(ERROR_IN_PROGRESS, "busy")),
        );
        rig.bus.reply(
            "SetPowered",
            Reply::Err(BluezError::new("org.bluez.Error.Failed", "Failed")),
        );
    }
}

#[tokio::test(start_paused = true)]
async fn a_dead_radio_left_alone_is_not_asked_nothing_is_heard() {
    let rig = rig(three_bricks()).await;
    rig.sysfs
        .locked
        .store(true, std::sync::atomic::Ordering::SeqCst);
    rig.probe.on.lock().unwrap().insert(AAA_ADDRESS, Ok(true));
    radio_stops_answering(&rig);
    rig.provider.run_inquiry().await;
    rig.provider.run_inquiry().await;
    assert!(rig.provider.radio().left_alone().is_some());
    assert!(!rig.provider.check_presence(&key(AAA)).await.unwrap());
    rig.provider.discover().await.unwrap();
    rig.provider.run_presence_checks().await;
    assert!(rig.probe.asked.lock().unwrap().is_empty());
    let windows = rig.bus.count("SetDiscoveryFilter");
    rig.provider.run_inquiry().await;
    assert_eq!(
        rig.bus.count("SetDiscoveryFilter"),
        windows,
        "inquiries wait too"
    );
}

#[tokio::test(start_paused = true)]
async fn discovery_lists_bluezs_bricks_paired_or_not_and_drops_the_rest() {
    let rig = rig(three_bricks()).await;
    let items = rig.provider.discover().await.unwrap().items;
    let listed: Vec<(String, bool, String, Option<NameSource>)> = items
        .iter()
        .map(|item| {
            (
                item.brick_key.id().to_owned(),
                item.remembered,
                item.display_name.clone(),
                item.name_source,
            )
        })
        .collect();
    assert_eq!(
        listed,
        [
            (
                AAA.to_owned(),
                true,
                "AAA".to_owned(),
                Some(NameSource::BtCache)
            ),
            (
                BBB.to_owned(),
                true,
                "001653F00A0B".to_owned(),
                Some(NameSource::Fallback)
            ),
            (
                CCC.to_owned(),
                false,
                "CCC".to_owned(),
                Some(NameSource::BtCache)
            ),
        ]
    );
}

#[tokio::test(start_paused = true)]
async fn discovery_fails_rather_than_answering_empty_before_bluez_is_read() {
    let rig = rig(three_bricks()).await;
    rig.provider.bluez().objects().clear();
    let error = rig.provider.discover().await.unwrap_err();
    assert!(error.message.contains("not ready"), "{}", error.message);
}

#[tokio::test(start_paused = true)]
async fn an_inquiry_lists_a_brick_nobody_has_paired_yet() {
    let bus = FakeBus::new(vec![adapter_object()]);
    let rig = rig(Arc::clone(&bus)).await;
    let objects = Arc::clone(rig.provider.bluez().objects());
    bus.on_call(move |_, call| {
        if call.member == "StartDiscovery" {
            let (path, interfaces) = device_object(CCC_PATH, CCC, Some("CCC"), false, Some(-55));
            objects.apply(
                &ev3_transports::bt_linux::bluez::BluezSignal::InterfacesAdded { path, interfaces },
            );
        }
    });
    rig.provider.run_inquiry().await;
    let unpaired = rig.provider.presence().unpaired_bricks();
    assert_eq!(unpaired.len(), 1);
    assert_eq!(unpaired[0].mac, CCC);
    assert_eq!(bus.count("StopDiscovery"), 1);
}

#[tokio::test(start_paused = true)]
async fn pairing_answers_the_brick_with_1234_through_the_provider() {
    let bus = three_bricks();
    let rig = rig(Arc::clone(&bus)).await;
    let outcome = rig.provider.pair(&key(CCC)).await.unwrap();
    assert!(outcome.ok, "{outcome:?}");
    assert_eq!(*bus.pin_answers.lock().unwrap(), [Ok("1234".to_owned())]);
    assert!(bus.members().iter().all(|m| m != "RequestDefaultAgent"));
}

#[tokio::test(start_paused = true)]
async fn a_pairing_and_an_inquiry_never_page_the_radio_together() {
    let bus = three_bricks();
    bus.reply(
        "Pair",
        Reply::After(Duration::from_secs(10), Box::new(Reply::Ok)),
    );
    let rig = Arc::new(rig(Arc::clone(&bus)).await);
    let pairing = {
        let rig = Arc::clone(&rig);
        tokio::spawn(async move { rig.provider.pair(&key(CCC)).await })
    };
    tokio::time::sleep(Duration::from_millis(1)).await;
    rig.provider.run_inquiry().await;
    pairing.await.unwrap().unwrap();
    let members = bus.members();
    let unregistered = members.iter().position(|m| m == "UnregisterAgent").unwrap();
    let window = members
        .iter()
        .position(|m| m == "SetDiscoveryFilter")
        .unwrap();
    assert!(unregistered < window, "{members:?}");
}

#[tokio::test(start_paused = true)]
async fn forget_removes_bluezs_record_and_names_what_bluez_keeps() {
    let bus = three_bricks();
    let rig = rig(Arc::clone(&bus)).await;
    let residue = rig.provider.forget(&key(AAA)).await.unwrap();
    let removes: Vec<_> = bus
        .calls
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.member == "RemoveDevice")
        .cloned()
        .collect();
    assert_eq!(removes.len(), 1);
    assert_eq!(removes[0].args, [ADAPTER, AAA_PATH]);
    assert_eq!(residue.len(), 1);
    assert_eq!(
        residue[0].location,
        format!("/var/lib/bluetooth/{ADAPTER_ADDRESS}/cache/{AAA}")
    );
    assert!(residue[0].reason.contains("owned by root"));
}

#[tokio::test(start_paused = true)]
async fn forget_counts_a_brick_bluez_does_not_hold_as_already_forgotten() {
    let bus = FakeBus::new(vec![adapter_object()]);
    let rig = rig(Arc::clone(&bus)).await;
    rig.provider.forget(&key(AAA)).await.unwrap();
    assert_eq!(bus.count("RemoveDevice"), 0);
    let bus = three_bricks();
    bus.reply(
        "RemoveDevice",
        Reply::Err(BluezError::new(
            "org.bluez.Error.DoesNotExist",
            "Does Not Exist",
        )),
    );
    let rig = self::rig(Arc::clone(&bus)).await;
    rig.provider.forget(&key(AAA)).await.unwrap();
}

#[tokio::test(start_paused = true)]
async fn forget_reports_a_refusal_with_bluezs_reason() {
    let bus = three_bricks();
    bus.reply(
        "RemoveDevice",
        Reply::Err(BluezError::new(
            "org.bluez.Error.Failed",
            "Operation failed",
        )),
    );
    let rig = rig(Arc::clone(&bus)).await;
    let error = rig.provider.forget(&key(AAA)).await.unwrap_err();
    assert!(
        error.message.contains("Could not forget 001653F00A0A"),
        "{}",
        error.message
    );
    assert!(
        error.message.contains("Operation failed"),
        "{}",
        error.message
    );
}

#[tokio::test(start_paused = true)]
async fn forget_removes_only_through_the_adapter_that_holds_the_brick() {
    let bus = FakeBus::new(vec![
        adapter_object(),
        device_object(
            "/org/bluez/hci1/dev_00_16_53_F0_0A_0A",
            AAA,
            Some("AAA"),
            true,
            None,
        ),
    ]);
    let rig = rig(Arc::clone(&bus)).await;
    let error = rig.provider.forget(&key(AAA)).await.unwrap_err();
    assert!(
        error.message.contains("another adapter"),
        "{}",
        error.message
    );
    assert_eq!(bus.count("RemoveDevice"), 0);
}

#[tokio::test(start_paused = true)]
async fn declares_what_it_offers() {
    let rig = rig(three_bricks()).await;
    let capabilities = rig.provider.capabilities();
    assert!(capabilities.supports_pairing && capabilities.supports_presence);
    assert!(capabilities.supports_forget && capabilities.rejoin_on_evidence_only);
    assert!(!capabilities.supports_probe);
    assert_eq!(rig.provider.priority(), 20);
    assert_eq!(rig.provider.radio_name().as_deref(), Some("HOSTD"));
    rig.provider.dispose().await;
    assert!(rig.provider.discover().await.is_err());
}

#[tokio::test(start_paused = true)]
async fn an_inquiry_waits_for_the_late_stop_of_a_search_that_gave_up() {
    let bus = FakeBus::new(vec![adapter_object()]);
    // The pairing search's discovery starts only after it was given up.
    bus.reply(
        "StartDiscovery",
        Reply::After(Duration::from_secs(5), Box::new(Reply::Ok)),
    );
    let rig = Arc::new(rig(Arc::clone(&bus)).await);
    let pairing = {
        let rig = Arc::clone(&rig);
        tokio::spawn(async move { rig.provider.pair(&key(AAA)).await })
    };
    tokio::time::sleep(Duration::from_secs(1)).await;
    pairing.abort();
    rig.provider.run_inquiry().await;
    let members = bus.members();
    let late_stop = members.iter().position(|m| m == "StopDiscovery").unwrap();
    let window = members
        .iter()
        .rposition(|m| m == "SetDiscoveryFilter")
        .unwrap();
    assert!(late_stop < window, "{members:?}");
}

#[tokio::test(start_paused = true)]
async fn a_pairing_ends_on_the_connection_it_started_on() {
    let first = three_bricks();
    first.reply("Pair", Reply::Hang);
    let second = three_bricks();
    let connector = FakeConnector::with(vec![Ok(Arc::clone(&first)), Ok(Arc::clone(&second))]);
    let said = Arc::new(Said::default());
    let session = ev3_transports::bt_linux::session::BluezSession::new(
        connector,
        Arc::clone(&said) as _,
        None,
        "student",
        Duration::from_secs(1),
    );
    session.start();
    let watched = Arc::clone(&session);
    until(move || watched.objects().is_ready()).await;
    let settings = BtLinuxSettings {
        queue: quick_queue(),
        ..BtLinuxSettings::default()
    };
    let provider = Arc::new(LinuxBtProvider::new(
        BtLinuxParts {
            session: Arc::clone(&session),
            connector: Arc::new(MeasuredBrick::default()),
            prober: Arc::new(Probe::default()),
            sysfs: Arc::new(Sysfs::default()),
            queue: Arc::new(BtConnectionQueue::new(settings.queue)),
            activity: said as _,
            rule_path: None,
        },
        settings,
    ));
    let pairing = {
        let provider = Arc::clone(&provider);
        tokio::spawn(async move { provider.pair(&key(CCC)).await })
    };
    let pairing_bus = Arc::clone(&first);
    until(move || pairing_bus.count("Pair") == 1).await;
    session.retry();
    let watched = Arc::clone(&session);
    until(move || watched.objects().is_ready()).await;
    pairing.abort();
    let cleaned = Arc::clone(&first);
    until(move || cleaned.count("UnregisterAgent") == 1).await;
    assert_eq!(first.count("CancelPairing"), 1);
    for member in ["CancelPairing", "UnregisterAgent", "Pair", "RegisterAgent"] {
        assert_eq!(
            second.count(member),
            0,
            "{member} went to the new connection"
        );
    }
}
