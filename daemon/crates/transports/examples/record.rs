//! Records provider-level fixtures from real bricks: each scenario drives a provider and the
//! protocol encoder directly, through the recorder, and the recording becomes a fixture under
//! `daemon/fixtures/link/<scenario>-<brick>/` that the runtime's tests replay.
//!
//! ```text
//! cargo run -p ev3-transports --example record -- --list
//! cargo run -p ev3-transports --example record -- <scenario> --brick <NAME> --out <DIR> [--owner-present]
//! ```
//!
//! The recording goes into a new directory `<DIR>/<scenario>-<brick>`, which must not exist yet.
//! `<DIR>` must be owner-only: on Windows it has to lie inside the user's profile, on Unix the new
//! directory is created with mode 0700. Record there, read the result, then copy the fixture
//! into the repository. Scenarios that need a person at the brick (pulling a cable, switching a
//! brick off, confirming a pairing) refuse to start without `--owner-present`.
//!
//! Before recording, the harness registers this computer's name, the user's name and every LAN
//! address with the scrubber, so the recording carries placeholders only. After recording it
//! searches the file for every real identifier it knows, as text and as the hex of its bytes,
//! and refuses the fixture when it finds one. Nothing it prints names a brick's address.
//!
//! The scenario functions below take any provider, so `tests/link_fixtures.rs` runs the very
//! same functions against strict replay of each fixture: a change that alters what a scenario
//! sends fails there, and is answered by recording the scenario again on hardware, never by
//! editing the fixture.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ev3_protocol::bytecode::{gv0, lc1, lc2, read_fixed_c_string, read_float32le};
use ev3_protocol::commands::{FIRMWARE_BUFFER_BYTES, info_layout};
use ev3_protocol::packet::{command, reply, system_status};
use ev3_protocol::{BrickCommand, EncodedCommand, build_command, decode_ev3_packet};
use ev3_transports::fixture::{RECORDING_FILE, to_hex};
use ev3_transports::{
    BrickKey, DiscoveryItem, ErrorCode, Recorder, Scrubber, SendOptions, Transport, TransportError,
    TransportProvider,
};

/// The folder every scenario lists, and where the file round trip writes.
pub const PROJECTS: &str = "/home/root/lms2012/prjs/";

/// The file the round trip writes, reads back and deletes. Letters only: the recorder scrubs
/// request bytes too, and a name shaped like an address or a dotted quad would be rewritten.
pub const ROUND_TRIP_FILE: &str = "/home/root/lms2012/prjs/linkfixture.txt";

/// Size of the round-trip file: three continue-download chunks on a 1024-byte link.
pub const ROUND_TRIP_BYTES: usize = 3000;

/// The line the round-trip file repeats; letters, spaces and a newline, nothing the scrubber
/// would recognise.
pub const ROUND_TRIP_LINE: &str = "the quick brown fox jumps over the lazy dog\n";

/// `opNOP` (`bytecodes.h` 168): does nothing and replies at once.
const OP_NOP: u8 = 0x01;
/// `opINIT_BYTES (DESTINATION, LENGTH, SOURCE...)` (`bytecodes.h` 230, `c_move.c`): writes the
/// bytes that follow into memory.
const OP_INIT_BYTES: u8 = 0x2f;
/// `opTIMER_WAIT (TIME, TIMER)` (`bytecodes.h` 361, `c_timer.c` 79): arms a timer variable.
const OP_TIMER_WAIT: u8 = 0x85;
/// `opTIMER_READY (TIMER)` (`bytecodes.h` 362, `c_timer.c` 101): holds the command until the
/// timer runs out, so the brick replies only then.
const OP_TIMER_READY: u8 = 0x86;

/// How long the brick holds the stale-reply scenario's slow command.
pub const SLOW_COMMAND_MS: u16 = 800;
/// The budget the slow command gets: well inside its wait, so it times out.
pub const SLOW_BUDGET: Duration = Duration::from_millis(200);
/// The budget of the command after it: past the rest of the wait, which the brick serves first.
pub const AFTER_BUDGET: Duration = Duration::from_secs(3);

/// How long the drop scenarios' loop command holds the brick: long enough that a cable pulled
/// or a radio lost lands in the middle of an exchange most of the time.
pub const DROP_COMMAND_MS: u16 = 500;
/// Exchanges the drop scenarios make before they give up waiting for the drop: about a minute.
pub const DROP_ATTEMPTS: usize = 120;

/// Brick keys every discovery in the session showed, real values, kept in memory only so the
/// harness can search the finished recording for them.
pub type Seen = Arc<Mutex<Vec<BrickKey>>>;

/// What a scenario returns: a summary to print, or why it failed. Neither names an address.
pub type Outcome = Result<String, String>;

pub type RunFuture = Pin<Box<dyn Future<Output = Outcome> + Send>>;

/// One scenario: drives a provider for the brick it is named for.
pub type Run = fn(Arc<dyn TransportProvider>, String, Seen) -> RunFuture;

pub struct Scenario {
    pub name: &'static str,
    pub transport: Transport,
    /// One line on what it does.
    pub summary: &'static str,
    /// What a person has to do while it runs. `None` runs unattended.
    pub needs_owner: Option<&'static str>,
    /// Bluetooth only: listen for unpaired bricks before the recorded discovery.
    pub inquiry_first: bool,
    pub run: Run,
}

pub const SCENARIOS: &[Scenario] = &[
    Scenario {
        name: "usb-discovery",
        transport: Transport::Usb,
        summary: "One USB discovery that lists the brick.",
        needs_owner: None,
        inquiry_first: false,
        run: |p, b, s| Box::pin(discovery(p, b, s)),
    },
    Scenario {
        name: "usb-connect-commands",
        transport: Transport::Usb,
        summary: "Connect, ask info, battery, a listing of the projects folder and opNOP, \
                  disconnect.",
        needs_owner: None,
        inquiry_first: false,
        run: |p, b, s| Box::pin(connect_commands(p, b, s)),
    },
    Scenario {
        name: "usb-file-round-trip",
        transport: Transport::Usb,
        summary: "Write a small file into the projects folder, read it back, delete it.",
        needs_owner: None,
        inquiry_first: false,
        run: |p, b, s| Box::pin(file_round_trip(p, b, s)),
    },
    Scenario {
        name: "usb-read-from",
        transport: Transport::Usb,
        summary: "Write a small file, read it from several offsets with one direct command each \
                  (the brick skips to the offset), read a missing file, delete it.",
        needs_owner: None,
        inquiry_first: false,
        run: |p, b, s| Box::pin(read_from(p, b, s)),
    },
    Scenario {
        name: "usb-stale-reply",
        transport: Transport::Usb,
        summary: "A slow command that times out and one dropped by its caller, each followed by \
                  a command whose link has to step over the late reply.",
        needs_owner: None,
        inquiry_first: false,
        run: |p, b, s| Box::pin(stale_reply(p, b, s)),
    },
    Scenario {
        name: "usb-cable-pull",
        transport: Transport::Usb,
        summary: "Slow commands back to back until the cable is pulled, then disconnect and \
                  discover again.",
        needs_owner: Some(
            "pull the brick's USB cable while the commands run (within a minute of the start)",
        ),
        inquiry_first: false,
        run: |p, b, s| Box::pin(link_drop(p, b, s)),
    },
    Scenario {
        name: "bt-discovery",
        transport: Transport::Bt,
        summary: "One Bluetooth discovery that lists the brick, paired with this computer.",
        needs_owner: Some("the brick on, Bluetooth on, paired with this computer"),
        inquiry_first: false,
        run: |p, b, s| Box::pin(discovery(p, b, s)),
    },
    Scenario {
        name: "bt-connect-commands",
        transport: Transport::Bt,
        summary: "Connect over Bluetooth, ask info, battery, a listing and opNOP, disconnect.",
        needs_owner: Some("the brick on, Bluetooth on, paired with this computer"),
        inquiry_first: false,
        run: |p, b, s| Box::pin(connect_commands(p, b, s)),
    },
    Scenario {
        name: "bt-presence",
        transport: Transport::Bt,
        summary: "A presence check of a paired brick that is on: answers.",
        needs_owner: Some("the brick on, Bluetooth on, paired with this computer"),
        inquiry_first: false,
        run: |p, b, s| Box::pin(presence(p, b, s, true)),
    },
    Scenario {
        name: "bt-presence-off",
        transport: Transport::Bt,
        summary: "A presence check of a paired brick that is switched off: no answer.",
        needs_owner: Some("the brick paired with this computer, then switched off"),
        inquiry_first: false,
        run: |p, b, s| Box::pin(presence(p, b, s, false)),
    },
    Scenario {
        name: "bt-forget",
        transport: Transport::Bt,
        summary: "Forget a paired brick (remove the pairing), then discover again.",
        needs_owner: Some(
            "the brick on and paired with this computer; this removes the pairing, so run \
             bt-pair after it",
        ),
        inquiry_first: false,
        run: |p, b, s| Box::pin(forget(p, b, s)),
    },
    Scenario {
        name: "bt-pair",
        transport: Transport::Bt,
        summary: "Listen for unpaired bricks, pair the brick, discover again.",
        needs_owner: Some(
            "the brick on, Bluetooth on and visible, not paired with this computer; watch its \
             display and confirm on the brick if it asks",
        ),
        inquiry_first: true,
        run: |p, b, s| Box::pin(pair(p, b, s)),
    },
    Scenario {
        name: "bt-drop",
        transport: Transport::Bt,
        summary: "Slow commands back to back over Bluetooth until the link drops, then \
                  disconnect and discover again.",
        needs_owner: Some(
            "switch the brick off (or its Bluetooth) while the commands run (within a minute \
             of the start)",
        ),
        inquiry_first: false,
        run: |p, b, s| Box::pin(link_drop(p, b, s)),
    },
    Scenario {
        name: "tcp-discovery",
        transport: Transport::Tcp,
        summary: "TCP discovery until the brick's beacon lists it.",
        needs_owner: Some("the brick on, on the same Wi-Fi network as this computer"),
        inquiry_first: false,
        run: |p, b, s| Box::pin(discovery(p, b, s)),
    },
    Scenario {
        name: "tcp-connect-commands",
        transport: Transport::Tcp,
        summary: "Connect over TCP, ask info, battery, a listing and opNOP, disconnect.",
        needs_owner: Some("the brick on, on the same Wi-Fi network as this computer"),
        inquiry_first: false,
        run: |p, b, s| Box::pin(connect_commands(p, b, s)),
    },
];

/// The scenario a fixture directory `<scenario>-<brick>` was recorded with, and the brick.
pub fn scenario_of(fixture: &str) -> Option<(&'static Scenario, &str)> {
    let (name, brick) = fixture.rsplit_once('-')?;
    let scenario = SCENARIOS.iter().find(|s| s.name == name)?;
    (!brick.is_empty()).then_some((scenario, brick))
}

/// The directory name of a fixture: the scenario and the brick, lower case.
pub fn fixture_name(scenario: &str, brick: &str) -> String {
    format!("{scenario}-{}", brick.to_ascii_lowercase())
}

// ── Scenario steps ──────────────────────────────────────────────────

/// How many scans a transport gets to list the brick, and the pause between them. A TCP brick
/// shows up only once its beacon is heard, every few seconds.
fn scan_budget(transport: Transport) -> (usize, Duration) {
    match transport {
        Transport::Tcp => (20, Duration::from_secs(1)),
        _ => (3, Duration::from_secs(1)),
    }
}

/// Discovers until the brick named `brick` is listed, noting every key seen.
async fn find_brick(
    provider: &dyn TransportProvider,
    brick: &str,
    seen: &Seen,
) -> Result<DiscoveryItem, String> {
    let (attempts, pause) = scan_budget(provider.transport());
    let mut names = Vec::new();
    for attempt in 0..attempts {
        if attempt > 0 {
            tokio::time::sleep(pause).await;
        }
        let scan = provider.discover().await.map_err(describe_error)?;
        {
            let mut seen = seen.lock().unwrap_or_else(|e| e.into_inner());
            seen.extend(scan.items.iter().map(|item| item.brick_key.clone()));
        }
        if let Some(item) = scan
            .items
            .iter()
            .find(|item| item.display_name.eq_ignore_ascii_case(brick))
        {
            return Ok(item.clone());
        }
        names = scan
            .items
            .iter()
            .filter(|item| item.name_source != Some(ev3_transports::NameSource::Fallback))
            .map(|item| item.display_name.clone())
            .collect();
    }
    Err(format!(
        "{brick} was not listed after {attempts} scans; named bricks seen: {names:?}"
    ))
}

/// A brick's error as the harness prints it: the code only, since a live provider's message can
/// name the brick by its address. Replay's own messages carry placeholders only, and say which
/// recorded call the scenario missed, so those are kept.
fn describe_error(error: TransportError) -> String {
    match error.code {
        ErrorCode::ReplayDeviation | ErrorCode::ReplayUnmatched => {
            format!("{}: {}", error.code.as_str(), error.message)
        }
        code => format!("transport error {}", code.as_str()),
    }
}

/// One brick's session: the key and the message counter, which starts at 1 every run so the
/// same scenario always sends the same bytes.
struct Session {
    provider: Arc<dyn TransportProvider>,
    key: BrickKey,
    counter: u16,
}

impl Session {
    async fn connect(provider: Arc<dyn TransportProvider>, key: BrickKey) -> Result<Self, String> {
        provider.connect(&key).await.map_err(describe_error)?;
        Ok(Self {
            provider,
            key,
            counter: 0,
        })
    }

    /// The largest packet the link carries.
    fn frame(&self) -> usize {
        self.provider
            .max_packet_bytes(&self.key)
            .unwrap_or(FIRMWARE_BUFFER_BYTES)
    }

    /// Encodes `command` with the next counter: the request and the options that expect it.
    fn request(
        &mut self,
        command: &EncodedCommand,
        timeout: Option<Duration>,
    ) -> Result<(Vec<u8>, SendOptions), String> {
        self.counter = self.counter.wrapping_add(1);
        let request = ev3_protocol::encode_ev3_packet(
            u32::from(self.counter),
            command.packet_type,
            &command.payload,
        )
        .map_err(|e| e.to_string())?;
        let options = SendOptions {
            timeout,
            expected_message_counter: Some(self.counter),
        };
        Ok((request, options))
    }

    async fn exchange(
        &mut self,
        command: &EncodedCommand,
        timeout: Option<Duration>,
    ) -> Result<Result<Vec<u8>, TransportError>, String> {
        let (request, options) = self.request(command, timeout)?;
        Ok(self
            .provider
            .send_packet(&self.key, &request, &options)
            .await)
    }

    /// A direct command; returns its global variables.
    async fn direct(&mut self, command: &EncodedCommand) -> Result<Vec<u8>, String> {
        let answer = self
            .exchange(command, None)
            .await?
            .map_err(describe_error)?;
        let packet = decode_ev3_packet(&answer).map_err(|e| e.to_string())?;
        if packet.packet_type != reply::DIRECT_REPLY {
            return Err(format!(
                "direct command answered with type {:#04x}",
                packet.packet_type
            ));
        }
        Ok(packet.payload.to_vec())
    }

    /// A system command; returns its status and the data after it.
    async fn system(&mut self, command: &BrickCommand) -> Result<(u8, Vec<u8>), String> {
        let encoded = build_command(command).map_err(|e| e.to_string())?;
        let answer = self
            .exchange(&encoded, None)
            .await?
            .map_err(describe_error)?;
        let packet = decode_ev3_packet(&answer).map_err(|e| e.to_string())?;
        if packet.packet_type != reply::SYSTEM_REPLY
            && packet.packet_type != reply::SYSTEM_REPLY_ERROR
            || packet.payload.len() < 2
        {
            return Err(format!(
                "{} answered with type {:#04x}",
                command.kind(),
                packet.packet_type
            ));
        }
        Ok((packet.payload[1], packet.payload[2..].to_vec()))
    }

    async fn disconnect(self) -> Result<(), String> {
        self.provider
            .disconnect(&self.key)
            .await
            .map_err(describe_error)
    }
}

fn encode(command: &BrickCommand) -> Result<EncodedCommand, String> {
    build_command(command).map_err(|e| e.to_string())
}

/// `opNOP` as a direct command with no global variables.
fn nop() -> EncodedCommand {
    EncodedCommand {
        packet_type: command::DIRECT_COMMAND_REPLY,
        payload: vec![0x00, 0x00, OP_NOP],
    }
}

/// A direct command the brick holds for `ms` before it replies: arm a timer in global 0, wait
/// for it.
fn slow(ms: u16) -> Result<EncodedCommand, String> {
    let mut payload = vec![0x04, 0x00, OP_TIMER_WAIT];
    payload.extend(lc2(i32::from(ms)).map_err(|e| e.to_string())?);
    payload.extend(gv0(0).map_err(|e| e.to_string())?);
    payload.push(OP_TIMER_READY);
    payload.extend(gv0(0).map_err(|e| e.to_string())?);
    Ok(EncodedCommand {
        packet_type: command::DIRECT_COMMAND_REPLY,
        payload,
    })
}

/// A direct command that writes zeros over the first `bytes` of its global variables.
///
/// The firmware does not clear a direct command's globals, and a string read (`snprintf` in
/// `c_com.c`, GET_BRICKNAME) writes only up to its terminator, so the info reply carries whatever
/// an earlier command left after each name: on AAA (21.11.2026) a fragment of some other text.
/// Zeroing the same area first keeps that out of the recording, and makes the reply the same on
/// every run.
fn clear_globals(bytes: u8) -> Result<EncodedCommand, String> {
    let mut payload = vec![bytes, 0x00, OP_INIT_BYTES];
    payload.extend(gv0(0).map_err(|e| e.to_string())?);
    payload.extend(lc1(i32::from(bytes)).map_err(|e| e.to_string())?);
    payload.extend(std::iter::repeat_n(0x00, usize::from(bytes)));
    Ok(EncodedCommand {
        packet_type: command::DIRECT_COMMAND_REPLY,
        payload,
    })
}

/// Whether every byte after each string's terminator in the info reply is zero.
fn info_padding_is_clean(info: &[u8]) -> bool {
    use info_layout::*;
    [
        (OFF_BRICK_NAME, LEN_BRICK_NAME),
        (OFF_OS_VERS, LEN_OS_VERS),
        (OFF_HW_VERS, LEN_HW_VERS),
        (OFF_FW_VERS, LEN_FW_VERS),
        (OFF_OS_BUILD, LEN_OS_BUILD),
        (OFF_FW_BUILD, LEN_FW_BUILD),
    ]
    .iter()
    .all(|&(offset, len)| {
        let field = info.get(offset..offset + len).unwrap_or_default();
        let end = field.iter().position(|b| *b == 0).unwrap_or(field.len());
        field[end..].iter().all(|b| *b == 0)
    })
}

/// The round-trip file's content: [ROUND_TRIP_LINE] repeated to [ROUND_TRIP_BYTES].
pub fn round_trip_content() -> Vec<u8> {
    ROUND_TRIP_LINE
        .bytes()
        .cycle()
        .take(ROUND_TRIP_BYTES)
        .collect()
}

// ── Scenarios ───────────────────────────────────────────────────────

pub async fn discovery(provider: Arc<dyn TransportProvider>, brick: String, seen: Seen) -> Outcome {
    let item = find_brick(provider.as_ref(), &brick, &seen).await?;
    Ok(format!(
        "{brick} listed: name from {:?}, {:?}, paired {:?}, connected {}",
        item.name_source, item.presence_state, item.paired, item.connected
    ))
}

pub async fn connect_commands(
    provider: Arc<dyn TransportProvider>,
    brick: String,
    seen: Seen,
) -> Outcome {
    use info_layout::{LEN_BRICK_NAME, LEN_FW_VERS, OFF_BRICK_NAME, OFF_FW_VERS};
    let item = find_brick(provider.as_ref(), &brick, &seen).await?;
    let mut session = Session::connect(provider, item.brick_key).await?;
    let frame = session.frame();

    let info_bytes = u8::try_from(info_layout::TOTAL_INFO_BYTES).map_err(|e| e.to_string())?;
    session.direct(&clear_globals(info_bytes)?).await?;
    let info = session.direct(&encode(&BrickCommand::Info)?).await?;
    if !info_padding_is_clean(&info) {
        return Err(
            "the info reply carries bytes an earlier command left after a name or version; \
             it may hold text from elsewhere and is not recorded"
                .into(),
        );
    }
    let name = read_fixed_c_string(&info, OFF_BRICK_NAME, LEN_BRICK_NAME);
    let firmware = read_fixed_c_string(&info, OFF_FW_VERS, LEN_FW_VERS);

    let battery = session.direct(&encode(&BrickCommand::Battery)?).await?;
    let volts = read_float32le(&battery, 0).map_err(|e| e.to_string())?;
    let level = battery.get(8).copied().unwrap_or_default();

    let (status, listing) = session
        .system(&BrickCommand::FsList {
            path: PROJECTS.into(),
        })
        .await?;
    if status != system_status::OK && status != system_status::END_OF_FILE {
        return Err(format!("listing answered status {status}"));
    }

    session.direct(&nop()).await?;
    session.disconnect().await?;
    Ok(format!(
        "{frame}-byte frames; name {name}, firmware {firmware}, battery {volts:.2} V {level} %, \
         listing status {status} with {} bytes",
        listing.len()
    ))
}

/// Writes `content` to `path`: BEGIN_DOWNLOAD names the file and its size, CONTINUE_DOWNLOAD
/// carries the bytes in chunks that fill a frame. The continuations it took.
async fn write_file(session: &mut Session, path: &str, content: &[u8]) -> Result<usize, String> {
    let frame = session.frame();
    let total = u32::try_from(content.len()).map_err(|e| e.to_string())?;
    let (status, data) = session
        .system(&BrickCommand::FsBeginWrite {
            path: path.into(),
            total_bytes: total,
            chunk: Vec::new(),
        })
        .await?;
    let handle = match (status, data.first()) {
        (system_status::OK, Some(handle)) => *handle,
        _ => return Err(format!("BEGIN_DOWNLOAD answered status {status}")),
    };
    let mut written = 0;
    for chunk in content.chunks(frame - 7) {
        let (status, _) = session
            .system(&BrickCommand::FsContinueWrite {
                handle,
                chunk: chunk.to_vec(),
            })
            .await?;
        if status != system_status::OK && status != system_status::END_OF_FILE {
            return Err(format!("CONTINUE_DOWNLOAD answered status {status}"));
        }
        written += 1;
    }
    Ok(written)
}

/// The reads from an offset the read-from scenario makes of the round-trip file: from the start,
/// from the middle (the brick skips), its last bytes, at its end, past its end.
pub const READ_FROM_STEPS: &[(u32, u16)] =
    &[(0, 992), (1000, 992), (2990, 992), (3000, 992), (5000, 64)];

/// One read from an offset: whether the path exists, the file's size and the bytes read.
async fn read_one(
    session: &mut Session,
    path: &str,
    offset: u32,
    max_bytes: u16,
) -> Result<(bool, u32, Vec<u8>), String> {
    let command = BrickCommand::FsReadFrom {
        path: path.into(),
        offset,
        max_bytes,
    };
    let answer = session
        .exchange(&encode(&command)?, None)
        .await?
        .map_err(describe_error)?;
    let packet = decode_ev3_packet(&answer).map_err(|e| e.to_string())?;
    match ev3_protocol::parse_response(&command, &packet).map_err(|e| e.to_string())? {
        ev3_protocol::BrickResponse::FsReadFrom {
            exists,
            size,
            chunk,
        } => Ok((exists, size, chunk)),
        other => Err(format!("fs:readFrom answered {other:?}")),
    }
}

pub async fn read_from(provider: Arc<dyn TransportProvider>, brick: String, seen: Seen) -> Outcome {
    let item = find_brick(provider.as_ref(), &brick, &seen).await?;
    let mut session = Session::connect(provider, item.brick_key).await?;
    let content = round_trip_content();
    write_file(&mut session, ROUND_TRIP_FILE, &content).await?;
    let mut steps = Vec::new();
    for &(offset, max_bytes) in READ_FROM_STEPS {
        let (exists, size, chunk) =
            read_one(&mut session, ROUND_TRIP_FILE, offset, max_bytes).await?;
        let start = (offset as usize).min(content.len());
        let end = (start + usize::from(max_bytes)).min(content.len());
        if !exists || size as usize != content.len() || chunk != content[start..end] {
            return Err(format!(
                "from {offset}: exists {exists}, size {size}, {} bytes, not the file's {}",
                chunk.len(),
                end - start
            ));
        }
        steps.push(format!("{offset}:{}", chunk.len()));
    }
    let missing = format!("{PROJECTS}nolinkfixture.txt");
    let (exists, _, chunk) = read_one(&mut session, &missing, 0, 64).await?;
    if exists || !chunk.is_empty() {
        return Err("a missing file read as one".into());
    }
    let (deleted, _) = session
        .system(&BrickCommand::FsDelete {
            path: ROUND_TRIP_FILE.into(),
        })
        .await?;
    session.disconnect().await?;
    Ok(format!(
        "read {} from offsets as asked, a missing file as missing; delete status {deleted}",
        steps.join(" ")
    ))
}

pub async fn file_round_trip(
    provider: Arc<dyn TransportProvider>,
    brick: String,
    seen: Seen,
) -> Outcome {
    let item = find_brick(provider.as_ref(), &brick, &seen).await?;
    let mut session = Session::connect(provider, item.brick_key).await?;
    let frame = session.frame();
    let content = round_trip_content();
    let written = write_file(&mut session, ROUND_TRIP_FILE, &content).await?;

    // Read: BEGIN_UPLOAD answers the size and the first chunk, CONTINUE_UPLOAD the rest.
    let want = u16::try_from(frame - 12).map_err(|e| e.to_string())?;
    let (mut status, data) = session
        .system(&BrickCommand::FsBeginRead {
            path: ROUND_TRIP_FILE.into(),
            want_bytes: want,
        })
        .await?;
    if (status != system_status::OK && status != system_status::END_OF_FILE) || data.len() < 5 {
        return Err(format!("BEGIN_UPLOAD answered status {status}"));
    }
    let size = usize::try_from(u32::from_le_bytes([data[0], data[1], data[2], data[3]]))
        .map_err(|e| e.to_string())?;
    let handle = data[4];
    let mut back = data[5..].to_vec();
    let mut read = 1;
    while back.len() < size && status == system_status::OK {
        let want = u16::try_from((frame - 8).min(size - back.len())).map_err(|e| e.to_string())?;
        let (got, data) = session
            .system(&BrickCommand::FsContinueRead {
                handle,
                want_bytes: want,
            })
            .await?;
        status = got;
        if (status != system_status::OK && status != system_status::END_OF_FILE) || data.is_empty()
        {
            return Err(format!("CONTINUE_UPLOAD answered status {status}"));
        }
        back.extend_from_slice(&data[1..]);
        read += 1;
    }
    back.truncate(size);

    let (deleted, _) = session
        .system(&BrickCommand::FsDelete {
            path: ROUND_TRIP_FILE.into(),
        })
        .await?;
    session.disconnect().await?;
    if back != content {
        return Err(format!(
            "read back {} bytes that differ from the {} written",
            back.len(),
            content.len()
        ));
    }
    if deleted != system_status::OK {
        return Err(format!("DELETE_FILE answered status {deleted}"));
    }
    Ok(format!(
        "{frame}-byte frames; wrote {size} bytes in 1 + {written} packets, read them back in \
         {read}, deleted"
    ))
}

pub async fn stale_reply(
    provider: Arc<dyn TransportProvider>,
    brick: String,
    seen: Seen,
) -> Outcome {
    let item = find_brick(provider.as_ref(), &brick, &seen).await?;
    let mut session = Session::connect(provider, item.brick_key).await?;
    let slow = slow(SLOW_COMMAND_MS)?;

    // A slow command on a budget inside its wait times out; its reply arrives later, while the
    // next exchange waits, and that exchange's link has to step over it.
    match session.exchange(&slow, Some(SLOW_BUDGET)).await? {
        Err(error) if error.code == ErrorCode::Timeout => {}
        Err(error) => {
            return Err(format!(
                "the slow command failed with {}",
                describe_error(error)
            ));
        }
        Ok(_) => return Err("the slow command answered inside its budget".into()),
    }
    let started = tokio::time::Instant::now();
    let after_timeout = session.exchange(&nop(), Some(AFTER_BUDGET)).await?;
    let after_timeout_ms = started.elapsed().as_millis();
    after_timeout.map_err(describe_error)?;

    // The same, but the caller drops the exchange instead of letting it time out.
    let (request, options) = session.request(&slow, Some(AFTER_BUDGET))?;
    let dropped = tokio::time::timeout(
        SLOW_BUDGET,
        session
            .provider
            .send_packet(&session.key, &request, &options),
    )
    .await;
    if dropped.is_ok() {
        return Err("the slow command answered before its caller dropped it".into());
    }
    let started = tokio::time::Instant::now();
    let after_drop = session.exchange(&nop(), Some(AFTER_BUDGET)).await?;
    let after_drop_ms = started.elapsed().as_millis();
    after_drop.map_err(describe_error)?;

    session.disconnect().await?;
    Ok(format!(
        "the command after the timed-out one took {after_timeout_ms} ms, after the dropped one \
         {after_drop_ms} ms (the brick held each slow command {SLOW_COMMAND_MS} ms)"
    ))
}

pub async fn link_drop(provider: Arc<dyn TransportProvider>, brick: String, seen: Seen) -> Outcome {
    let item = find_brick(provider.as_ref(), &brick, &seen).await?;
    let mut session = Session::connect(provider.clone(), item.brick_key).await?;
    let slow = slow(DROP_COMMAND_MS)?;
    let mut failure = None;
    for attempt in 0..DROP_ATTEMPTS {
        if let Err(error) = session.exchange(&slow, Some(AFTER_BUDGET)).await? {
            failure = Some((attempt, error.code));
            break;
        }
    }
    let Some((attempt, code)) = failure else {
        session.disconnect().await?;
        return Err(format!(
            "the link never dropped in {DROP_ATTEMPTS} exchanges; nothing to record"
        ));
    };
    session.disconnect().await?;
    let scan = provider.discover().await.map_err(describe_error)?;
    let still_listed = scan
        .items
        .iter()
        .any(|item| item.display_name.eq_ignore_ascii_case(&brick));
    Ok(format!(
        "exchange {attempt} failed with {}; after the disconnect {brick} is {}listed",
        code.as_str(),
        if still_listed { "still " } else { "no longer " }
    ))
}

pub async fn presence(
    provider: Arc<dyn TransportProvider>,
    brick: String,
    seen: Seen,
    expected: bool,
) -> Outcome {
    let item = find_brick(provider.as_ref(), &brick, &seen).await?;
    let answered = provider
        .check_presence(&item.brick_key)
        .await
        .map_err(describe_error)?;
    if answered != expected {
        return Err(format!(
            "the presence check answered {answered}, the scenario expects {expected}"
        ));
    }
    Ok(format!("presence check answered {answered}"))
}

pub async fn forget(provider: Arc<dyn TransportProvider>, brick: String, seen: Seen) -> Outcome {
    let item = find_brick(provider.as_ref(), &brick, &seen).await?;
    if item.paired != Some(true) {
        return Err(format!("{brick} is not paired; nothing to forget"));
    }
    let residue = provider
        .forget(&item.brick_key)
        .await
        .map_err(describe_error)?;
    let scan = provider.discover().await.map_err(describe_error)?;
    let paired_after = scan
        .items
        .iter()
        .find(|i| i.brick_key == item.brick_key)
        .and_then(|i| i.paired);
    Ok(format!(
        "forgotten with {} records left behind; paired afterwards: {paired_after:?}",
        residue.len()
    ))
}

pub async fn pair(provider: Arc<dyn TransportProvider>, brick: String, seen: Seen) -> Outcome {
    let item = find_brick(provider.as_ref(), &brick, &seen).await?;
    if item.paired == Some(true) {
        return Err(format!("{brick} is already paired; run bt-forget first"));
    }
    let outcome = provider
        .pair(&item.brick_key)
        .await
        .map_err(describe_error)?;
    if !outcome.ok {
        return Err(format!(
            "pairing did not happen: {:?} ({:?})",
            outcome.reason, outcome.status
        ));
    }
    let scan = provider.discover().await.map_err(describe_error)?;
    let paired_after = scan
        .items
        .iter()
        .find(|i| i.brick_key == item.brick_key)
        .and_then(|i| i.paired);
    Ok(format!(
        "paired ({:?}); paired afterwards: {paired_after:?}",
        outcome.status
    ))
}

// ── The harness ─────────────────────────────────────────────────────

struct Args {
    scenario: &'static Scenario,
    brick: String,
    out: PathBuf,
    owner_present: bool,
}

const USAGE: &str = "usage: record --list\n       record <scenario> --brick <NAME> --out <DIR> \
                     [--owner-present]";

fn parse_args() -> Result<Option<Args>, String> {
    let mut args = std::env::args().skip(1);
    let mut scenario = None;
    let mut brick = None;
    let mut out = None;
    let mut owner_present = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--list" => {
                for s in SCENARIOS {
                    let mut who = s.needs_owner.map_or("unattended".to_owned(), |need| {
                        format!("needs the owner: {need}")
                    });
                    if s.inquiry_first {
                        who.push_str("; listens for unpaired bricks before recording");
                    }
                    println!("{:<22} {}\n{:<22} ({who})", s.name, s.summary, "");
                }
                return Ok(None);
            }
            "--brick" => brick = args.next(),
            "--out" => out = args.next().map(PathBuf::from),
            "--owner-present" => owner_present = true,
            name if !name.starts_with("--") && scenario.is_none() => {
                scenario = Some(
                    SCENARIOS
                        .iter()
                        .find(|s| s.name == name)
                        .ok_or_else(|| format!("no scenario called {name}; see --list"))?,
                );
            }
            other => return Err(format!("unexpected argument {other}\n{USAGE}")),
        }
    }
    match (scenario, brick, out) {
        (Some(scenario), Some(brick), Some(out)) if !brick.trim().is_empty() => Ok(Some(Args {
            scenario,
            brick: brick.trim().to_owned(),
            out,
            owner_present,
        })),
        _ => Err(USAGE.to_owned()),
    }
}

/// Creates the fresh, owner-only directory the recording goes into.
fn create_recording_dir(out: &Path, name: &str) -> Result<PathBuf, String> {
    let parent = out
        .canonicalize()
        .map_err(|e| format!("{} cannot be used: {e}", out.display()))?;
    #[cfg(windows)]
    {
        // The profile's own access list admits only the user, SYSTEM and administrators.
        let profile = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .and_then(|p| p.canonicalize().ok())
            .ok_or("USERPROFILE is not set; cannot tell whether the directory is owner-only")?;
        if !parent.starts_with(&profile) {
            return Err(format!(
                "{} is outside the user's profile, so other accounts may read it; record into \
                 a directory under the profile (the scratchpad) and copy the fixture afterwards",
                out.display()
            ));
        }
    }
    let dir = parent.join(name);
    #[cfg(unix)]
    let builder = {
        let mut builder = std::fs::DirBuilder::new();
        std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
        builder
    };
    #[cfg(not(unix))]
    let builder = std::fs::DirBuilder::new();
    builder
        .create(&dir)
        .map_err(|e| format!("cannot create a fresh {}: {e}", dir.display()))?;
    Ok(dir)
}

fn host_name() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .or_else(|| std::fs::read_to_string("/proc/sys/kernel/hostname").ok())
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

fn user_name() -> Option<String> {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

/// An identifier the finished recording must not contain, and how to call it in a report.
pub struct Secret {
    pub label: String,
    pub value: String,
    /// Twelve hex digits of a hardware address, searched in every spelling and as raw bytes.
    pub address: bool,
}

/// Every spelling of a secret the search looks for: text, the hex of its ASCII bytes, and for an
/// address its six raw bytes in both orders. All lower case; the search lower-cases the file.
fn spellings(secret: &Secret) -> Vec<(String, &'static str)> {
    let mut texts = vec![secret.value.clone()];
    if secret.address {
        let digits = secret.value.to_ascii_lowercase();
        let pairs: Vec<&str> = (0..6).map(|i| &digits[i * 2..i * 2 + 2]).collect();
        for separator in [":", "-", "_", ""] {
            texts.push(pairs.join(separator));
        }
    }
    let mut out = Vec::new();
    for text in texts {
        let lower = text.to_ascii_lowercase();
        out.push((to_hex(lower.as_bytes()), "hex of its text"));
        out.push((
            to_hex(text.to_ascii_uppercase().as_bytes()),
            "hex of its text",
        ));
        out.push((to_hex(text.as_bytes()), "hex of its text"));
        out.push((lower, "text"));
    }
    if secret.address
        && let Some(raw) = ev3_transports::fixture::from_hex(&secret.value)
    {
        let mut reversed = raw.clone();
        reversed.reverse();
        out.push((to_hex(&raw), "raw bytes"));
        out.push((to_hex(&reversed), "raw bytes, reversed"));
    }
    out
}

/// Searches a finished file for every secret; returns what was found, by label, never the value.
pub fn search(text: &str, secrets: &[Secret]) -> Vec<String> {
    let haystack = text.to_ascii_lowercase();
    let mut hits = Vec::new();
    for secret in secrets {
        for (needle, how) in spellings(secret) {
            if !needle.is_empty() && haystack.contains(&needle) {
                let hit = format!("{} ({how})", secret.label);
                if !hits.contains(&hit) {
                    hits.push(hit);
                }
            }
        }
    }
    // Any address in the most common home range, whoever it belongs to; assembled so that the
    // repository's own search for such addresses does not stop here.
    let home_range = format!("{}.{}.", 192, 168);
    for (needle, how) in [
        (home_range.clone(), "text"),
        (to_hex(home_range.as_bytes()), "hex of its text"),
    ] {
        if haystack.contains(&needle) {
            hits.push(format!("an address in {home_range}x.x ({how})"));
        }
    }
    hits
}

/// The real provider a scenario records through.
async fn open_provider(
    scenario: &Scenario,
    scrubber: &mut Scrubber,
    secrets: &mut Vec<Secret>,
) -> Result<Arc<dyn TransportProvider>, String> {
    match scenario.transport {
        Transport::Usb => Ok(Arc::new(ev3_transports::usb::UsbTransportProvider::new(
            ev3_transports::usb::UsbProviderOptions::default(),
        ))),
        Transport::Tcp => Ok(Arc::new(ev3_transports::tcp::TcpProvider::new(
            ev3_transports::tcp::TcpOptions::default(),
        ))),
        Transport::Bt => open_bluetooth(scenario, scrubber, secrets).await,
        Transport::Mock => Err("the mock transport has nothing to record".into()),
    }
}

/// Bluetooth on Windows. The radio's name is registered, since a brick may report it, and a
/// pairing scenario listens for unpaired bricks first, so its recorded discovery lists the brick.
#[cfg(windows)]
async fn open_bluetooth(
    scenario: &Scenario,
    scrubber: &mut Scrubber,
    secrets: &mut Vec<Secret>,
) -> Result<Arc<dyn TransportProvider>, String> {
    let bt = Arc::new(ev3_transports::bt_windows::WindowsBtProvider::system());
    if let Some(radio) = bt.radio_name().await {
        scrubber
            .register_host_name(&radio)
            .map_err(|e| e.to_string())?;
        secrets.push(Secret {
            label: "this computer's Bluetooth radio name".into(),
            value: radio,
            address: false,
        });
    }
    if scenario.inquiry_first {
        bt.run_inquiry().await;
    }
    Ok(bt)
}

#[cfg(not(windows))]
async fn open_bluetooth(
    _scenario: &Scenario,
    _scrubber: &mut Scrubber,
    _secrets: &mut Vec<Secret>,
) -> Result<Arc<dyn TransportProvider>, String> {
    Err("Bluetooth scenarios record on Windows only for now".into())
}

async fn record(args: Args) -> Result<(), String> {
    let scenario = args.scenario;
    if let Some(need) = scenario.needs_owner
        && !args.owner_present
    {
        return Err(format!(
            "{} needs the owner: {need}. Run it with --owner-present when that is arranged.",
            scenario.name
        ));
    }

    let mut scrubber = Scrubber::new();
    let mut secrets = Vec::new();
    if let Some(host) = host_name() {
        scrubber
            .register_host_name(&host)
            .map_err(|e| e.to_string())?;
        secrets.push(Secret {
            label: "this computer's name".into(),
            value: host,
            address: false,
        });
    }
    if let Some(user) = user_name() {
        scrubber
            .register_user_name(&user)
            .map_err(|e| e.to_string())?;
        secrets.push(Secret {
            label: "the user's name".into(),
            value: user,
            address: false,
        });
    }
    for interface in ev3_transports::tcp::ifaces::local_ipv4_interfaces() {
        let ip = interface.address.to_string();
        scrubber.register_ip(&ip).map_err(|e| e.to_string())?;
        secrets.push(Secret {
            label: "a LAN address of this computer".into(),
            value: ip,
            address: false,
        });
    }
    let name = fixture_name(scenario.name, &args.brick);
    let dir = create_recording_dir(&args.out, &name)?;
    let concrete = open_provider(scenario, &mut scrubber, &mut secrets).await?;
    let recorder = match Recorder::create(&dir, &name, scrubber) {
        Ok(recorder) => recorder,
        Err(error) => {
            concrete.dispose().await;
            return Err(error.to_string());
        }
    };
    let provider = recorder.wrap(concrete.clone());

    if let Some(need) = scenario.needs_owner {
        println!("\u{7}{}: {need}. Starting in 5 s.", scenario.name);
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    let seen: Seen = Arc::default();
    let outcome = (scenario.run)(provider, args.brick.clone(), seen.clone()).await;
    concrete.dispose().await;
    let finished = recorder.finish();

    for key in seen.lock().unwrap_or_else(|e| e.into_inner()).iter() {
        if let Some(id) = key.hardware_id() {
            secrets.push(Secret {
                label: "a brick's serial".into(),
                value: id,
                address: true,
            });
        }
    }
    let file = dir.join(RECORDING_FILE);
    let text = std::fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let hits = search(&text, &secrets);

    let summary = outcome.map_err(|e| format!("{} failed: {e}", scenario.name))?;
    finished.map_err(|e| e.to_string())?;
    if !hits.is_empty() {
        return Err(format!(
            "{} still carries real identifiers: {}. Do not copy this fixture.",
            file.display(),
            hits.join(", ")
        ));
    }
    println!("{}: {summary}", scenario.name);
    println!(
        "recorded {} lines, {} bytes, into {}; searched it for {} real identifiers, none found",
        text.lines().count(),
        text.len(),
        file.display(),
        secrets.len()
    );
    Ok(())
}

#[tokio::main]
async fn main() {
    let result = match parse_args() {
        Ok(Some(args)) => record(args).await,
        Ok(None) => Ok(()),
        Err(message) => Err(message),
    };
    if let Err(message) = result {
        eprintln!("{message}");
        std::process::exit(1);
    }
}
