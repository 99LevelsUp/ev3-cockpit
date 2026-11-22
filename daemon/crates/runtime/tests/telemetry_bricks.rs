//! Telemetry over the real brick layer: the service follows a brick signed in on the shipped
//! session manager, discovery and list, over a fake USB provider whose packet size the test sets.
//!
//! The frame limit belongs to the link, not to the transport or the session: a USB brick that comes
//! back on the 64-byte HID path must get frames that fit 64 bytes, or the firmware answers a
//! truncated request without complaint.

#![allow(non_snake_case)]

mod support;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use ev3_runtime::telemetry::WallClock;
use ev3_runtime::telemetry::service::{
    ReadMode, TelemetryEvent, TelemetryService, TelemetryServiceOptions, follow_bricks,
};
use ev3_runtime::{
    BackoffConfig, BrickConfig, BrickManager, BrickOptions, DiscoveryConfig, DiscoveryScheduler,
    Guard, PresenceAggregator, SessionConfig, SessionManager,
};
use ev3_transports::{
    BrickKey, DiscoveryScanResult, NameSource, ProbeLink, SendOptions, SessionHandle, Transport,
    TransportCapabilities, TransportError, TransportProvider,
};
use support::{FakeProvider, sighting, usb_key};
use tokio::time::{Instant, sleep};

const AAA: &str = "00165300000A";

/// The fake USB provider, with the packet size its link reports set by the test, and telemetry
/// frames declared as the real providers declare them.
struct SizedLink {
    inner: Arc<FakeProvider>,
    packet: Mutex<Option<usize>>,
}

#[async_trait]
impl TransportProvider for SizedLink {
    fn transport(&self) -> Transport {
        self.inner.transport()
    }
    fn priority(&self) -> i32 {
        self.inner.priority()
    }
    fn capabilities(&self) -> TransportCapabilities {
        TransportCapabilities {
            supports_telemetry_frames: true,
            ..self.inner.capabilities()
        }
    }
    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        self.inner.discover().await
    }
    async fn open_probe(&self, key: &BrickKey) -> Result<Box<dyn ProbeLink>, TransportError> {
        self.inner.open_probe(key).await
    }
    async fn connect(&self, key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.inner.connect(key).await
    }
    async fn recover(&self, key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.inner.recover(key).await
    }
    async fn disconnect(&self, key: &BrickKey) -> Result<(), TransportError> {
        self.inner.disconnect(key).await
    }
    async fn send_packet(
        &self,
        key: &BrickKey,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        self.inner.send_packet(key, packet, options).await
    }
    fn max_packet_bytes(&self, _key: &BrickKey) -> Option<usize> {
        *self.packet.lock().unwrap()
    }
}

struct World {
    usb: Arc<FakeProvider>,
    link: Arc<SizedLink>,
    scheduler: Arc<DiscoveryScheduler>,
    bricks: BrickManager,
}

fn world() -> World {
    let usb = FakeProvider::new(Transport::Usb);
    let link = Arc::new(SizedLink {
        inner: usb.clone(),
        packet: Mutex::new(Some(1024)),
    });
    let providers: [Arc<dyn TransportProvider>; 1] = [link.clone()];
    let scheduler = DiscoveryScheduler::new(providers.clone(), DiscoveryConfig::default());
    let list = PresenceAggregator::new(scheduler.clone());
    let backoff = BackoffConfig {
        base: Duration::from_millis(20),
        max: Duration::from_millis(40),
        ..BackoffConfig::default()
    };
    let sessions = SessionManager::new(
        providers,
        Arc::new(Guard::default()),
        SessionConfig {
            heartbeat_interval: Duration::from_secs(3600),
            backoff,
            ..SessionConfig::default()
        },
    );
    let bricks = BrickManager::new(
        sessions,
        list,
        BrickOptions {
            config: BrickConfig {
                rejoin_backoff: backoff,
                slow_probe_retry: Duration::from_millis(20),
            },
            ..BrickOptions::default()
        },
    );
    World {
        usb,
        link,
        scheduler,
        bricks,
    }
}

async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !done() {
        assert!(Instant::now() < deadline, "never happened: {what}");
        sleep(Duration::from_millis(1)).await;
    }
}

/// The longest request that reached the link since `from`.
fn longest_since(usb: &FakeProvider, from: usize) -> usize {
    usb.state().requests[from..]
        .iter()
        .map(Vec::len)
        .max()
        .unwrap_or(0)
}

async fn signed_in(w: &World) -> TelemetryService {
    w.usb.state().seen = vec![sighting(&usb_key(), "AAA", Some(NameSource::UsbDescriptor))];
    w.scheduler.scan_once().await;
    support::settle().await;
    w.bricks.sign_in(AAA).await.unwrap();
    let service = TelemetryService::new(
        Arc::new(w.bricks.clone()),
        TelemetryServiceOptions {
            start_loops: false,
            clock: WallClock::starting_at(0),
            ..TelemetryServiceOptions::default()
        },
    )
    .unwrap();
    follow_bricks(&service, &w.bricks);
    service
}

#[tokio::test(start_paused = true)]
async fn telemetry_over_the_brick_layer__reads_the_active_brick_through_its_command_queue() {
    let w = world();
    let service = signed_in(&w).await;
    assert_eq!(
        service.mode_of(AAA),
        ReadMode::Foreground,
        "signing in made it the active brick"
    );
    let values = Arc::new(Mutex::new(0));
    let count = values.clone();
    service.listen(Arc::new(move |event: &TelemetryEvent| {
        if let TelemetryEvent::Values { values, .. } = event {
            *count.lock().unwrap() += values.len();
        }
    }));
    service.loop_for(AAA).unwrap().run_tick().await;
    assert!(*values.lock().unwrap() > 0);
    assert_eq!(service.loop_for(AAA).unwrap().stats().frames_sent, 1);
}

#[tokio::test(start_paused = true)]
async fn telemetry_over_the_brick_layer__a_brick_that_comes_back_on_the_64_byte_path_rebuilds_its_frame_limit()
 {
    let w = world();
    let service = signed_in(&w).await;

    let before = w.usb.state().requests.len();
    service.loop_for(AAA).unwrap().run_tick().await;
    assert!(
        longest_since(&w.usb, before) > 64,
        "over libusb the first frame carries every row at once"
    );

    // The cable goes; the brick comes back on the HID fallback.
    w.usb.pull_cable();
    service.loop_for(AAA).unwrap().run_tick().await;
    wait_until("the route went", || w.bricks.route_of(AAA).is_none()).await;
    assert_eq!(
        service.mode_of(AAA),
        ReadMode::Minimal,
        "no link to compose frames for"
    );
    *w.link.packet.lock().unwrap() = Some(64);
    w.usb.plug_cable();
    wait_until("the route came back", || w.bricks.route_of(AAA).is_some()).await;
    wait_until("the loop runs again", || service.loop_for(AAA).is_some()).await;

    let after = w.usb.state().requests.len();
    for _ in 0..10 {
        service.loop_for(AAA).unwrap().run_tick().await;
    }
    let telemetry = service.loop_for(AAA).unwrap();
    assert!(
        telemetry.stats().frames_sent >= 10,
        "{:?}",
        telemetry.stats()
    );
    assert!(
        longest_since(&w.usb, after) <= 64,
        "a {}-byte frame on a 64-byte link",
        longest_since(&w.usb, after)
    );
    assert!(
        telemetry.scheduler().chain_depth().is_none(),
        "no chain is read on the HID fallback"
    );
}

#[tokio::test(start_paused = true)]
async fn telemetry_over_the_brick_layer__ends_the_claims_of_a_brick_signed_out() {
    let w = world();
    let service = signed_in(&w).await;
    let request = ev3_runtime::telemetry::claims::ClaimRequest {
        row_ids: vec!["ports.motor.A.tacho".into()],
        interval_ms: 200.0,
        modes: Default::default(),
    };
    let ticket = service.claim(AAA, &request, "ev3-c").unwrap();
    let ended = Arc::new(Mutex::new(Vec::new()));
    let sink = ended.clone();
    service.listen(Arc::new(move |event: &TelemetryEvent| {
        if let TelemetryEvent::ClaimsEnded { handles, .. } = event {
            sink.lock().unwrap().extend(handles.clone());
        }
    }));
    w.bricks.sign_out(AAA).await;
    wait_until("the claims ended", || !ended.lock().unwrap().is_empty()).await;
    assert_eq!(*ended.lock().unwrap(), [ticket.handle]);
    assert_eq!(service.mode_of(AAA), ReadMode::None);
}
