//! Pairing a brick through BlueZ, with an agent the cockpit owns.
//!
//! Measured: an agent registered by the calling connection, without `RequestDefaultAgent`, is
//! the one BlueZ asks, even with the desktop panel's own agent running, so the desktop's agent is
//! never displaced. The brick shows a connection request, then a PIN keyboard; BlueZ asks our
//! agent `RequestPinCode` and gets 1234. BlueZ itself ends an unanswered brick dialog after 60 s
//! with `AuthenticationRejected`, and the dialog stays open on the brick.

use std::sync::Arc;
use std::time::Duration;

use tokio::time::{Instant, sleep_until};

use crate::bt::PAIRING_PIN;
use crate::provider::PairingOutcome;

use super::bluez::{
    AGENT_CAPABILITY, BluezBus, BluezDevice, BluezError, BluezObjects, CancelFlag, DiscoveryGate,
    ERROR_ALREADY_EXISTS, ERROR_REJECTED, device_path,
};

/// Where the agent is served.
pub const AGENT_PATH: &str = "/ev3cockpit/agent";
/// How long a search for a brick BlueZ does not hold yet may take, as long as the Windows
/// search.
pub const SEARCH_TIME: Duration = Duration::from_secs(40);
/// How long `Pair` may take here. Longer than BlueZ's own 60 s on an unanswered brick dialog, so
/// that ending reaches the user as BlueZ's reason (the dialog was not confirmed in time), not as
/// a bare timeout.
pub const PAIR_TIMEOUT: Duration = Duration::from_secs(90);
/// The reason a cancelled pairing gives.
pub const PAIRING_CANCELLED: &str = "The pairing was cancelled.";

/// What BlueZ's pairing errors mean to someone at the brick.
pub fn pairing_reason(error: &BluezError) -> String {
    let known = match error.name.as_str() {
        "org.bluez.Error.AuthenticationRejected" => Some(
            "The brick rejected the pairing, often because its dialog was not confirmed in time; \
             it may still be showing on the brick.",
        ),
        "org.bluez.Error.AuthenticationCanceled" => Some("The pairing was cancelled on the brick."),
        "org.bluez.Error.AuthenticationFailed" => Some("The brick refused the PIN."),
        "org.bluez.Error.AuthenticationTimeout" => Some("The brick did not answer in time."),
        "org.bluez.Error.ConnectionAttemptFailed" => {
            Some("The brick did not answer: check that it is on and its Bluetooth is on.")
        }
        "org.bluez.Error.InProgress" => {
            Some("Another pairing with this brick is already in progress.")
        }
        "org.bluez.Error.NotReady" => {
            Some("Bluetooth on this computer is off: turn it on and try again.")
        }
        "org.bluez.Error.AlreadyExists" => {
            Some("Another pairing agent of the cockpit is still registered with BlueZ.")
        }
        _ => None,
    };
    match known {
        Some(reason) => reason.to_owned(),
        None if error.message.is_empty() => format!("BlueZ: {}", error.name),
        None => format!("BlueZ: {}", error.message),
    }
}

/// Why the agent refused a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRefusal {
    /// The caller is not BlueZ, or BlueZ's owner is not known.
    NotBluez,
    /// The call is about another device than the brick being paired.
    NotThisBrick,
}

impl AgentRefusal {
    /// The error name the refusal is answered with.
    pub fn error_name(self) -> &'static str {
        ERROR_REJECTED
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::NotBluez => "Not BlueZ.",
            Self::NotThisBrick => "Not the brick being paired.",
        }
    }
}

type OwnerSource = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// The agent for one pairing: it answers BlueZ about this brick and refuses the rest. Every
/// method checks its caller, `Cancel` and `Release` too; while BlueZ's owner is unknown nobody
/// is BlueZ.
pub struct PairingAgent {
    device_path: String,
    owner: OwnerSource,
}

impl std::fmt::Debug for PairingAgent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingAgent")
            .field("device_path", &self.device_path)
            .finish_non_exhaustive()
    }
}

impl PairingAgent {
    /// An agent for the device at `device_path`, answering only the unique name `owner` reports.
    pub fn new(
        device_path: impl Into<String>,
        owner: impl Fn() -> Option<String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            device_path: device_path.into(),
            owner: Arc::new(owner),
        }
    }

    pub fn device_path(&self) -> &str {
        &self.device_path
    }

    fn check_caller(&self, sender: Option<&str>) -> Result<(), AgentRefusal> {
        match ((self.owner)(), sender) {
            (Some(owner), Some(sender)) if owner == sender => Ok(()),
            _ => Err(AgentRefusal::NotBluez),
        }
    }

    fn for_this_brick(&self, sender: Option<&str>, device: &str) -> Result<(), AgentRefusal> {
        self.check_caller(sender)?;
        if device == self.device_path {
            Ok(())
        } else {
            Err(AgentRefusal::NotThisBrick)
        }
    }

    /// The brick asks for the PIN: 1234, which every EV3 uses.
    pub fn request_pin_code(
        &self,
        sender: Option<&str>,
        device: &str,
    ) -> Result<String, AgentRefusal> {
        self.for_this_brick(sender, device)?;
        Ok(PAIRING_PIN.to_owned())
    }

    pub fn request_passkey(&self, sender: Option<&str>, device: &str) -> Result<u32, AgentRefusal> {
        self.for_this_brick(sender, device)?;
        Ok(PAIRING_PIN.parse().unwrap_or(1234))
    }

    /// Accepted for this brick.
    pub fn request_confirmation(
        &self,
        sender: Option<&str>,
        device: &str,
    ) -> Result<(), AgentRefusal> {
        self.for_this_brick(sender, device)
    }

    pub fn request_authorization(
        &self,
        sender: Option<&str>,
        device: &str,
    ) -> Result<(), AgentRefusal> {
        self.for_this_brick(sender, device)
    }

    pub fn authorize_service(
        &self,
        sender: Option<&str>,
        device: &str,
    ) -> Result<(), AgentRefusal> {
        self.for_this_brick(sender, device)
    }

    pub fn display_pin_code(&self, sender: Option<&str>, device: &str) -> Result<(), AgentRefusal> {
        self.for_this_brick(sender, device)
    }

    pub fn display_passkey(&self, sender: Option<&str>, device: &str) -> Result<(), AgentRefusal> {
        self.for_this_brick(sender, device)
    }

    pub fn cancel(&self, sender: Option<&str>) -> Result<(), AgentRefusal> {
        self.check_caller(sender)
    }

    pub fn release(&self, sender: Option<&str>) -> Result<(), AgentRefusal> {
        self.check_caller(sender)
    }
}

/// What a pairing needs.
#[derive(Clone)]
pub struct PairingContext {
    /// The connection of this moment, held for the whole pairing.
    pub bus: Arc<dyn BluezBus>,
    pub objects: Arc<BluezObjects>,
    /// BlueZ's unique bus name, for the agent's checks.
    pub owner: OwnerSource,
    /// Shared with the inquiry.
    pub gate: Arc<DiscoveryGate>,
    /// BlueZ takes one agent per connection, and there is one agent path: one pairing at a time.
    pub one_at_a_time: Arc<tokio::sync::Mutex<()>>,
    pub search_time: Duration,
    pub pair_timeout: Duration,
}

impl std::fmt::Debug for PairingContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingContext")
            .field("search_time", &self.search_time)
            .field("pair_timeout", &self.pair_timeout)
            .finish_non_exhaustive()
    }
}

fn cancelled() -> PairingOutcome {
    PairingOutcome {
        ok: false,
        reason: Some(PAIRING_CANCELLED.into()),
        status: Some("Cancelled".into()),
    }
}

fn failed(status: &str, reason: impl Into<String>) -> PairingOutcome {
    PairingOutcome {
        ok: false,
        reason: Some(reason.into()),
        status: Some(status.into()),
    }
}

fn succeeded(status: &str) -> PairingOutcome {
    PairingOutcome {
        ok: true,
        reason: None,
        status: Some(status.into()),
    }
}

/// Pairs the brick at `address`, answering rather than failing. Stops early once `cancel` is
/// set; whatever ended the wait, BlueZ is told to stop a `Pair` still running, and the agent is
/// unregistered.
///
/// Run it to its end: it is the caller that is dropped, never this (see
/// [`super::bluez::run_detached`]).
pub async fn pair_brick(
    context: PairingContext,
    address: u64,
    cancel: Arc<CancelFlag>,
) -> PairingOutcome {
    let turn = tokio::select! {
        biased;
        () = cancel.cancelled() => return cancelled(),
        turn = Arc::clone(&context.one_at_a_time).lock_owned() => turn,
    };
    let outcome = pair_in_turn(&context, address, &cancel).await;
    drop(turn);
    outcome
}

async fn pair_in_turn(
    context: &PairingContext,
    address: u64,
    cancel: &Arc<CancelFlag>,
) -> PairingOutcome {
    if cancel.is_cancelled() {
        return cancelled();
    }
    let Some(adapter) = context.objects.adapter() else {
        return failed(
            "NoAdapter",
            "This computer has no Bluetooth adapter BlueZ knows.",
        );
    };
    let path = device_path(&adapter.path, address);
    let held = context.objects.device(&path);
    if held.as_ref().is_some_and(|device| device.paired) {
        return succeeded("AlreadyPaired");
    }
    if held.is_none() {
        // A brick BlueZ does not hold yet has to be heard first.
        let found = search(context, &adapter.path, &path, cancel).await;
        if cancel.is_cancelled() {
            return cancelled();
        }
        match found {
            None => {
                return failed(
                    "NotFound",
                    "The brick was not found: check that its Bluetooth is on and it is visible.",
                );
            }
            Some(device) if device.paired => return succeeded("AlreadyPaired"),
            Some(_) => {}
        }
    }

    let bus = &context.bus;
    let owner = Arc::clone(&context.owner);
    let agent = Arc::new(PairingAgent::new(path.clone(), move || owner()));
    if let Err(error) = bus.export_agent(AGENT_PATH, agent).await {
        return failed(error.short_name(), pairing_reason(&error));
    }
    let outcome = register_and_pair(context, &path, cancel).await;
    bus.withdraw_agent(AGENT_PATH).await;
    outcome
}

async fn register_and_pair(
    context: &PairingContext,
    path: &str,
    cancel: &Arc<CancelFlag>,
) -> PairingOutcome {
    let bus = &context.bus;
    if let Err(error) = bus.register_agent(AGENT_PATH, AGENT_CAPABILITY).await {
        return failed(error.short_name(), pairing_reason(&error));
    }
    let outcome = if cancel.is_cancelled() {
        cancelled()
    } else {
        pair_bounded(context, path, cancel).await
    };
    let _ = bus.unregister_agent(AGENT_PATH).await;
    outcome
}

/// `Pair`, bounded here by the pairing time whatever the bus does, and by a cancel: either tells
/// BlueZ to stop. A `Pair` that answers is a paired brick, whatever came after. One race cannot
/// be closed: a cancel that lands after BlueZ has bonded the brick but before its reply arrives
/// answers cancelled for a brick that is in fact paired; the cache shows it paired.
async fn pair_bounded(context: &PairingContext, path: &str, cancel: &CancelFlag) -> PairingOutcome {
    let bus = &context.bus;
    let deadline = Instant::now() + context.pair_timeout;
    let answer = tokio::select! {
        answer = bus.pair(path) => Some(answer),
        () = sleep_until(deadline) => None,
        () = cancel.cancelled() => None,
    };
    match answer {
        Some(Ok(())) => succeeded("Paired"),
        Some(Err(error)) if error.is(ERROR_ALREADY_EXISTS) => succeeded("AlreadyPaired"),
        Some(Err(error)) => failed(error.short_name(), pairing_reason(&error)),
        None => {
            // BlueZ may still be pairing: tell it to stop.
            let _ = bus.cancel_pairing(path).await;
            if cancel.is_cancelled() {
                cancelled()
            } else {
                failed("Timeout", "The pairing took too long and was cancelled.")
            }
        }
    }
}

/// Waits until BlueZ holds the device at `path`, the deadline passes, or a cancel.
async fn wait_for_device(
    objects: &BluezObjects,
    path: &str,
    deadline: Instant,
    cancel: &CancelFlag,
) -> Option<BluezDevice> {
    let mut changes = objects.subscribe();
    loop {
        if cancel.is_cancelled() {
            return None;
        }
        if let Some(device) = objects.device(path) {
            return Some(device);
        }
        tokio::select! {
            () = sleep_until(deadline) => return None,
            () = cancel.cancelled() => return None,
            changed = changes.changed() => {
                if changed.is_err() {
                    tokio::select! {
                        () = sleep_until(deadline) => {}
                        () = cancel.cancelled() => {}
                    }
                    return None;
                }
            }
        }
    }
}

/// A BR/EDR discovery until BlueZ holds the brick, the search time runs out, or a cancel. Each
/// setup call races the search's end, so neither a cancel nor the search time waits for BlueZ;
/// a discovery that starts after the search gave up is stopped when it does, without holding the
/// caller, and the gate holds back the next discovery until then.
async fn search(
    context: &PairingContext,
    adapter: &str,
    path: &str,
    cancel: &CancelFlag,
) -> Option<BluezDevice> {
    let objects = Arc::clone(&context.objects);
    let deadline = Instant::now() + context.search_time;
    let heard = wait_for_device(&objects, path, deadline, cancel);
    tokio::pin!(heard);

    // A discovery an earlier search left to be stopped would stop this one: wait for it.
    tokio::select! {
        found = &mut heard => return found,
        () = context.gate.idle() => {}
    }
    tokio::select! {
        found = &mut heard => return found,
        _ = context.bus.set_discovery_filter_bredr(adapter) => {}
    }
    let hold = context.gate.hold();
    let bus = Arc::clone(&context.bus);
    let start_on = adapter.to_owned();
    let mut start = tokio::spawn(async move { bus.start_discovery(&start_on).await });
    let mut started: Option<bool> = None;
    let found = tokio::select! {
        found = &mut heard => found,
        result = &mut start => {
            started = Some(matches!(result, Ok(Ok(()))));
            (&mut heard).await
        }
    };
    // Found before BlueZ answered the start, which a report from another client's discovery
    // can do: the discovery is stopped before the pairing starts, never beside it. Only a search
    // that gave up (its time ran out, or a cancel) leaves the stop for later.
    if started.is_none() && found.is_some() {
        tokio::select! {
            biased;
            result = &mut start => started = Some(matches!(result, Ok(Ok(())))),
            () = cancel.cancelled() => {}
        }
    }
    match started {
        Some(true) => {
            let _ = context.bus.stop_discovery(adapter).await;
            drop(hold);
        }
        Some(false) => drop(hold),
        None => {
            let bus = Arc::clone(&context.bus);
            let stop_on = adapter.to_owned();
            tokio::spawn(async move {
                let _hold = hold;
                if let Ok(Ok(())) = start.await {
                    let _ = bus.stop_discovery(&stop_on).await;
                }
            });
        }
    }
    found
}
