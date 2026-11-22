//! The program service and the shell over the real brick layer: sessions, the session's codec and
//! the brick manager, above a fake provider whose brick keeps the user slot as the firmware does.
//! What the fakes of the other program tests cannot show: that a start goes out encoded and comes
//! back parsed, and that the brick layer's own failures are told apart the way a start needs, a
//! lost reply as uncertain and a refusal before sending as a failure.

mod support;
mod support_programs;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use ev3_contract::StartOutcome;
use ev3_protocol::packet::{program_status, reply};
use ev3_protocol::{BrickCommand, build_command, encode_ev3_packet};
use ev3_runtime::bricks::{BrickManager, BrickOptions};
use ev3_runtime::fs::may_have_run;
use ev3_runtime::programs::{BrickProgramLink, ProgramError, ProgramService, StartOptions};
use ev3_runtime::shell::run_shell;
use ev3_runtime::{
    ConnectionState, DiscoveryConfig, DiscoveryScheduler, Guard, PresenceAggregator, SessionConfig,
    SessionManager,
};
use ev3_transports::{
    BrickKey, DiscoveryScanResult, NameSource, ProbeLink, SendOptions, SessionHandle, Transport,
    TransportCapabilities, TransportError, TransportProvider,
};
use support::{FakeProvider, settle, sighting, usb_key};
use support_programs::{PRG, quick, vscode};

const AAA: &str = "00165300000A";

#[derive(Default)]
struct Slot {
    running: bool,
    /// The program commands that reached the brick, by kind.
    log: Vec<String>,
    /// The start runs, and its reply is lost.
    lose_start: bool,
}

/// The shared fake for links and discovery; the program commands answered as the firmware does.
struct ProgramBrick {
    inner: Arc<FakeProvider>,
    slot: Arc<Mutex<Slot>>,
}

fn is(body: &[u8], command: &BrickCommand) -> bool {
    let encoded = build_command(command).unwrap();
    body[0] == encoded.packet_type && body[1..] == encoded.payload[..]
}

#[async_trait]
impl TransportProvider for ProgramBrick {
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

    async fn send_packet(
        &self,
        brick_key: &BrickKey,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        // The shared fake decides whether the link carries the packet, and sizes the globals.
        let answered = self.inner.send_packet(brick_key, packet, options).await?;
        let body = &packet[4..];
        let mut slot = self.slot.lock().unwrap();
        let run = BrickCommand::ProgramRun { path: PRG.into() };
        let mut globals = answered[5..].to_vec();
        let kind = if is(body, &run) {
            if !slot.running {
                slot.running = true;
                globals[..4].copy_from_slice(&14i32.to_le_bytes());
            }
            "program:run"
        } else if is(body, &BrickCommand::ProgramStatus) {
            globals[0] = if slot.running {
                program_status::RUNNING
            } else {
                program_status::STOPPED
            };
            "program:status"
        } else if is(body, &BrickCommand::ProgramStop) {
            slot.running = false;
            "program:stop"
        } else if is(body, &BrickCommand::ProgramEmergencyStop) {
            slot.running = false;
            "program:emergencyStop"
        } else {
            return Ok(answered);
        };
        slot.log.push(kind.into());
        if kind == "program:run" && slot.lose_start {
            return Err(TransportError::timeout(
                "USB send timed out with no matching reply.",
            ));
        }
        let counter = u32::from(u16::from_le_bytes([packet[2], packet[3]]));
        Ok(encode_ev3_packet(counter, reply::DIRECT_REPLY, &globals).unwrap())
    }
}

struct World {
    usb: Arc<FakeProvider>,
    slot: Arc<Mutex<Slot>>,
    sessions: SessionManager,
    bricks: BrickManager,
    programs: ProgramService,
}

impl World {
    fn log(&self) -> Vec<String> {
        self.slot.lock().unwrap().log.clone()
    }
}

/// AAA signed in over USB.
async fn world() -> World {
    let usb = FakeProvider::new(Transport::Usb);
    usb.state().seen = vec![sighting(&usb_key(), "AAA", Some(NameSource::UsbDescriptor))];
    let slot = Arc::new(Mutex::new(Slot::default()));
    let providers: [Arc<dyn TransportProvider>; 1] = [Arc::new(ProgramBrick {
        inner: usb.clone(),
        slot: slot.clone(),
    })];
    let scheduler = DiscoveryScheduler::new(providers.clone(), DiscoveryConfig::default());
    let list = PresenceAggregator::new(scheduler.clone());
    let sessions = SessionManager::new(
        providers,
        Arc::new(Guard::default()),
        SessionConfig {
            heartbeat_interval: Duration::from_secs(3600),
            ..SessionConfig::default()
        },
    );
    let bricks = BrickManager::new(sessions.clone(), list, BrickOptions::default());
    scheduler.scan_once().await;
    settle().await;
    bricks.sign_in(AAA).await.unwrap();
    settle().await;
    let programs = ProgramService::new(
        Arc::new(BrickProgramLink::new(bricks.clone(), AAA)),
        quick(),
        None,
        None,
    );
    World {
        usb,
        slot,
        sessions,
        bricks,
        programs,
    }
}

#[tokio::test]
async fn starts_and_stops_a_program_through_the_session_codec() {
    let w = world().await;

    let outcome = w
        .programs
        .start(PRG, &vscode(), StartOptions::default())
        .await;
    assert_eq!(outcome, Ok(StartOutcome::Started));
    w.programs.emergency_stop(&vscode()).await.unwrap();

    assert_eq!(w.programs.is_running().await, Ok(false));
    assert_eq!(
        w.log(),
        [
            "program:status",
            "program:run",
            "program:status",
            "program:emergencyStop",
            "program:status",
            "program:status",
        ]
    );
}

#[tokio::test]
async fn says_uncertain_when_the_links_timeout_takes_the_starts_reply() {
    let w = world().await;
    w.slot.lock().unwrap().lose_start = true;

    let outcome = w
        .programs
        .start(PRG, &vscode(), StartOptions::default())
        .await;

    assert_eq!(outcome, Ok(StartOutcome::Uncertain));
    assert_eq!(
        w.log().iter().filter(|k| *k == "program:run").count(),
        1,
        "the start was sent again"
    );
}

#[tokio::test]
async fn fails_a_start_the_brick_layer_refused_to_send_and_sends_nothing() {
    let w = world().await;
    w.usb.pull_cable();
    w.sessions.probe_now(&usb_key()).await;
    for _ in 0..200 {
        let state = w.sessions.session(&usb_key()).map(|s| s.connection_state);
        if state != Some(ConnectionState::Connected) {
            break;
        }
        settle().await;
    }
    w.slot.lock().unwrap().log.clear();

    let error = w
        .programs
        .start(PRG, &vscode(), StartOptions::default())
        .await
        .unwrap_err();

    let ProgramError::Command(error) = error else {
        panic!("not a refusal of the brick layer: {error:?}");
    };
    assert!(
        !may_have_run(&error),
        "a refusal before sending read as maybe run: {error:?}"
    );
    assert!(
        w.log().is_empty(),
        "something reached the brick: {:?}",
        w.log()
    );
    assert!(w.bricks.is_signed_in(AAA));
}

#[tokio::test]
async fn runs_a_shell_command_through_the_session_codec() {
    let w = world().await;
    let link = BrickProgramLink::new(w.bricks.clone(), AAA);

    let status = run_shell(&link, "chmod +x /home/root/lms2012/prjs/Demo/prog", None).await;

    assert_eq!(status, Ok(0));
}
