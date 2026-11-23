//! `bricks/list` with `waitForDiscovery` waits for the first discovery round: every provider has
//! answered a scan, or the wait has run out. Providers are fakes on a paused clock, so the waits
//! are exact.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ev3_cockpitd::confine::Confinement;
use ev3_cockpitd::log::Log;
use ev3_cockpitd::questions::Questions;
use ev3_cockpitd::settings::SettingsStore;
use ev3_cockpitd::state::{Identity, Shared};
use ev3_cockpitd::surface::Surface;
use ev3_cockpitd::surface::runtime::{Bluetooth, Providers};
use ev3_contract::{BricksListParams, BuildKind, DaemonMode};
use ev3_transports::{
    BrickKey, DiscoveryItem, DiscoveryScanResult, PresenceState, SendOptions, SessionHandle,
    Transport, TransportCapabilities, TransportError, TransportProvider,
};
use tokio::time::{Instant, advance, sleep, timeout};

/// A provider that lists one brick, but not before `ready_after` (until then a scan fails, as
/// Bluetooth does while BlueZ is still opening) and not sooner than `delay` into each scan.
struct Fake {
    transport: Transport,
    brick: &'static str,
    ready_after: Duration,
    delay: Duration,
    born: Instant,
}

impl Fake {
    fn new(transport: Transport, brick: &'static str) -> Self {
        Self {
            transport,
            brick,
            ready_after: Duration::ZERO,
            delay: Duration::ZERO,
            born: Instant::now(),
        }
    }

    fn ready_after(mut self, after: Duration) -> Self {
        self.ready_after = after;
        self
    }

    fn delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }
}

#[async_trait]
impl TransportProvider for Fake {
    fn transport(&self) -> Transport {
        self.transport
    }

    fn priority(&self) -> i32 {
        0
    }

    fn capabilities(&self) -> TransportCapabilities {
        TransportCapabilities::default()
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        if !self.delay.is_zero() {
            sleep(self.delay).await;
        }
        if self.born.elapsed() < self.ready_after {
            return Err(TransportError::transport_failed("Not ready yet."));
        }
        Ok(DiscoveryScanResult {
            transport: self.transport,
            items: vec![DiscoveryItem {
                brick_key: BrickKey::new(self.transport, self.brick)?,
                display_name: "AAA".into(),
                name_source: None,
                transport: self.transport,
                presence_state: PresenceState::Available,
                remembered: false,
                connected: false,
                favorite: false,
                paired: None,
                heard: None,
                heard_at: None,
                signal_info: None,
                bt_visible: None,
                last_seen_at: 0,
            }],
        })
    }

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        Ok(SessionHandle {
            brick_key: brick_key.clone(),
            transport: self.transport,
        })
    }

    async fn disconnect(&self, _brick_key: &BrickKey) -> Result<(), TransportError> {
        Ok(())
    }

    async fn send_packet(
        &self,
        _brick_key: &BrickKey,
        _packet: &[u8],
        _options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        Ok(Vec::new())
    }
}

fn state_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ev3-first-round-{}-{tag}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("state dir");
    dir
}

/// A surface over an instant USB fake and `bluetooth`.
fn surface(tag: &str, bluetooth: Fake) -> (Arc<Surface>, PathBuf) {
    let dir = state_dir(tag);
    let identity = Identity {
        version: "0.0.0".into(),
        build_kind: BuildKind::Development,
        build_id: "0".into(),
        mode: DaemonMode::Replay,
        pid: std::process::id(),
        instance_id: "0".into(),
        started_at: 0,
        channel_path: String::new(),
    };
    let shared = Arc::new(Shared::new(
        identity,
        vec![0; 32],
        dir.join("key"),
        Log::open(&dir.join("log")),
        SettingsStore::load(&dir.join("settings.json"), |_| {}),
        Confinement::new([dir.clone()]).expect("roots"),
    ));
    let providers = Providers {
        list: vec![
            Arc::new(Fake::new(Transport::Usb, "001653f00a0a")),
            Arc::new(bluetooth),
        ],
        bluetooth: Bluetooth::None,
        replay: true,
    };
    let surface = Surface::start(
        shared,
        Arc::new(Questions::default()),
        providers,
        &dir,
        vec![],
    )
    .expect("surface");
    (surface, dir)
}

fn waiting() -> BricksListParams {
    BricksListParams {
        wait_for_discovery: Some(true),
    }
}

/// How many channels the listed bricks have in all.
fn channels(surface: &Surface) -> usize {
    surface.bricks().iter().map(|b| b.channels.len()).sum()
}

fn bluetooth(brick: &'static str) -> Fake {
    Fake::new(Transport::Bt, brick)
}

#[tokio::test(start_paused = true)]
async fn a_list_that_waits_holds_for_a_slow_first_round_and_lists_what_it_found() {
    let (surface, dir) = surface(
        "slow",
        bluetooth("00:16:53:f0:0b:0b").delay(Duration::from_secs(3)),
    );
    let list = tokio::spawn({
        let surface = surface.clone();
        async move { surface.bricks_list(waiting()).await }
    });
    advance(Duration::from_millis(2900)).await;
    assert!(
        !list.is_finished(),
        "it answered before the first round was over"
    );

    advance(Duration::from_millis(200)).await;
    let answer = list.await.expect("task");
    assert_eq!(
        answer
            .bricks
            .iter()
            .map(|b| b.channels.len())
            .sum::<usize>(),
        2,
        "the USB and the Bluetooth channel are both listed"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(start_paused = true)]
async fn a_list_that_does_not_wait_answers_at_once_with_what_is_known() {
    let (surface, dir) = surface(
        "nowait",
        bluetooth("00:16:53:f0:0b:0b").delay(Duration::from_secs(3)),
    );
    let answer = timeout(
        Duration::from_millis(1),
        surface.bricks_list(BricksListParams::default()),
    )
    .await
    .expect("it answers without waiting");
    assert!(
        answer.bricks.len() < 2,
        "the first round is not over, so not everything is listed"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(start_paused = true)]
async fn a_provider_that_is_not_ready_for_its_first_scan_is_asked_again_before_the_list_answers() {
    // BlueZ still opening: the first scan of Bluetooth fails at once.
    let (surface, dir) = surface(
        "notready",
        bluetooth("00:16:53:f0:0b:0b").ready_after(Duration::from_secs(2)),
    );
    let list = tokio::spawn({
        let surface = surface.clone();
        async move { surface.bricks_list(waiting()).await }
    });
    advance(Duration::from_millis(1500)).await;
    assert!(
        !list.is_finished(),
        "it answered with Bluetooth not yet scanned"
    );

    advance(Duration::from_secs(2)).await;
    let answer = list.await.expect("task");
    assert_eq!(
        answer
            .bricks
            .iter()
            .map(|b| b.channels.len())
            .sum::<usize>(),
        2
    );
    assert_eq!(channels(&surface), 2);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test(start_paused = true)]
async fn the_wait_ends_after_eight_seconds_when_a_provider_never_answers() {
    let (surface, dir) = surface(
        "never",
        bluetooth("00:16:53:f0:0b:0b").ready_after(Duration::from_secs(3600)),
    );
    let list = tokio::spawn({
        let surface = surface.clone();
        async move { surface.bricks_list(waiting()).await }
    });
    advance(Duration::from_millis(7900)).await;
    assert!(!list.is_finished(), "it gave up before eight seconds");

    advance(Duration::from_millis(300)).await;
    let answer = list.await.expect("it answers once the wait is over");
    assert!(
        answer
            .bricks
            .iter()
            .map(|b| b.channels.len())
            .sum::<usize>()
            <= 1,
        "what answered is listed, Bluetooth is not"
    );
    let _ = std::fs::remove_dir_all(dir);
}
