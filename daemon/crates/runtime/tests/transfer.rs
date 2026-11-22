//! Chunked transfers: what the brick received, not whether the call returned.
//!
//! The transfer service is where a silent truncation is cheapest to introduce and most expensive
//! to notice: the brick advances its file pointer by the length the host declared, so an
//! under-delivered chunk still reports success and lands zero padding. So these tests assert on
//! what reached the brick.
//!
//! The first part runs over a fake brick behind one link; the second over the shipped brick layer
//! and session manager, with a provider that answers file commands; the last over a real brick's
//! recorded USB exchanges.

mod support;
mod support_files;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use ev3_protocol::packet::command::SYSTEM_COMMAND_REPLY;
use ev3_protocol::packet::{reply, system, system_status};
use ev3_protocol::{BrickCommand, BrickResponse, build_command, encode_ev3_packet};
use ev3_runtime::bricks::{BrickError, BrickManager, BrickOptions, CommandOptions};
use ev3_runtime::fs::{BrickFilesystem, FsError};
use ev3_runtime::ledger::{Ledgers, TransferDebt};
use ev3_runtime::ports::{ActivityEvent, ConsentAnswer};
use ev3_runtime::transfer::{
    CancelFlag, FileLink, TransferOptions, TransferProgress, packet_bytes_of, sizes_for,
};
use ev3_runtime::{
    BackoffConfig, BrickConfig, ConnectionState, DiscoveryConfig, DiscoveryScheduler, Guard,
    PresenceAggregator, SessionConfig, SessionManager,
};
use ev3_transports::fixture::RECORDING_FILE;
use ev3_transports::{
    BrickKey, DiscoveryItem, DiscoveryScanResult, NameSource, ProbeLink, Replay, ReplayMode,
    SendOptions, SessionHandle, Transport, TransportCapabilities, TransportError,
    TransportProvider,
};
use support::{FakeProvider, SendFault, bt_key, settle, sighting, usb_key};
use support_files::{Consent, FakeLink, PATH, Reports, body, requester, service_over, writes};
use tokio::time::{Instant, sleep};

fn granted() -> Arc<Consent> {
    Consent::always(ConsentAnswer::Granted)
}

fn progress_log() -> (Arc<Mutex<Vec<TransferProgress>>>, TransferOptions) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let options = TransferOptions {
        on_progress: Some(Arc::new(move |p| log.lock().unwrap().push(p))),
        ..TransferOptions::default()
    };
    (seen, options)
}

// ── Writes ──────────────────────────────────────────────────────────

#[tokio::test]
async fn delivers_every_byte_of_a_file_that_spans_many_packets() {
    let link = FakeLink::new(Some(1024));
    let (_, service) = service_over(&link, granted());
    let content = body(5000);

    service
        .write_file(PATH, &content, &TransferOptions::default())
        .await
        .unwrap();

    assert_eq!(link.file(PATH), Some(content));
    assert!(
        link.state().written.len() > 1,
        "5000 bytes must take more than one packet"
    );
}

#[tokio::test]
async fn honours_a_tighter_packet_cap_as_usb_hid_requires() {
    // A HID write delivers 64 bytes, so the service chunks to that and not to the firmware's
    // roomier buffer. The wire packet is the 6-byte envelope plus the handle plus the payload.
    let link = FakeLink::new(Some(64));
    let (_, service) = service_over(&link, granted());
    let content = body(300);

    service
        .write_file(PATH, &content, &TransferOptions::default())
        .await
        .unwrap();

    assert_eq!(link.file(PATH), Some(content));
    let written = link.state().written.clone();
    assert!(written.iter().all(|n| n + 7 <= 64), "{written:?}");
}

#[tokio::test]
async fn fills_a_packet_larger_than_the_stock_1024_when_the_link_is_given_one() {
    // The user may set a larger packet over TCP or Bluetooth for a firmware that takes it; every
    // chunk must use it, not only the first.
    let link = FakeLink::new(Some(4096));
    let (_, service) = service_over(&link, granted());
    let content = body(20_000);

    service
        .write_file(PATH, &content, &TransferOptions::default())
        .await
        .unwrap();
    let back = service
        .read_file(PATH, &TransferOptions::default())
        .await
        .unwrap();

    assert_eq!(link.file(PATH), Some(content.clone()));
    assert_eq!(back, content);
    assert_eq!(link.state().written[1], 4096 - 7);
    assert_eq!(link.state().wants[0], 4096 - 12);
}

#[test]
fn encodes_a_continuation_chunk_over_the_stock_1017_and_refuses_one_past_the_protocol() {
    assert!(
        build_command(&BrickCommand::FsContinueWrite {
            handle: 3,
            chunk: vec![0; 4089],
        })
        .is_ok()
    );
    let error = build_command(&BrickCommand::FsContinueWrite {
        handle: 3,
        chunk: vec![0; 0x10000],
    })
    .unwrap_err();
    assert!(error.message().contains("protocol"), "{error}");
}

#[tokio::test]
async fn reports_progress_that_reaches_the_total() {
    let link = FakeLink::new(Some(1024));
    let (_, service) = service_over(&link, granted());
    let (seen, options) = progress_log();

    service
        .write_file(PATH, &body(3000), &options)
        .await
        .unwrap();

    let seen: Vec<usize> = seen.lock().unwrap().iter().map(|p| p.transferred).collect();
    assert!(seen.len() > 1, "progress must be reported per chunk");
    assert_eq!(seen.last(), Some(&3000));
    // Monotonic, so a consumer can drive a progress bar from it.
    assert!(seen.windows(2).all(|w| w[1] > w[0]), "{seen:?}");
}

#[tokio::test]
async fn stops_within_one_chunk_of_cancellation_and_releases_the_slot() {
    let link = FakeLink::new(Some(1024));
    let (ledger, service) = service_over(&link, granted());
    let cancel = CancelFlag::new();
    let flag = cancel.clone();
    let options = TransferOptions {
        on_progress: Some(Arc::new(move |_| flag.cancel())),
        cancel: Some(cancel),
        ..TransferOptions::default()
    };

    let error = service
        .write_file(PATH, &body(5000), &options)
        .await
        .unwrap_err();

    assert_eq!(error, FsError::Cancelled);
    assert_eq!(link.kinds(), ["fs:beginWrite", "close 3", "fs:delete"]);
    assert_eq!(link.open_slots(), 0);
    assert_eq!(ledger.pending(), 0);
}

#[tokio::test]
async fn refuses_a_path_the_firmware_would_truncate() {
    let link = FakeLink::new(Some(1024));
    let (_, service) = service_over(&link, granted());
    let too_long = format!("/home/root/lms2012/prjs/{}.raw", "d".repeat(60));

    let error = service
        .write_file(&too_long, &body(10), &TransferOptions::default())
        .await
        .unwrap_err();

    assert!(error.to_string().contains("truncates silently"), "{error}");
    assert!(link.kinds().is_empty(), "nothing may reach the wire");
}

#[tokio::test(start_paused = true)]
async fn fails_when_the_brick_stalls_instead_of_waiting_forever() {
    let link = FakeLink::new(Some(1024));
    link.state().silent = Some("fs:beginWrite");
    let (ledger, service) = service_over(&link, granted());
    let options = TransferOptions {
        stall_timeout: Some(Duration::from_millis(40)),
        ..TransferOptions::default()
    };

    let error = service
        .write_file(PATH, &body(10), &options)
        .await
        .unwrap_err();

    assert!(
        matches!(error, FsError::Stalled { transferred: 0, .. }),
        "{error:?}"
    );
    assert!(error.to_string().contains("stalled"), "{error}");
    // The first command may have opened a slot whose number never came back.
    assert_eq!(
        ledger.snapshot(),
        [TransferDebt::Unknown {
            delete_path: Some(PATH.into())
        }]
    );
}

// ── Reads ───────────────────────────────────────────────────────────

#[tokio::test]
async fn reassembles_a_file_that_spans_many_packets() {
    let link = FakeLink::new(Some(1024));
    let content = body(5000);
    link.state().files.insert(PATH.into(), content.clone());
    let (_, service) = service_over(&link, granted());

    assert_eq!(
        service
            .read_file(PATH, &TransferOptions::default())
            .await
            .unwrap(),
        content
    );
}

#[tokio::test]
async fn a_bounded_read_refuses_a_larger_file_after_the_first_reply_and_releases_the_slot() {
    // An inline read takes at most 64 KiB: the brick says the size in its first reply, and the
    // rest of a larger file must not cross the link only to be refused.
    let link = FakeLink::new(Some(1024));
    link.state().files.insert(PATH.into(), body(5000));
    let (ledger, service) = service_over(&link, granted());
    let options = TransferOptions {
        max_bytes: Some(4000),
        ..TransferOptions::default()
    };

    let error = service.read_file(PATH, &options).await.unwrap_err();

    assert_eq!(
        error,
        FsError::TooLarge {
            bytes: 5000,
            max: 4000
        }
    );
    let kinds = link.kinds();
    assert!(
        !kinds.iter().any(|k| k == "fs:continueRead"),
        "the rest of the file was read: {kinds:?}"
    );
    assert_eq!(link.open_slots(), 0);
    assert_eq!(ledger.pending(), 0);

    // A file within the bound reads as before.
    link.state().files.insert(PATH.into(), body(4000));
    assert_eq!(service.read_file(PATH, &options).await.unwrap(), body(4000));
}

#[tokio::test]
async fn asks_for_no_more_than_the_packet_cap_allows() {
    // A read reply carries the largest header of any transfer step, so asking the firmware's
    // full chunk over USB overran the frame and silently truncated the tail.
    let link = FakeLink::new(Some(64));
    let content = body(400);
    link.state().files.insert(PATH.into(), content.clone());
    let (_, service) = service_over(&link, granted());

    assert_eq!(
        service
            .read_file(PATH, &TransferOptions::default())
            .await
            .unwrap(),
        content
    );
    let wants = link.state().wants.clone();
    assert!(!wants.is_empty());
    assert!(
        wants.iter().all(|w| usize::from(*w) + 12 <= 64),
        "{wants:?}"
    );
}

// ── The packet a link carries ───────────────────────────────────────

#[tokio::test]
async fn takes_usb_at_what_a_hid_write_delivers_when_the_link_cannot_say() {
    // The floor, not the truth: chunking small is slow, chunking large is silent truncation.
    let link = FakeLink::new(None);
    let (_, service) = service_over(&link, granted());

    service
        .write_file("/p/x", &body(200), &TransferOptions::default())
        .await
        .unwrap();

    let written = link.state().written.clone();
    assert!(written.len() > 1, "200 bytes must not fit one USB packet");
    assert!(written.iter().all(|n| n + 7 <= 64), "{written:?}");
}

#[tokio::test]
async fn lets_the_live_link_overrule_the_usb_floor() {
    // A USB link over libusb carries the full 1024 bytes; chunking it to 64 is slow with
    // nothing visibly wrong.
    let link = FakeLink::new(Some(1024));
    let (_, service) = service_over(&link, granted());

    service
        .write_file("/p/x", &body(600), &TransferOptions::default())
        .await
        .unwrap();

    assert_eq!(
        link.state().written,
        [600],
        "600 bytes fit one 1024-byte frame"
    );
}

#[test]
fn leaves_the_stream_transports_on_the_firmware_default() {
    // TCP and Bluetooth reach the firmware's own 1024-byte buffer; USB's 64 would cost about a
    // sixteenth of the throughput.
    let tcp = FakeLink::over(BrickKey::new(Transport::Tcp, "00165300000a").unwrap(), None);
    let bt = FakeLink::over(bt_key(), None);
    let usb = FakeLink::over(usb_key(), None);
    assert_eq!(packet_bytes_of(tcp.as_ref()), 1024);
    assert_eq!(packet_bytes_of(bt.as_ref()), 1024);
    assert_eq!(packet_bytes_of(usb.as_ref()), 64);
    assert_eq!(sizes_for(1024).unwrap().max_read_bytes, 1012);
}

// ── An upload whose reply is lost ───────────────────────────────────

const ROBOT: &str = "/home/root/lms2012/prjs/Robot/a.rbf";

fn restart_brick() -> Arc<FakeLink> {
    // Packets small enough that a file takes several chunks.
    let link = FakeLink::new(Some(64));
    link.state().next_handle = 1;
    link
}

#[tokio::test]
async fn starts_again_from_its_first_chunk_within_its_budget_and_never_sends_the_lost_chunk_alone()
{
    let link = restart_brick();
    let (ledger, service) = service_over(&link, granted());
    let content: Vec<u8> = (0..200).map(|i| i as u8).collect();
    // The second chunk's reply is lost, and the link with it: the slot's close that follows is
    // refused before it leaves, so the slot is owed.
    let mut chunks = 0;
    link.state().lose = Some(Box::new(move |c| {
        matches!(c, BrickCommand::FsContinueWrite { .. }) && {
            chunks += 1;
            chunks == 2
        }
    }));
    let mut refused = false;
    link.state().refuse = Some(Box::new(move |c| {
        matches!(c, BrickCommand::FsCloseHandle { .. }) && !std::mem::replace(&mut refused, true)
    }));
    let options = TransferOptions {
        deadline: Some(Instant::now() + Duration::from_secs(2)),
        ..TransferOptions::default()
    };

    service.write_file(ROBOT, &content, &options).await.unwrap();

    assert_eq!(
        link.file(ROBOT),
        Some(content),
        "the file on the brick is not the file sent"
    );
    let log = link.state().log.clone();
    let first = log.iter().position(|l| l == "chunk 1").unwrap();
    let lost_at = first
        + 1
        + log[first + 1..]
            .iter()
            .position(|l| l == "chunk 1")
            .unwrap();
    let next = log[lost_at + 1..]
        .iter()
        .find(|l| l.starts_with("chunk") || l.starts_with("begin"));
    assert_eq!(next.map(String::as_str), Some("begin 2"), "{log:?}");
    let at = |line: &str| log.iter().position(|l| l == line).unwrap();
    assert!(
        at("close 1") < at("begin 2"),
        "the abandoned slot was not released first: {log:?}"
    );
    assert!(
        at(&format!("delete {ROBOT}")) < at("begin 2"),
        "the partial file was not deleted first: {log:?}"
    );
    assert_eq!(ledger.pending(), 0);
    assert_eq!(link.open_slots(), 0, "a slot is still held on the brick");
}

#[tokio::test]
async fn fails_with_the_lost_replys_error_when_it_has_no_budget() {
    let link = restart_brick();
    let (_, service) = service_over(&link, granted());
    let mut chunks = 0;
    link.state().lose = Some(Box::new(move |c| {
        matches!(c, BrickCommand::FsContinueWrite { .. }) && {
            chunks += 1;
            chunks == 2
        }
    }));

    let error = service
        .write_file(ROBOT, &body(200), &TransferOptions::default())
        .await
        .unwrap_err();

    assert!(error.to_string().contains("no reply"), "{error}");
    let begins = link
        .state()
        .log
        .iter()
        .filter(|l| l.starts_with("begin"))
        .count();
    assert_eq!(begins, 1, "it started again without a budget");
}

#[tokio::test]
async fn fails_for_good_on_a_lost_channel_without_a_budget_and_owes_the_slot_as_certain() {
    // The pinned channel is gone: every later step is refused before it leaves, so the close
    // is known not to have run and the slot is still the transfer's.
    let link = FakeLink::new(Some(1024));
    let (ledger, service) = service_over(&link, granted());
    link.state().refuse = Some(Box::new(|c| {
        matches!(c, BrickCommand::FsContinueWrite { .. })
            || matches!(c, BrickCommand::FsCloseHandle { .. })
    }));

    let error = service
        .write_file(PATH, &body(3000), &TransferOptions::default())
        .await
        .unwrap_err();

    assert!(matches!(error, FsError::Command(_)), "{error:?}");
    assert_eq!(
        ledger.snapshot(),
        [TransferDebt::slot(3, Some(PATH.into()))]
    );
}

// ── A transfer dropped halfway ──────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn owes_the_slot_of_a_write_whose_caller_dropped_it_and_releases_it_before_the_next() {
    // Dropping the future is how a caller cancels, and a dropped future sends no close.
    let link = FakeLink::new(Some(1024));
    let (ledger, service) = service_over(&link, granted());
    link.hold("fs:continueWrite");
    let (content, options) = (body(3000), TransferOptions::default());

    tokio::select! {
        _ = service.write_file(PATH, &content, &options) => panic!("finished"),
        () = sleep(Duration::from_millis(10)) => {}
    }
    // The first of two continuation chunks was on its way: the slot is still the transfer's.
    assert_eq!(
        ledger.snapshot(),
        [TransferDebt::slot(3, Some(PATH.into()))]
    );

    link.clear();
    service
        .write_file("/p/y", &body(10), &TransferOptions::default())
        .await
        .unwrap();
    assert_eq!(link.kinds()[..3], ["close 3", "fs:delete", "fs:beginWrite"]);
    assert_eq!(ledger.pending(), 0);
}

#[tokio::test(start_paused = true)]
async fn owes_an_uncertain_slot_when_the_write_is_dropped_with_its_last_chunk_on_the_way() {
    let link = FakeLink::new(Some(1024));
    let (ledger, service) = service_over(&link, granted());
    link.hold("fs:continueWrite");
    let (content, options) = (body(1500), TransferOptions::default());

    tokio::select! {
        // 984 bytes ride in BEGIN, the other 516 in one last chunk.
        _ = service.write_file(PATH, &content, &options) => panic!("finished"),
        () = sleep(Duration::from_millis(10)) => {}
    }

    assert_eq!(
        ledger.snapshot(),
        [TransferDebt::uncertain_slot(3, Some(PATH.into()))]
    );
}

// ── Over the brick layer ────────────────────────────────────────────

const AAA: &str = "00165300000A";

/// The files and slots of one brick, shared by every channel that reaches it.
#[derive(Default)]
struct Disk {
    files: HashMap<String, Vec<u8>>,
    slots: HashMap<u8, (String, usize, Vec<u8>)>,
    next: u8,
    /// `usb begin 1`, `bt close 1`: what the brick did, over which channel.
    log: Vec<String>,
}

impl Disk {
    fn lines(&self, prefix: &str) -> Vec<String> {
        self.log
            .iter()
            .filter_map(|l| l.strip_prefix(prefix).map(str::to_owned))
            .collect()
    }
}

fn c_path(bytes: &[u8]) -> (String, &[u8]) {
    let end = bytes.iter().position(|b| *b == 0).unwrap();
    (
        String::from_utf8(bytes[..end].to_vec()).unwrap(),
        &bytes[end + 1..],
    )
}

/// A fake provider whose brick answers the file commands a transfer sends, over the shared fake
/// for everything else (links, discovery, cable, direct commands).
struct FileBrick {
    inner: Arc<FakeProvider>,
    disk: Arc<Mutex<Disk>>,
    packet: Option<usize>,
}

impl FileBrick {
    fn answer(&self, command: u8, body: &[u8]) -> Vec<u8> {
        let mut disk = self.disk.lock().unwrap();
        let label = self.inner.transport().as_str().to_owned();
        let ok = |handle: u8, eof: bool| {
            vec![
                command,
                if eof {
                    system_status::END_OF_FILE
                } else {
                    system_status::OK
                },
                handle,
            ]
        };
        match command {
            system::BEGIN_DOWNLOAD => {
                let total = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
                let (path, chunk) = c_path(&body[4..]);
                disk.next += 1;
                let handle = disk.next;
                disk.log.push(format!("{label} begin {handle}"));
                disk.slots.insert(handle, (path, total, Vec::new()));
                let eof = Self::take(&mut disk, handle, chunk);
                ok(handle, eof)
            }
            system::CONTINUE_DOWNLOAD => {
                let handle = body[0];
                disk.log.push(format!("{label} chunk {handle}"));
                let eof = Self::take(&mut disk, handle, &body[1..]);
                ok(handle, eof)
            }
            system::CLOSE_FILEHANDLE => {
                disk.log.push(format!("{label} close {}", body[0]));
                disk.slots.remove(&body[0]);
                vec![command, system_status::OK]
            }
            system::DELETE_FILE => {
                let (path, _) = c_path(body);
                disk.log.push(format!("{label} delete {path}"));
                disk.files.remove(&path);
                vec![command, system_status::OK]
            }
            other => panic!("not expected here: 0x{other:x}"),
        }
    }

    fn take(disk: &mut Disk, handle: u8, chunk: &[u8]) -> bool {
        let Some((path, total, data)) = disk.slots.get_mut(&handle) else {
            return false;
        };
        data.extend_from_slice(chunk);
        if data.len() < *total {
            return false;
        }
        let (path, data) = (path.clone(), data.clone());
        disk.files.insert(path, data);
        disk.slots.remove(&handle);
        true
    }
}

#[async_trait]
impl TransportProvider for FileBrick {
    fn transport(&self) -> Transport {
        self.inner.transport()
    }

    fn priority(&self) -> i32 {
        self.inner.priority()
    }

    fn capabilities(&self) -> TransportCapabilities {
        self.inner.capabilities()
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        self.inner.discover().await
    }

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.inner.connect(brick_key).await
    }

    async fn recover(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.inner.recover(brick_key).await
    }

    async fn disconnect(&self, brick_key: &BrickKey) -> Result<(), TransportError> {
        self.inner.disconnect(brick_key).await
    }

    async fn open_probe(&self, brick_key: &BrickKey) -> Result<Box<dyn ProbeLink>, TransportError> {
        self.inner.open_probe(brick_key).await
    }

    fn max_packet_bytes(&self, _brick_key: &BrickKey) -> Option<usize> {
        self.packet
    }

    async fn send_packet(
        &self,
        brick_key: &BrickKey,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        if packet[4] != SYSTEM_COMMAND_REPLY {
            return self.inner.send_packet(brick_key, packet, options).await;
        }
        {
            let state = self.inner.state();
            if !state.held {
                return Err(TransportError::transport_failed("The link is not open."));
            }
            if let Some(SendFault::Fail(error)) = &state.fault {
                return Err(error.clone());
            }
        }
        let counter = u32::from(u16::from_le_bytes([packet[2], packet[3]]));
        let payload = self.answer(packet[5], &packet[6..]);
        Ok(encode_ev3_packet(counter, reply::SYSTEM_REPLY, &payload).unwrap())
    }
}

struct World {
    usb: Arc<FakeProvider>,
    disk: Arc<Mutex<Disk>>,
    bricks: BrickManager,
    ledgers: Ledgers,
    reports: Arc<Reports>,
}

impl World {
    fn files(&self) -> BrickFilesystem {
        BrickFilesystem::new(
            &self.bricks,
            AAA,
            &self.ledgers,
            writes(self.reports.clone()),
            CommandOptions::default(),
        )
    }
}

/// AAA signed in over USB and Bluetooth, both connected, traffic over USB.
async fn both_channels() -> World {
    world(true, granted()).await
}

/// AAA signed in over USB, and over Bluetooth too when `with_bt`; traffic over USB. A sweep asks
/// `consent`.
async fn world(with_bt: bool, consent: Arc<Consent>) -> World {
    let disk = Arc::new(Mutex::new(Disk::default()));
    let usb = FakeProvider::new(Transport::Usb);
    let bt = FakeProvider::new(Transport::Bt);
    usb.state().seen = vec![sighting(&usb_key(), "AAA", Some(NameSource::UsbDescriptor))];
    if with_bt {
        bt.state().seen = vec![DiscoveryItem {
            paired: Some(true),
            ..sighting(&bt_key(), "AAA", Some(NameSource::BtCache))
        }];
    }
    let providers: [Arc<dyn TransportProvider>; 2] = [
        Arc::new(FileBrick {
            inner: usb.clone(),
            disk: disk.clone(),
            packet: Some(1024),
        }),
        Arc::new(FileBrick {
            inner: bt.clone(),
            disk: disk.clone(),
            packet: None,
        }),
    ];
    let short = BackoffConfig {
        base: Duration::from_millis(20),
        max: Duration::from_millis(40),
        ..BackoffConfig::default()
    };
    let scheduler = DiscoveryScheduler::new(
        providers.clone(),
        DiscoveryConfig {
            unavailable_after_misses: 1,
            removed_after_misses: 5,
            ..DiscoveryConfig::default()
        },
    );
    let list = PresenceAggregator::new(scheduler.clone());
    let sessions = SessionManager::new(
        providers,
        Arc::new(Guard::default()),
        SessionConfig {
            heartbeat_interval: Duration::from_secs(3600),
            backoff: short,
            ..SessionConfig::default()
        },
    );
    let options = BrickOptions {
        config: BrickConfig {
            rejoin_backoff: short,
            slow_probe_retry: Duration::from_millis(20),
        },
        ..BrickOptions::default()
    };
    let bricks = BrickManager::new(sessions.clone(), list, options);
    scheduler.scan_once().await;
    settle().await;
    bricks.sign_in(AAA).await.unwrap();
    for _ in 0..200 {
        if !with_bt
            || sessions.session(&bt_key()).map(|s| s.connection_state)
                == Some(ConnectionState::Connected)
        {
            break;
        }
        settle().await;
    }
    settle().await;
    assert_eq!(bricks.route_of(AAA), Some(usb_key()));
    World {
        usb,
        disk,
        bricks,
        ledgers: Ledgers::new(consent, None),
        reports: Arc::new(Reports::default()),
    }
}

/// Pulls the USB cable after a number of progress reports: after 0 the first continuation chunk
/// (of two) fails, after 1 the last one.
fn pull_cable_mid_way(
    usb: &Arc<FakeProvider>,
    after: usize,
    deadline: Option<Instant>,
) -> TransferOptions {
    let usb = usb.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    TransferOptions {
        on_progress: Some(Arc::new(move |_| {
            if calls.fetch_add(1, Ordering::SeqCst) == after {
                usb.pull_cable();
            }
        })),
        deadline,
        ..TransferOptions::default()
    }
}

#[tokio::test(start_paused = true)]
async fn fails_a_usb_upload_whose_channel_is_lost_midway_and_sends_none_of_it_over_bluetooth() {
    let w = both_channels().await;
    let files = w.files();
    let content = body(3000);

    let error = files
        .transfer
        .write_file(PATH, &content, &pull_cable_mid_way(&w.usb, 0, None))
        .await
        .unwrap_err();

    assert!(
        error.to_string().contains("LIBUSB_ERROR_NO_DEVICE"),
        "{error}"
    );
    assert_eq!(w.disk.lock().unwrap().lines("bt "), Vec::<String>::new());
    // The close went nowhere: the channel left routing, so the step was refused before it left
    // and the slot is still the transfer's to close.
    assert_eq!(
        files.transfer.ledger().snapshot(),
        [TransferDebt::slot(1, Some(PATH.into()))]
    );
    assert_eq!(w.bricks.route_of(AAA), Some(bt_key()));

    // The next transfer, over Bluetooth now, pays it before it starts.
    files
        .transfer
        .write_file("/p/y", &body(10), &TransferOptions::default())
        .await
        .unwrap();
    assert_eq!(
        w.disk.lock().unwrap().lines("bt "),
        [
            "close 1".to_owned(),
            format!("delete {PATH}"),
            "begin 2".to_owned()
        ]
    );
    assert_eq!(files.transfer.ledger().pending(), 0);
}

#[tokio::test(start_paused = true)]
async fn starts_a_usb_upload_again_over_bluetooth_from_its_first_chunk_when_usb_is_lost_within_its_budget()
 {
    let w = both_channels().await;
    let files = w.files();
    let content = body(3000);
    let deadline = Some(Instant::now() + Duration::from_secs(5));

    files
        .transfer
        .write_file(PATH, &content, &pull_cable_mid_way(&w.usb, 1, deadline))
        .await
        .unwrap();

    let disk = w.disk.lock().unwrap();
    assert_eq!(disk.files.get(PATH), Some(&content));
    assert_eq!(
        disk.lines("usb "),
        ["begin 1", "chunk 1"],
        "no step after the loss over USB"
    );
    // Not a continuation of the first attempt: its slot released (the lost chunk was the last, so
    // only with the person's yes), then the file written from chunk 0.
    assert_eq!(
        disk.lines("bt "),
        [
            "close 1".to_owned(),
            format!("delete {PATH}"),
            "begin 2".to_owned(),
            "chunk 2".to_owned(),
            "chunk 2".to_owned()
        ]
    );
    assert!(disk.slots.is_empty());
    drop(disk);
    assert_eq!(files.transfer.ledger().pending(), 0);
    // One write, reported once across both attempts, done for the requester.
    let events = w.reports.0.lock().unwrap().clone();
    assert_eq!(events.len(), 2, "{events:?}");
    let ActivityEvent::WriteStarted(started) = &events[0] else {
        panic!("{events:?}")
    };
    assert_eq!(
        (started.brick_key.clone(), started.requester.clone()),
        (usb_key(), requester())
    );
    assert!(matches!(&events[1], ActivityEvent::WriteEnded(e) if e == started));
}

#[tokio::test(start_paused = true)]
async fn starts_an_upload_again_once_its_only_channel_comes_back_within_its_budget() {
    // A momentary loss of the route does not fail the upload: it waits for the channel and starts
    // again from its first chunk, the abandoned slot settled first.
    let consent = Consent::always(ConsentAnswer::Granted);
    let w = world(false, consent.clone()).await;
    let files = w.files();
    let content = body(3000);
    let started = Instant::now();
    let usb = w.usb.clone();
    let plug = tokio::spawn(async move {
        sleep(Duration::from_millis(100)).await;
        usb.plug_cable();
    });

    files
        .transfer
        .write_file(
            PATH,
            &content,
            &pull_cable_mid_way(&w.usb, 0, Some(started + Duration::from_secs(3))),
        )
        .await
        .unwrap();
    plug.await.unwrap();

    assert!(
        started.elapsed() >= Duration::from_millis(100),
        "it did not wait for the cable"
    );
    let disk = w.disk.lock().unwrap();
    assert_eq!(disk.files.get(PATH), Some(&content));
    let lines = disk.lines("usb ");
    assert_eq!(
        lines.iter().filter(|l| l.starts_with("begin")).count(),
        2,
        "{lines:?}"
    );
    assert_eq!(
        lines.iter().filter(|l| l.starts_with("close")).count(),
        1,
        "{lines:?}"
    );
    drop(disk);
    // The close after the lost chunk went over the same dead link and failed as the link failing,
    // so whether it ran is unknown and the slot is asked about: once, not again at every restart
    // that finds the channel still dead.
    assert_eq!(consent.count(), 1);
    assert_eq!(files.transfer.ledger().pending(), 0);
}

#[tokio::test(start_paused = true)]
async fn fails_at_once_without_a_route_and_owes_nothing() {
    let w = both_channels().await;
    w.bricks.sign_out(AAA).await;
    let files = w.files();

    let error = files
        .transfer
        .write_file(PATH, &body(10), &TransferOptions::default())
        .await
        .unwrap_err();

    assert!(
        matches!(error, FsError::Command(BrickError::NoRoute { .. })),
        "{error:?}"
    );
    assert_eq!(files.transfer.ledger().pending(), 0);
}

// ── On a real brick's recorded exchanges ────────────────────────────

/// AAA's hardware digits as the recordings hold them.
const RECORDED_AAA: &str = "001653F00A0A";
const FIXTURE_PATH: &str = "/home/root/lms2012/prjs/linkfixture.txt";

fn fixture(name: &str) -> PathBuf {
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/link");
    // A test binary built on one system and run on another finds the workspace from its path.
    let root = if compiled.is_dir() {
        compiled
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|exe| {
                exe.ancestors()
                    .map(|dir| dir.join("fixtures/link"))
                    .find(|dir| dir.is_dir())
            })
            .unwrap_or(compiled)
    };
    root.join(name).join(RECORDING_FILE)
}

/// The content the recording wrote, as its scenario publishes it.
fn fixture_content() -> Vec<u8> {
    let line = b"the quick brown fox jumps over the lazy dog\n";
    line.iter().copied().cycle().take(3000).collect()
}

#[tokio::test(start_paused = true)]
async fn reads_the_head_of_the_recorded_file_and_deletes_it_on_the_recorded_usb_brick() {
    // Matched: the brick layer reads the name after the join, which the recording does not hold.
    let replay = Replay::load(&fixture("usb-file-round-trip-aaa"), ReplayMode::Matched).unwrap();
    let usb = replay.provider(Transport::Usb).unwrap();
    let scheduler = DiscoveryScheduler::new([usb.clone()], DiscoveryConfig::default());
    let list = PresenceAggregator::new(scheduler.clone());
    let sessions = SessionManager::new(
        [usb],
        Arc::new(Guard::default()),
        SessionConfig {
            heartbeat_interval: Duration::from_secs(3600),
            ..SessionConfig::default()
        },
    );
    let bricks = BrickManager::new(sessions, list, BrickOptions::default());
    scheduler.scan_once().await;
    sleep(Duration::from_millis(10)).await;
    bricks.sign_in(RECORDED_AAA).await.unwrap();

    // The first read step as the service sizes it on this link: the recorded BEGIN_UPLOAD.
    let link = bricks.pin(RECORDED_AAA).unwrap();
    assert_eq!(packet_bytes_of(&link), 1024);
    let want = u16::try_from(sizes_for(packet_bytes_of(&link)).unwrap().max_read_bytes).unwrap();
    let reply = FileLink::send(
        &link,
        &BrickCommand::FsBeginRead {
            path: FIXTURE_PATH.into(),
            want_bytes: want,
        },
    )
    .await
    .unwrap();
    let BrickResponse::FsBeginRead {
        total_bytes, chunk, ..
    } = reply
    else {
        panic!("not a read reply: {reply:?}")
    };
    assert_eq!(total_bytes, 3000);
    assert_eq!(chunk, fixture_content()[..usize::from(want)]);

    // The delete as the filesystem service sends it.
    let reports = Arc::new(Reports::default());
    let ledgers = Ledgers::new(granted(), None);
    let files = BrickFilesystem::new(
        &bricks,
        RECORDED_AAA,
        &ledgers,
        writes(reports.clone()),
        CommandOptions::default(),
    );
    files.files.remove(FIXTURE_PATH).await.unwrap();
    assert_eq!(
        reports.0.lock().unwrap().len(),
        2,
        "the delete is a reported write"
    );
}
