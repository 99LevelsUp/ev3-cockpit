//! The brick runtime as the daemon builds it: the providers its channel and mode allow, the
//! sessions, discovery and the list of bricks, the brick layer with the one-sided check as its
//! Bluetooth gate, forget and clear, the transfer ledgers, and telemetry with its read model and
//! delivery.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ev3_runtime::{
    BrickManager, BrickOptions, CheckConfig, ConsentPort, DiscoveryConfig, DiscoveryScheduler,
    ForgetService, Guard, LedgerFile, Ledgers, OneSidedCheck, PresenceAggregator,
    ProgramPresetSettings, ProgramRows, SessionConfig, SessionManager, StaleSettings,
    TelemetryDelivery, TelemetryReadModel, TelemetryService, TelemetryServiceOptions, ThisComputer,
    ThrottleSettings, WallClock, follow_bricks,
};
use ev3_transports::{
    BrickKey, DiscoveryScanResult, ForgetResidue, PairingOutcome, ProbeLink, ProviderSource,
    Recorder, Replay, ReplayMode, Scrubber, SendOptions, SessionHandle, Transport,
    TransportCapabilities, TransportError, TransportProvider, fixture::RECORDING_FILE,
};
use tokio::sync::watch;
use tokio::task::AbortHandle;

use crate::settings::SettingsStore;
use crate::state::Shared;

use super::ports::{DaemonLog, ProviderRadioName};

/// How soon a provider that has not answered the first round is asked again.
const FIRST_ROUND_RETRY: Duration = Duration::from_millis(500);

/// The Bluetooth provider by its own type: what the provider trait does not carry (an inquiry
/// now, this computer's radio name, starting its background presence).
#[derive(Clone)]
pub enum Bluetooth {
    None,
    #[cfg(windows)]
    Windows(Arc<ev3_transports::bt_windows::WindowsBtProvider>),
    #[cfg(target_os = "linux")]
    Linux(Arc<ev3_transports::bt_linux::LinuxBtProvider>),
}

impl Bluetooth {
    /// The platform's Bluetooth provider; on Linux its group question goes through `questions`.
    #[allow(unused_variables)]
    pub fn system(shared: &Arc<Shared>, questions: &Arc<crate::questions::Questions>) -> Self {
        #[cfg(windows)]
        {
            Self::Windows(Arc::new(
                ev3_transports::bt_windows::WindowsBtProvider::system(),
            ))
        }
        #[cfg(target_os = "linux")]
        {
            Self::Linux(Arc::new(ev3_transports::bt_linux::LinuxBtProvider::system(
                Arc::new(super::ports::BluezActivity {
                    shared: shared.clone(),
                }),
                Some(Arc::new(super::ports::BluezConsent {
                    shared: shared.clone(),
                    questions: questions.clone(),
                })),
                None,
            )))
        }
        #[cfg(not(any(windows, target_os = "linux")))]
        {
            Self::None
        }
    }

    /// Looks for Bluetooth bricks now; nothing without a Bluetooth provider.
    pub async fn run_inquiry(&self) {
        match self {
            Self::None => {}
            #[cfg(windows)]
            Self::Windows(bt) => bt.run_inquiry().await,
            #[cfg(target_os = "linux")]
            Self::Linux(bt) => bt.run_inquiry().await,
        }
    }

    pub async fn radio_name(&self) -> Option<String> {
        match self {
            Self::None => None,
            #[cfg(windows)]
            Self::Windows(bt) => bt.radio_name().await,
            #[cfg(target_os = "linux")]
            Self::Linux(bt) => bt.radio_name(),
        }
    }

    fn start(&self) {
        match self {
            Self::None => {}
            #[cfg(windows)]
            Self::Windows(bt) => bt.start_presence(),
            #[cfg(target_os = "linux")]
            Self::Linux(bt) => {
                bt.start_bluez();
                bt.start_presence();
            }
        }
    }
}

/// The providers a daemon runs on.
pub struct Providers {
    pub list: Vec<Arc<dyn TransportProvider>>,
    pub bluetooth: Bluetooth,
    /// Whether they serve or make a recording. A recorded exchange answers once, so no heartbeat
    /// runs beside the scenario: one every few seconds would outrun a replay, and in a recording
    /// it would put exchanges between the scenario's that no replay makes in the same places.
    pub replay: bool,
}

/// A recording to make: the new owner-only directory it goes into, and the transports it uses
/// (`None` for every one the platform has).
pub struct RecordPlan {
    pub dir: PathBuf,
    pub transports: Option<Vec<Transport>>,
}

/// What the daemon checks as it ends, once the providers are let go.
pub enum ProviderEnd {
    Nothing,
    /// A recording, which must be complete and must not carry the identifiers registered for it.
    Recording(Recorder, Vec<Identifier>),
    /// A strict replay, which must have made every recorded call.
    StrictReplay(Arc<Replay>),
}

/// A real identifier a finished recording must not contain, and how to name it in a message
/// without its value.
pub struct Identifier {
    pub label: &'static str,
    pub value: String,
    /// Twelve hex digits of a hardware address: searched in every spelling and as raw bytes.
    pub address: bool,
}

/// Bytes as lower-case hex.
fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Every spelling of an identifier the search looks for, lower case: its text and the hex of its
/// text in either case, and for an address its pairs with each separator and its six raw bytes in
/// both orders. The hex of a text shorter than four characters is left out: four hex digits turn
/// up by chance in any recording of size.
fn spellings(identifier: &Identifier) -> Vec<String> {
    let mut texts = vec![identifier.value.clone()];
    let digits: String = identifier
        .value
        .chars()
        .filter(char::is_ascii_hexdigit)
        .collect::<String>()
        .to_ascii_lowercase();
    let address = identifier.address && digits.len() == 12;
    if address {
        let pairs: Vec<&str> = (0..6).map(|i| &digits[i * 2..i * 2 + 2]).collect();
        texts.extend([":", "-", "_", ""].map(|separator| pairs.join(separator)));
    }
    let mut out = Vec::new();
    for text in texts {
        if text.len() >= 4 {
            out.push(hex_of(text.to_ascii_lowercase().as_bytes()));
            out.push(hex_of(text.to_ascii_uppercase().as_bytes()));
        }
        out.push(text.to_ascii_lowercase());
    }
    if address {
        // The raw bytes in order are the bare digits, already above; reversed, as some stacks
        // store them.
        let reversed: String = (0..6).rev().map(|i| &digits[i * 2..i * 2 + 2]).collect();
        out.push(reversed);
    }
    out
}

/// The labels of the identifiers `text` still carries, and an address in the most common home
/// range whoever it belongs to; never a value.
fn identifiers_in(text: &str, identifiers: &[Identifier]) -> Vec<String> {
    let haystack = text.to_ascii_lowercase();
    let mut hits: Vec<String> = Vec::new();
    for identifier in identifiers {
        if spellings(identifier)
            .iter()
            .any(|needle| needle.len() > 1 && haystack.contains(needle.as_str()))
            && !hits.iter().any(|h| h == identifier.label)
        {
            hits.push(identifier.label.to_owned());
        }
    }
    // Assembled, so that the repository's own search for such addresses does not stop here.
    let home_range = format!("{}.{}.", 192, 168);
    if haystack.contains(&home_range) || haystack.contains(&hex_of(home_range.as_bytes())) {
        hits.push("an address in the home range".to_owned());
    }
    hits
}

impl ProviderEnd {
    /// A line for the log when all is well, or why the recording or the replay fell short.
    pub fn finish(&self) -> Result<Option<String>, String> {
        match self {
            Self::Nothing => Ok(None),
            Self::Recording(recorder, identifiers) => {
                recorder.finish().map_err(|error| error.to_string())?;
                let path = recorder.path();
                let text = std::fs::read_to_string(&path).map_err(|error| {
                    format!(
                        "The recording {} cannot be read back to search it: {error}",
                        path.display()
                    )
                })?;
                let hits = identifiers_in(&text, identifiers);
                if !hits.is_empty() {
                    return Err(format!(
                        "The recording {} still carries real identifiers ({}); do not copy it into the repository.",
                        path.display(),
                        hits.join(", ")
                    ));
                }
                Ok(Some(format!(
                    "The recording {} is complete; searched for {} identifiers registered for it, none found.",
                    path.display(),
                    identifiers.len()
                )))
            }
            Self::StrictReplay(replay) => replay
                .finish()
                .map(|()| Some("Strict replay: every recorded call was made.".to_string()))
                .map_err(|error| error.message),
        }
    }
}

/// This computer's name: what the system calls it, which BlueZ also gives its radio by default.
fn host_name() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::fs::read_to_string("/proc/sys/kernel/hostname").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

/// The user's account name, which home paths carry.
fn user_name() -> Option<String> {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
}

/// How long recording over Bluetooth waits for BlueZ to read its objects, the adapter among them.
#[cfg(target_os = "linux")]
const BLUEZ_READY_LIMIT: Duration = Duration::from_secs(10);

/// Registers what this computer's Bluetooth radio says about it: its name and, on Linux, the
/// adapter's address from BlueZ. A recording over Bluetooth whose adapter address cannot be read
/// is refused rather than made with the address in it.
async fn register_bluetooth(
    bluetooth: &Bluetooth,
    scrubber: &mut Scrubber,
    identifiers: &mut Vec<Identifier>,
) -> Result<(), String> {
    match bluetooth {
        Bluetooth::None => Ok(()),
        #[cfg(windows)]
        Bluetooth::Windows(bt) => {
            if let Some(radio) = bt.radio_name().await {
                scrubber
                    .register_host_name(&radio)
                    .map_err(|e| e.to_string())?;
                identifiers.push(Identifier {
                    label: "this computer's Bluetooth name",
                    value: radio,
                    address: false,
                });
            }
            Ok(())
        }
        #[cfg(target_os = "linux")]
        Bluetooth::Linux(bt) => {
            bt.start_bluez();
            let objects = bt.bluez().objects().clone();
            let deadline = tokio::time::Instant::now() + BLUEZ_READY_LIMIT;
            while !objects.is_ready() {
                if tokio::time::Instant::now() >= deadline {
                    return Err(
                        "BlueZ did not answer, so this computer's Bluetooth address cannot be kept out of the recording; record without Bluetooth (--transports usb,tcp) or try again."
                            .into(),
                    );
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if let Some(adapter) = objects.adapter() {
                if let Some(address) = adapter.address {
                    scrubber
                        .register_address(&address)
                        .map_err(|e| e.to_string())?;
                    identifiers.push(Identifier {
                        label: "this computer's Bluetooth address",
                        value: address,
                        address: true,
                    });
                }
                if let Some(alias) = adapter.alias.filter(|a| !a.is_empty()) {
                    scrubber
                        .register_host_name(&alias)
                        .map_err(|e| e.to_string())?;
                    identifiers.push(Identifier {
                        label: "this computer's Bluetooth name",
                        value: alias,
                        address: false,
                    });
                }
            }
            Ok(())
        }
    }
}

/// A strict replay whose calls on a timer, discovery and presence checks, are answered by a
/// matched replay instead: how many a daemon makes depends on how long it runs, not on the
/// scenario. Every other call goes to the strict replay, in its recorded order.
struct StrictCalls {
    calls: Arc<dyn TransportProvider>,
    timers: Arc<dyn TransportProvider>,
}

#[async_trait::async_trait]
impl TransportProvider for StrictCalls {
    fn transport(&self) -> Transport {
        self.calls.transport()
    }

    fn priority(&self) -> i32 {
        self.calls.priority()
    }

    fn capabilities(&self) -> TransportCapabilities {
        self.calls.capabilities()
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        self.timers.discover().await
    }

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.calls.connect(brick_key).await
    }

    async fn disconnect(&self, brick_key: &BrickKey) -> Result<(), TransportError> {
        self.calls.disconnect(brick_key).await
    }

    async fn send_packet(
        &self,
        brick_key: &BrickKey,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        self.calls.send_packet(brick_key, packet, options).await
    }

    fn max_packet_bytes(&self, brick_key: &BrickKey) -> Option<usize> {
        self.calls.max_packet_bytes(brick_key)
    }

    async fn open_probe(&self, brick_key: &BrickKey) -> Result<Box<dyn ProbeLink>, TransportError> {
        self.calls.open_probe(brick_key).await
    }

    async fn recover(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.calls.recover(brick_key).await
    }

    async fn forget(&self, brick_key: &BrickKey) -> Result<Vec<ForgetResidue>, TransportError> {
        self.calls.forget(brick_key).await
    }

    async fn pair(&self, brick_key: &BrickKey) -> Result<PairingOutcome, TransportError> {
        self.calls.pair(brick_key).await
    }

    async fn check_presence(&self, brick_key: &BrickKey) -> Result<bool, TransportError> {
        self.timers.check_presence(brick_key).await
    }
}

/// A recording's text split in two: the calls a strict replay serves, and the calls on a timer.
/// Each part keeps the header and the providers.
fn split_timer_calls(text: &str) -> (String, String) {
    let mut calls = String::new();
    let mut timers = String::new();
    for (index, line) in text.lines().filter(|l| !l.trim().is_empty()).enumerate() {
        let event = serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .and_then(|v| v.get("event").and_then(|e| e.as_str()).map(str::to_owned));
        let (to_calls, to_timers) = match event.as_deref() {
            _ if index == 0 => (true, true),
            Some("provider") => (true, true),
            Some("discover" | "presence") => (false, true),
            _ => (true, false),
        };
        for (wanted, part) in [(to_calls, &mut calls), (to_timers, &mut timers)] {
            if wanted {
                part.push_str(line);
                part.push('\n');
            }
        }
    }
    (calls, timers)
}

impl Providers {
    /// The real providers: USB, TCP, and Bluetooth where the platform has one.
    pub fn hardware(bluetooth: Bluetooth) -> Self {
        let mut list: Vec<Arc<dyn TransportProvider>> = vec![
            Arc::new(ev3_transports::usb::UsbTransportProvider::new(
                ev3_transports::usb::UsbProviderOptions::default(),
            )),
            Arc::new(ev3_transports::tcp::TcpProvider::new(
                ev3_transports::tcp::TcpOptions::default(),
            )),
        ];
        match &bluetooth {
            Bluetooth::None => {}
            #[cfg(windows)]
            Bluetooth::Windows(bt) => list.push(bt.clone()),
            #[cfg(target_os = "linux")]
            Bluetooth::Linux(bt) => list.push(bt.clone()),
        }
        Self {
            list,
            bluetooth,
            replay: false,
        }
    }

    /// The providers of the recording in `dir`; none without a directory.
    pub fn replay(dir: Option<&Path>) -> Result<Self, String> {
        let list = match dir {
            None => Vec::new(),
            Some(dir) => {
                let file = dir.join(RECORDING_FILE);
                Replay::load(&file, ReplayMode::Matched)
                    .map_err(|error| {
                        format!(
                            "The recording {} cannot be replayed: {error}",
                            file.display()
                        )
                    })?
                    .providers()
            }
        };
        Ok(Self {
            list,
            bluetooth: Bluetooth::None,
            replay: true,
        })
    }

    /// The providers of the recording in `dir` in strict replay, with discovery and presence
    /// checks answered matched, and the replay to check at the end.
    pub fn strict_replay(dir: &Path) -> Result<(Self, Arc<Replay>), String> {
        let file = dir.join(RECORDING_FILE);
        let cannot = |error: &dyn std::fmt::Display| {
            format!(
                "The recording {} cannot be replayed: {error}",
                file.display()
            )
        };
        let text = std::fs::read_to_string(&file).map_err(|e| cannot(&e))?;
        let (calls, timers) = split_timer_calls(&text);
        let strict =
            Arc::new(Replay::from_text(&calls, ReplayMode::Strict).map_err(|e| cannot(&e))?);
        let timers = Replay::from_text(&timers, ReplayMode::Matched).map_err(|e| cannot(&e))?;
        let list = strict
            .providers()
            .into_iter()
            .filter_map(|calls| {
                let timers = timers.provider(calls.transport())?;
                Some(Arc::new(StrictCalls { calls, timers }) as Arc<dyn TransportProvider>)
            })
            .collect();
        Ok((
            Self {
                list,
                bluetooth: Bluetooth::None,
                replay: true,
            },
            strict,
        ))
    }

    /// The real providers `plan` names, each wrapped by a recorder writing into its directory,
    /// which must exist, new and the user's alone. This computer's name, the user's, its LAN
    /// addresses and its Bluetooth adapter's are registered before anything is recorded; brick
    /// addresses the recorder learns from the session itself.
    pub async fn recording(
        plan: &RecordPlan,
        bluetooth: impl FnOnce() -> Bluetooth,
    ) -> Result<(Self, Recorder, Vec<Identifier>), String> {
        let wanted = |t: Transport| plan.transports.as_ref().is_none_or(|l| l.contains(&t));
        let mut scrubber = Scrubber::new();
        let mut identifiers = Vec::new();
        let register = |result: Result<(), ev3_transports::ScrubError>| {
            result.map_err(|error| format!("The recording cannot start: {error}"))
        };
        if let Some(host) = host_name() {
            register(scrubber.register_host_name(&host))?;
            identifiers.push(Identifier {
                label: "this computer's name",
                value: host,
                address: false,
            });
        }
        if let Some(user) = user_name() {
            register(scrubber.register_user_name(&user))?;
            identifiers.push(Identifier {
                label: "the user's name",
                value: user,
                address: false,
            });
        }
        for interface in ev3_transports::tcp::ifaces::local_ipv4_interfaces() {
            let ip = interface.address.to_string();
            register(scrubber.register_ip(&ip))?;
            identifiers.push(Identifier {
                label: "a LAN address of this computer",
                value: ip,
                address: false,
            });
        }
        let bluetooth = if wanted(Transport::Bt) {
            bluetooth()
        } else {
            Bluetooth::None
        };
        register_bluetooth(&bluetooth, &mut scrubber, &mut identifiers).await?;

        let mut list: Vec<Arc<dyn TransportProvider>> = Vec::new();
        if wanted(Transport::Usb) {
            list.push(Arc::new(ev3_transports::usb::UsbTransportProvider::new(
                ev3_transports::usb::UsbProviderOptions::default(),
            )));
        }
        if wanted(Transport::Tcp) {
            list.push(Arc::new(ev3_transports::tcp::TcpProvider::new(
                ev3_transports::tcp::TcpOptions::default(),
            )));
        }
        match &bluetooth {
            Bluetooth::None => {}
            #[cfg(windows)]
            Bluetooth::Windows(bt) => list.push(bt.clone()),
            #[cfg(target_os = "linux")]
            Bluetooth::Linux(bt) => list.push(bt.clone()),
        }
        let scenario = plan
            .dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let recorder = Recorder::create(&plan.dir, &scenario, scrubber).map_err(|error| {
            format!(
                "The recording cannot be written into {}: {error}",
                plan.dir.display()
            )
        })?;
        let list = list.into_iter().map(|p| recorder.wrap(p)).collect();
        Ok((
            Self {
                list,
                bluetooth,
                replay: true,
            },
            recorder,
            identifiers,
        ))
    }

    /// The providers `source` allows, and what to check of them at the end. Replay serves the
    /// recording in `fixtures`, strictly when `strict`; recording follows `record`.
    pub async fn for_source(
        source: ProviderSource,
        fixtures: Option<&Path>,
        strict: bool,
        record: Option<&RecordPlan>,
        bluetooth: impl FnOnce() -> Bluetooth,
    ) -> Result<(Self, ProviderEnd), String> {
        match (source, fixtures, record) {
            (ProviderSource::Replay, Some(dir), _) if strict => {
                let (providers, replay) = Self::strict_replay(dir)?;
                Ok((providers, ProviderEnd::StrictReplay(replay)))
            }
            (ProviderSource::Replay, fixtures, _) => {
                Ok((Self::replay(fixtures)?, ProviderEnd::Nothing))
            }
            (ProviderSource::Hardware { record: false }, _, _) => {
                Ok((Self::hardware(bluetooth()), ProviderEnd::Nothing))
            }
            (ProviderSource::Hardware { record: true }, _, Some(plan)) => {
                let (providers, recorder, identifiers) = Self::recording(plan, bluetooth).await?;
                Ok((providers, ProviderEnd::Recording(recorder, identifiers)))
            }
            (ProviderSource::Hardware { record: true }, _, None) => {
                Err("Recording needs a directory to record into (--record-dir).".into())
            }
        }
    }
}

/// Everything the surface calls.
pub struct Runtime {
    pub sessions: SessionManager,
    pub scheduler: Arc<DiscoveryScheduler>,
    pub list: Arc<PresenceAggregator>,
    pub bricks: BrickManager,
    pub check: OneSidedCheck,
    pub forget: ForgetService,
    pub ledgers: Ledgers,
    pub telemetry: TelemetryService,
    pub read_model: TelemetryReadModel,
    pub delivery: TelemetryDelivery,
    pub program_rows: ProgramRows,
    pub bluetooth: Bluetooth,
    /// True once the first discovery round has finished.
    pub discovered: watch::Receiver<bool>,
    tasks: Vec<AbortHandle>,
}

/// The ledger at `file`; a damaged one is moved aside, said in the log, and replaced by an empty
/// one, so the daemon starts.
fn open_ledger(file: &Path, shared: &Shared) -> Option<Arc<LedgerFile>> {
    match LedgerFile::open(file) {
        Ok(ledger) => Some(Arc::new(ledger)),
        Err(error) => {
            let aside = PathBuf::from(format!(
                "{}.damaged-{}",
                file.display(),
                shared.identity.started_at
            ));
            let moved = std::fs::rename(file, &aside);
            shared.log.warn(&format!(
                "The transfer ledger {} could not be read ({}); {}. Transfers cut off before this \
                 start are not swept.",
                file.display(),
                error.message,
                match &moved {
                    Ok(()) => format!("it was moved to {}", aside.display()),
                    Err(e) => format!("it could not be moved aside ({e})"),
                }
            ));
            match moved {
                Ok(()) => LedgerFile::open(file).ok().map(Arc::new),
                Err(_) => None,
            }
        }
    }
}

/// The packet a transfer uses over TCP and Bluetooth, from the settings.
fn packet_bytes(settings: &SettingsStore, transport: Transport) -> Option<usize> {
    let key = match transport {
        Transport::Tcp => "transfer.tcpPacketBytes",
        Transport::Bt => "transfer.btPacketBytes",
        _ => return None,
    };
    settings
        .number(key)
        .filter(|n| n.is_finite() && *n >= 1.0)
        .map(|n| n as usize)
}

pub fn stale_settings(settings: &SettingsStore) -> StaleSettings {
    let default = StaleSettings::default();
    StaleSettings {
        stale_factor: settings
            .number("telemetry.staleFactor")
            .unwrap_or(default.stale_factor),
        stale_timeout_ms: settings
            .number("telemetry.staleTimeoutMs")
            .unwrap_or(default.stale_timeout_ms),
    }
}

pub fn throttle_settings(settings: &SettingsStore) -> ThrottleSettings {
    let default = ThrottleSettings::default();
    let whole =
        |key: &str, fallback: u32| settings.number(key).map(|n| n as u32).unwrap_or(fallback);
    ThrottleSettings {
        enabled: settings
            .flag("telemetry.throttle.enabled")
            .unwrap_or(default.enabled),
        window_size: whole("telemetry.throttle.windowSize", default.window_size),
        tail_factor: settings
            .number("telemetry.throttle.tailFactor")
            .unwrap_or(default.tail_factor),
        step: settings
            .number("telemetry.throttle.step")
            .unwrap_or(default.step),
        max_slowdown: settings
            .number("telemetry.throttle.maxSlowdown")
            .unwrap_or(default.max_slowdown),
        calm_windows: whole("telemetry.throttle.calmWindows", default.calm_windows),
    }
}

pub fn program_preset(settings: &SettingsStore) -> ProgramPresetSettings {
    ProgramPresetSettings {
        program_running_tick_ms: settings
            .number("telemetry.programRunningTickMs")
            .unwrap_or_else(|| ProgramPresetSettings::default().program_running_tick_ms),
    }
}

impl Runtime {
    /// Builds and starts the runtime on `providers`. Call it inside the daemon's tokio runtime.
    pub fn start(
        providers: Providers,
        shared: &Arc<Shared>,
        consent: Arc<dyn ConsentPort>,
        ledger_file: &Path,
    ) -> Result<Self, String> {
        let log: Arc<dyn ev3_runtime::BrickLog> = Arc::new(DaemonLog {
            shared: shared.clone(),
        });
        let session_config = if providers.replay {
            // A recording answers each recorded exchange once; a heartbeat every few seconds
            // would outrun any recording and drop the brick.
            SessionConfig {
                heartbeat_interval: Duration::from_secs(24 * 3600),
                ..SessionConfig::default()
            }
        } else {
            SessionConfig::default()
        };
        let sessions = SessionManager::new(
            providers.list.clone(),
            Arc::new(Guard::default()),
            session_config,
        );
        let scheduler = DiscoveryScheduler::new(providers.list.clone(), DiscoveryConfig::default());
        let list = PresenceAggregator::new(scheduler.clone());

        let computer = ThisComputer::new(
            Arc::new(ProviderRadioName {
                bluetooth: providers.bluetooth.clone(),
            }),
            Some(log.clone()),
        );
        let check = OneSidedCheck::new(computer.clone(), Some(log.clone()), CheckConfig::default());
        let settings_for_packets = shared.clone();
        let bricks = BrickManager::new(
            sessions.clone(),
            list.clone(),
            BrickOptions {
                log: Some(log.clone()),
                bluetooth_gate: Some(check.gate()),
                transfer_packet_bytes: Some(Arc::new(move |transport| {
                    packet_bytes(
                        &settings_for_packets.settings.lock().expect("settings lock"),
                        transport,
                    )
                })),
                ..BrickOptions::default()
            },
        );
        check.attach(&bricks);
        let forget = ForgetService::new(
            bricks.clone(),
            consent.clone(),
            computer,
            Some(check.clone()),
        );
        let ledgers = Ledgers::new(consent, open_ledger(ledger_file, shared));

        let (stale, throttle, preset) = {
            let settings = shared.settings.lock().expect("settings lock");
            (
                stale_settings(&settings),
                throttle_settings(&settings),
                program_preset(&settings),
            )
        };
        let telemetry = TelemetryService::new(
            Arc::new(bricks.clone()),
            TelemetryServiceOptions {
                throttle: Some(throttle),
                program_preset: Some(preset),
                ..TelemetryServiceOptions::default()
            },
        )
        .map_err(|e| format!("Telemetry could not start: {e}"))?;
        // Every client says which bricks it shows; none until one does. A connect from the CLI or
        // MCP therefore starts no telemetry (DESIGN 3.2): those clients read it only through their
        // own subscriptions. The strict service replays fail when a connect reads telemetry.
        telemetry.set_foreground_bricks(Some(Default::default()));
        let mut tasks = vec![follow_bricks(&telemetry, &bricks)];
        let read_model = TelemetryReadModel::new(stale, WallClock::system())
            .map_err(|e| format!("Telemetry could not start: {e}"))?;
        read_model.follow(&telemetry);
        read_model.start_timer();
        let warn_shared = shared.clone();
        let delivery = TelemetryDelivery::new(Arc::new(move |message: &str| {
            warn_shared.log.warn(message);
        }));
        delivery.follow(&read_model, &telemetry);
        let program_rows = ProgramRows::over_telemetry(telemetry.clone(), read_model.clone());

        // Bluetooth starts first: its first scan has nothing to read until it is up.
        providers.bluetooth.start();
        // The first round ends when every provider has answered a scan, or after the wait a
        // caller gives it: a provider that was not ready (BlueZ still opening) is asked again.
        let (discovered_tx, discovered) = watch::channel(false);
        let first = scheduler.clone();
        let transports: Vec<Transport> = providers.list.iter().map(|p| p.transport()).collect();
        tasks.push(
            tokio::spawn(async move {
                let end = tokio::time::Instant::now() + super::DISCOVERY_WAIT;
                loop {
                    first.scan_once().await;
                    if transports.iter().all(|t| first.has_scanned(*t))
                        || tokio::time::Instant::now() >= end
                    {
                        break;
                    }
                    tokio::time::sleep(FIRST_ROUND_RETRY).await;
                }
                let _ = discovered_tx.send(true);
                first.start();
            })
            .abort_handle(),
        );

        Ok(Self {
            sessions,
            scheduler,
            list,
            bricks,
            check,
            forget,
            ledgers,
            telemetry,
            read_model,
            delivery,
            program_rows,
            bluetooth: providers.bluetooth,
            discovered,
            tasks,
        })
    }

    /// Settles once the first discovery round is over, or after `limit`.
    pub async fn discovery_settled(&self, limit: Duration) {
        let mut discovered = self.discovered.clone();
        let _ = tokio::time::timeout(limit, discovered.wait_for(|done| *done)).await;
    }

    /// Releases every brick and device: signs every brick out, stops discovery and telemetry, and
    /// lets each provider go.
    pub async fn shutdown(&self) {
        for task in &self.tasks {
            task.abort();
        }
        self.scheduler.stop();
        for brick in self.bricks.signed_in_bricks() {
            self.bricks.sign_out(&brick).await;
        }
        self.delivery.dispose();
        self.telemetry.dispose();
        self.read_model.dispose();
        self.check.detach();
        self.bricks.dispose();
        self.sessions.shutdown();
        self.scheduler.dispose();
        for transport in [
            Transport::Usb,
            Transport::Bt,
            Transport::Tcp,
            Transport::Mock,
        ] {
            if let Some(provider) = self.scheduler.provider(transport) {
                provider.dispose().await;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identifier(label: &'static str, value: &str, address: bool) -> Identifier {
        Identifier {
            label,
            value: value.to_owned(),
            address,
        }
    }

    #[test]
    fn a_finished_recording_is_searched_for_every_spelling_of_what_was_registered() {
        let ids = [
            identifier("the host", "Workbench-7", false),
            identifier("the adapter", "A1:B2:C3:D4:E5:F6", true),
        ];
        let hex = |s: &str| s.bytes().map(|b| format!("{b:02x}")).collect::<String>();
        for (text, wanted) in [
            ("{\"name\":\"workbench-7\"}".to_owned(), "the host"),
            (
                format!("{{\"reply_hex\":\"00{}00\"}}", hex("WORKBENCH-7")),
                "the host",
            ),
            (
                "{\"key\":\"bt:a1-b2-c3-d4-e5-f6\"}".to_owned(),
                "the adapter",
            ),
            (
                "{\"reply_hex\":\"00f6e5d4c3b2a100\"}".to_owned(),
                "the adapter",
            ),
            ("{\"serial\":\"A1B2C3D4E5F6\"}".to_owned(), "the adapter"),
        ] {
            assert_eq!(identifiers_in(&text, &ids), [wanted], "{text}");
        }
        let home = format!("{}.{}.1.20", 192, 168);
        assert_eq!(
            identifiers_in(&format!("{{\"ip\":\"{home}\"}}"), &ids),
            ["an address in the home range"]
        );
        let placeholders =
            "{\"key\":\"usb:001653F00A0A\",\"name\":\"HOSTAAAAAAA\",\"ip\":\"192.0.2.7\"}";
        assert!(identifiers_in(placeholders, &ids).is_empty());
    }

    #[test]
    fn the_hex_of_a_short_name_is_not_searched_but_its_text_is() {
        let ids = [identifier("the user", "bob", false)];
        // 62 6f 62 by chance inside link bytes: no finding.
        assert!(identifiers_in("{\"reply_hex\":\"00626f6200\"}", &ids).is_empty());
        assert_eq!(
            identifiers_in("{\"path\":\"/home/bob/x\"}", &ids),
            ["the user"]
        );
    }
}
