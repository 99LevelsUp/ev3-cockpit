//! Sessions running on a real brick's exchanges: the recorded USB fixtures under
//! `daemon/fixtures/link`, replayed strictly, so the session has to send exactly the recorded
//! bytes (message counters included) and use every recorded call.
//!
//! When a test here fails with `replay_deviation` or `replay_unmatched`, the session changed what
//! it sends; that is answered by recording the scenario again on hardware, never by editing the
//! recording.

mod support;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use ev3_protocol::bytecode::{gv0, lc1, lc2};
use ev3_protocol::commands::info_layout;
use ev3_protocol::packet::reply;
use ev3_protocol::{BrickCommand, BrickResponse, encode_ev3_packet};
use ev3_runtime::{ConnectionState, Guard, SessionConfig, SessionError, SessionManager};
use ev3_transports::fixture::RECORDING_FILE;
use ev3_transports::{
    BrickKey, DiscoveryScanResult, ErrorCode, Replay, ReplayMode, SendOptions, SessionHandle,
    Transport, TransportCapabilities, TransportError, TransportProvider,
};
use tokio::time::sleep;

fn fixture(name: &str) -> PathBuf {
    let compiled = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/link");
    // A test binary built on one system and run on another (cross-built for Linux, run under
    // WSL) finds the workspace from its own path instead.
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

/// Sessions whose heartbeat never fires during a replay: a battery probe the recording does not
/// hold would be a deviation.
fn manager(provider: Arc<dyn TransportProvider>) -> SessionManager {
    SessionManager::new(
        [provider],
        Arc::new(Guard::default()),
        SessionConfig {
            heartbeat_interval: Duration::from_secs(3600),
            ..SessionConfig::default()
        },
    )
}

/// Raw direct-command bytecode (globals word, then the code), as the recording harness sends it.
fn direct(payload: Vec<u8>) -> BrickCommand {
    BrickCommand::TelemetryFrame { payload }
}

/// `opNOP`, no globals.
fn nop() -> BrickCommand {
    direct(vec![0x00, 0x00, 0x01])
}

/// A command the brick holds for `ms` before it replies (`opTIMER_WAIT`, `opTIMER_READY`).
fn slow(ms: u16) -> BrickCommand {
    let mut payload = vec![0x04, 0x00, 0x85];
    payload.extend(lc2(i32::from(ms)).unwrap());
    payload.extend(gv0(0).unwrap());
    payload.push(0x86);
    payload.extend(gv0(0).unwrap());
    direct(payload)
}

/// `opINIT_BYTES` writing zeros over the first `bytes` globals: the firmware never clears them,
/// and a string reply writes only up to its terminator.
fn clear_globals(bytes: u8) -> BrickCommand {
    let mut payload = vec![bytes, 0x00, 0x2f];
    payload.extend(gv0(0).unwrap());
    payload.extend(lc1(i32::from(bytes)).unwrap());
    payload.extend(std::iter::repeat_n(0x00, usize::from(bytes)));
    direct(payload)
}

async fn discovered(provider: &Arc<dyn TransportProvider>) -> BrickKey {
    let scan = provider.discover().await.unwrap();
    scan.items
        .iter()
        .find(|item| item.display_name == "AAA")
        .expect("the recording lists AAA")
        .brick_key
        .clone()
}

#[tokio::test(start_paused = true)]
async fn a_session_runs_the_recorded_connect_and_commands_of_a_real_brick() {
    let replay = Replay::load(&fixture("usb-connect-commands-aaa"), ReplayMode::Strict).unwrap();
    let provider = replay.provider(Transport::Usb).unwrap();
    let key = discovered(&provider).await;
    let manager = manager(provider);

    manager.connect(&key, None).await.unwrap();
    assert_eq!(manager.max_packet_bytes(&key), Some(1024));
    let info_bytes = u8::try_from(info_layout::TOTAL_INFO_BYTES).unwrap();
    manager
        .send(&key, &clear_globals(info_bytes), None)
        .await
        .unwrap();
    match manager.send(&key, &BrickCommand::Info, None).await.unwrap() {
        BrickResponse::Info {
            display_name,
            firmware_version,
            ..
        } => {
            assert_eq!(display_name, "AAA");
            assert_eq!(firmware_version.as_deref(), Some("V1.10E"));
        }
        other => panic!("not an info reply: {other:?}"),
    }
    match manager
        .send(&key, &BrickCommand::Battery, None)
        .await
        .unwrap()
    {
        BrickResponse::Battery { level, .. } => assert_eq!(level, 100),
        other => panic!("not a battery reply: {other:?}"),
    }
    let listing = manager
        .send(
            &key,
            &BrickCommand::FsList {
                path: "/home/root/lms2012/prjs/".into(),
            },
            None,
        )
        .await
        .unwrap();
    assert!(
        matches!(listing, BrickResponse::FsList { ref listing, .. } if !ev3_protocol::responses::parse_listing(listing).is_empty())
    );
    manager.send(&key, &nop(), None).await.unwrap();
    manager.disconnect(&key, true).await;

    replay
        .finish()
        .expect("the session made every recorded call");
}

#[tokio::test(start_paused = true)]
async fn a_session_steps_over_a_timed_out_and_an_abandoned_command_on_a_real_brick() {
    // The brick holds the slow command 800 ms. The first one times out after 200 ms, the second
    // is dropped by its caller after 200 ms; the command after each has to go out and get its own
    // reply, and neither ends the session.
    let replay = Replay::load(&fixture("usb-stale-reply-aaa"), ReplayMode::Strict).unwrap();
    let provider = replay.provider(Transport::Usb).unwrap();
    let key = discovered(&provider).await;
    let manager = manager(provider);
    manager.connect(&key, None).await.unwrap();

    let timed_out = manager
        .send(&key, &slow(800), Some(Duration::from_millis(200)))
        .await;
    assert_eq!(
        timed_out.unwrap_err().transport_code(),
        Some(ErrorCode::Timeout)
    );
    manager
        .send(&key, &nop(), Some(Duration::from_secs(3)))
        .await
        .expect("the command after a timed-out one");

    let dropped = tokio::time::timeout(
        Duration::from_millis(200),
        manager.send(&key, &slow(800), Some(Duration::from_secs(3))),
    )
    .await;
    assert!(
        dropped.is_err(),
        "the slow command answered before its caller dropped it"
    );
    manager
        .send(&key, &nop(), Some(Duration::from_secs(3)))
        .await
        .expect("the command after an abandoned one");

    assert_eq!(
        manager.session(&key).map(|s| s.connection_state),
        Some(ConnectionState::Connected),
        "a slow reply is not a lost link"
    );
    assert!(!manager.guard().is_degraded(&key));
    manager.disconnect(&key, true).await;
    replay
        .finish()
        .expect("the session made every recorded call");
}

// ── The cable pull ──────────────────────────────────────────────────

/// Where the cable-pull provider stands.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    /// The recording answers.
    Recorded,
    /// The recorded exchange failed: the cable is out. The recorded failure answers every send
    /// until the recorded disconnect has been made.
    Pulled(TransportError),
    /// The cable is back in and a new link is open: the fake answers.
    Back,
}

/// The recording up to the pull, then the cable coming back, which no recording holds yet: the
/// recording harness pulls the cable and stops.
struct CablePull {
    replay: Arc<dyn TransportProvider>,
    phase: Mutex<Phase>,
    cable_back: Mutex<bool>,
    released: Mutex<bool>,
}

impl CablePull {
    fn phase(&self) -> Phase {
        self.phase.lock().unwrap().clone()
    }
}

#[async_trait]
impl TransportProvider for CablePull {
    fn transport(&self) -> Transport {
        self.replay.transport()
    }

    fn priority(&self) -> i32 {
        self.replay.priority()
    }

    fn capabilities(&self) -> TransportCapabilities {
        self.replay.capabilities()
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        self.replay.discover().await
    }

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        if self.phase() == Phase::Recorded {
            return self.replay.connect(brick_key).await;
        }
        if !*self.cable_back.lock().unwrap() {
            return Err(TransportError::transport_failed(
                "No EV3 found on the USB bus.",
            ));
        }
        *self.phase.lock().unwrap() = Phase::Back;
        Ok(SessionHandle {
            brick_key: brick_key.clone(),
            transport: Transport::Usb,
        })
    }

    async fn disconnect(&self, brick_key: &BrickKey) -> Result<(), TransportError> {
        let first_release = matches!(self.phase(), Phase::Pulled(_))
            && !std::mem::replace(&mut *self.released.lock().unwrap(), true);
        if first_release {
            self.replay.disconnect(brick_key).await
        } else {
            Ok(())
        }
    }

    async fn send_packet(
        &self,
        brick_key: &BrickKey,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        match self.phase() {
            Phase::Recorded => {
                let result = self.replay.send_packet(brick_key, packet, options).await;
                if let Err(error) = &result {
                    *self.phase.lock().unwrap() = Phase::Pulled(error.clone());
                }
                result
            }
            Phase::Pulled(error) => Err(error),
            Phase::Back => {
                // A battery reply, 80 %: all a test asks of the new link.
                let mut globals = Vec::new();
                globals.extend_from_slice(&7.5f32.to_le_bytes());
                globals.extend_from_slice(&0.2f32.to_le_bytes());
                globals.push(80);
                let counter = u32::from(u16::from_le_bytes([packet[2], packet[3]]));
                Ok(encode_ev3_packet(counter, reply::DIRECT_REPLY, &globals).unwrap())
            }
        }
    }
}

/// Runs the cable-pull scenario on `recording`: slow commands until the pull, the session's
/// check, the reconnect that finds the cable out, the recorded discovery without the brick, and
/// the cable coming back.
async fn cable_pull(recording: &str) {
    let replay = Replay::from_text(recording, ReplayMode::Strict).unwrap();
    let pull = Arc::new(CablePull {
        replay: replay.provider(Transport::Usb).unwrap(),
        phase: Mutex::new(Phase::Recorded),
        cable_back: Mutex::new(false),
        released: Mutex::new(false),
    });
    let provider: Arc<dyn TransportProvider> = pull.clone();
    let key = discovered(&provider).await;
    let manager = manager(provider.clone());
    manager.connect(&key, None).await.unwrap();

    let mut failure = None;
    for _ in 0..120 {
        let sent = tokio::time::timeout(
            Duration::from_secs(10),
            manager.send(&key, &slow(500), Some(Duration::from_secs(3))),
        )
        .await
        .expect("the recording holds an exchange its caller abandoned; re-record the scenario");
        if let Err(error) = sent {
            failure = Some(error);
            break;
        }
    }
    let failure = failure.expect("the recording never shows the link failing");
    println!("the recorded pull failed the exchange with {failure}");
    assert!(
        matches!(failure, SessionError::Transport(_)),
        "the pull should fail the link, not the reply: {failure:?}"
    );

    // The caller that saw the failure checks the link; a timeout on USB is one missed beat of
    // two, a link failure reconnects at once.
    for _ in 0..2 {
        if manager.session(&key).map(|s| s.connection_state) == Some(ConnectionState::Reconnecting)
        {
            break;
        }
        assert!(!manager.probe_now(&key).await);
    }
    assert_eq!(
        manager.session(&key).map(|s| s.connection_state),
        Some(ConnectionState::Reconnecting)
    );
    assert!(matches!(
        manager.send(&key, &BrickCommand::Battery, None).await,
        Err(SessionError::LinkLost { .. })
    ));

    // The reconnect releases the dead link first (the recorded disconnect), then finds the
    // cable out.
    sleep(Duration::from_secs(5)).await;
    assert!(
        *pull.released.lock().unwrap(),
        "the stale link was never released"
    );
    assert_eq!(
        manager.session(&key).map(|s| s.connection_state),
        Some(ConnectionState::Reconnecting)
    );
    // Whether the scan after the pull still lists the brick depends on how fast the system
    // forgets the device; the harness records either, so this only reports it.
    let scan = provider.discover().await.unwrap();
    let listed = scan.items.iter().any(|item| item.brick_key == key);
    println!(
        "after the pull the recorded discovery {} the brick",
        if listed {
            "still lists"
        } else {
            "no longer lists"
        }
    );
    replay
        .finish()
        .expect("the session made every recorded call");

    // The cable goes back in, and discovery sees the brick.
    *pull.cable_back.lock().unwrap() = true;
    manager.notify_brick_available(&key);
    sleep(Duration::from_millis(100)).await;
    assert_eq!(
        manager.session(&key).map(|s| s.connection_state),
        Some(ConnectionState::Connected),
        "the session did not come back with the cable"
    );
    manager
        .send(&key, &BrickCommand::Battery, None)
        .await
        .expect("the new link carries commands");
}

/// A recording in the cable-pull scenario's shape, made here: three slow commands answered, the
/// fourth failed by the pull, the harness's disconnect, and a discovery without the brick.
fn synthetic_cable_pull() -> String {
    use ev3_transports::fixture::to_hex;
    let key = "usb:001653F00A0A";
    let mut lines = vec![
        r#"{"format":1,"recorder":1,"scenario":"usb-cable-pull-aaa"}"#.to_owned(),
        r#"{"at_ms":0,"capabilities":{"rejoin_on_evidence_only":false,"supports_forget":false,"supports_pairing":false,"supports_presence":false,"supports_probe":true,"supports_recover":false,"supports_signal_info":false,"supports_telemetry_frames":true},"event":"provider","priority":30,"transport":"usb"}"#.to_owned(),
        format!(
            r#"{{"at_ms":0,"elapsed_ms":50,"event":"discover","outcome":{{"ok":{{"items":[{{"brick_key":"{key}","connected":false,"display_name":"AAA","favorite":false,"last_seen_at":50,"name_source":"usb-descriptor","presence_state":"available","remembered":false,"transport":"usb"}}],"transport":"usb"}}}},"transport":"usb"}}"#
        ),
        format!(
            r#"{{"at_ms":50,"brick_key":"{key}","elapsed_ms":15,"event":"connect","max_packet_bytes":1024,"outcome":{{"ok":{{"brick_key":"{key}","transport":"usb"}}}},"transport":"usb"}}"#
        ),
    ];
    let BrickCommand::TelemetryFrame { payload } = slow(500) else {
        unreachable!()
    };
    for counter in 1..=4u32 {
        let request = to_hex(&encode_ev3_packet(counter, 0x00, &payload).unwrap());
        let outcome = if counter < 4 {
            let reply = to_hex(&encode_ev3_packet(counter, reply::DIRECT_REPLY, &[0; 4]).unwrap());
            format!(r#""reply_hex":"{reply}""#)
        } else {
            r#""error":{"code":"transport_failed","message":"USB receive failed: LIBUSB_ERROR_NO_DEVICE"}"#.to_owned()
        };
        lines.push(format!(
            r#"{{"at_ms":{},"brick_key":"{key}",{outcome},"elapsed_ms":500,"event":"exchange","request_hex":"{request}","transport":"usb","via":"session"}}"#,
            65 + 500 * (counter - 1)
        ));
    }
    lines.push(format!(
        r#"{{"at_ms":2100,"brick_key":"{key}","elapsed_ms":0,"event":"disconnect","outcome":{{"ok":null}},"transport":"usb"}}"#
    ));
    lines.push(
        r#"{"at_ms":2101,"elapsed_ms":50,"event":"discover","outcome":{"ok":{"items":[],"transport":"usb"}},"transport":"usb"}"#.to_owned(),
    );
    lines.join("\n")
}

#[tokio::test(start_paused = true)]
async fn a_dead_usb_link_reconnects_when_the_cable_returns_in_the_shape_of_the_recording() {
    cable_pull(&synthetic_cable_pull()).await;
}

#[tokio::test(start_paused = true)]
async fn a_dead_usb_link_reconnects_when_the_cable_returns_on_the_recorded_pull() {
    let path = fixture("usb-cable-pull-aaa");
    let Ok(recording) = std::fs::read_to_string(&path) else {
        println!(
            "SKIPPED: {} is not recorded yet (it needs the owner to pull the cable); the \
             synthetic recording above stands in for it",
            path.display()
        );
        return;
    };
    cable_pull(&recording).await;
}
