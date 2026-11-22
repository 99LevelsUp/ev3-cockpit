//! Bluetooth presence on Linux: which bricks are there, found without connecting. The shared
//! [`crate::bt::presence::PresenceMonitor`] keeps the intervals, the misses before "not heard"
//! and the hold on the connection queue; this module answers its two questions.
//!
//! The check is a short L2CAP connect to PSM 1 (SDP), closed at once. Measured with visibility
//! off on three bricks: a brick that is on answers in 2.9-4.1 s and shows nothing; one that is
//! off fails with `EHOSTDOWN` after 5.12 s. It needs no group and no D-Bus, and opens no session
//! the brick would show.
//!
//! The inquiry is a BR/EDR discovery for one window, and a brick is heard on evidence: a signal
//! carrying its RSSI during the window ([`BluezObjects::rssi_reports`]), never a value compared.
//! Under a filtered discovery BlueZ reports every result, a same value too (measured: a steady
//! brick reported three times in 30 s). An RSSI BlueZ still holds is no evidence: under another
//! client's discovery it outlives a brick switched off. A report may come from another client's
//! discovery: a real sighting of the brick all the same.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use tokio::time::{Instant, sleep_until};

use crate::bt::is_lego_mac;
use crate::bt::presence::{PresenceFailure, ScannedBrick};

use super::access::Activity;
use super::bluez::{
    BluezBus, BluezError, BluezObjects, CancelFlag, ERROR_FAILED, ERROR_IN_PROGRESS, device_name,
};
use super::rfcomm::{AF_BLUETOOTH, BTPROTO_L2CAP, SocketFailure, connect_socket, sockaddr_l2};

/// SDP's PSM: every classic device listens on it, and a connect asks the brick nothing.
pub const SDP_PSM: u16 = 1;

/// How long one check may take: a brick that is off fails after 5.12 s.
pub const PRESENCE_CHECK_TIMEOUT: Duration = Duration::from_secs(8);

/// One inquiry window. Longer than the 8-14 s between a brick's reports measured while another
/// client was discovering, so a window holds at least one report. The cost: the Bluetooth queue
/// is held 15 s of every minute.
pub const INQUIRY_WINDOW: Duration = Duration::from_secs(15);

/// What a failed connect says about the brick. Not there: `EHOSTDOWN` as measured (page
/// timeout), `EHOSTUNREACH`, `ETIMEDOUT`. There, if only to refuse: `ECONNREFUSED` and
/// `ECONNRESET`, which the brick itself sends once paged. Anything else (the adapter down, a
/// local failure) says nothing about the brick: the round fails, and nothing counts as its miss.
pub fn answered_by_errno(errno: i32) -> Result<bool, String> {
    match errno {
        libc::EHOSTDOWN | libc::EHOSTUNREACH | libc::ETIMEDOUT => Ok(false),
        libc::ECONNREFUSED | libc::ECONNRESET => Ok(true),
        _ => Err(format!(
            "The presence check failed here, not at the brick (errno {errno})."
        )),
    }
}

/// What one probe's connect says.
pub fn probe_answer(result: Result<(), SocketFailure>) -> Result<bool, PresenceFailure> {
    match result {
        Ok(()) => Ok(true),
        Err(SocketFailure::Socket(libc::EAFNOSUPPORT)) => Err(PresenceFailure::Unavailable(
            "This kernel has no Bluetooth sockets (EAFNOSUPPORT).".into(),
        )),
        Err(SocketFailure::Socket(code)) => Err(PresenceFailure::Failed(format!(
            "Could not open a Bluetooth socket for the presence check (errno {code})."
        ))),
        Err(SocketFailure::Connect(code)) => {
            answered_by_errno(code).map_err(PresenceFailure::Failed)
        }
        // Given up at the deadline: the close abandons the connect. Not heard.
        Err(SocketFailure::TimedOut(_)) => Ok(false),
    }
}

/// Asks whether a paired brick is there. The seam the provider is tested through.
#[async_trait]
pub trait PresenceProber: Send + Sync {
    async fn probe(&self, address: u64, deadline: Duration) -> Result<bool, PresenceFailure>;
}

/// The probe the daemon uses: an L2CAP connect to PSM 1, closed at once.
#[derive(Debug, Default, Clone, Copy)]
pub struct L2capProber;

#[async_trait]
impl PresenceProber for L2capProber {
    async fn probe(&self, address: u64, deadline: Duration) -> Result<bool, PresenceFailure> {
        let Some(target) = sockaddr_l2(address, SDP_PSM) else {
            return Ok(false);
        };
        let result = connect_socket(
            AF_BLUETOOTH,
            libc::SOCK_SEQPACKET,
            BTPROTO_L2CAP,
            &target,
            deadline,
        )
        .await
        // Closed at once: the brick shows nothing.
        .map(drop);
        probe_answer(result)
    }
}

/// How one inquiry window went, as far as the radio is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RadioAnswer {
    /// The discovery started and stopped.
    Answered,
    /// What a radio that stopped answering does: `StartDiscovery` failing with
    /// `org.bluez.Error.Failed` (the kernel's start failed), `StartDiscovery` refused with
    /// `InProgress` while no discovery of ours runs, or BlueZ refusing to stop our own discovery
    /// with `InProgress`.
    Stuck,
    /// Anything else (switched off, no permission, not supported, the bus): says nothing either
    /// way, so it neither counts as stuck nor ends a hold on a dead radio.
    Unclear,
}

/// What one window said about the radio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InquiryOutcome {
    pub radio: RadioAnswer,
    /// What BlueZ said, when it refused.
    pub detail: Option<String>,
}

impl InquiryOutcome {
    pub fn unclear() -> Self {
        Self {
            radio: RadioAnswer::Unclear,
            detail: None,
        }
    }

    pub fn answered() -> Self {
        Self {
            radio: RadioAnswer::Answered,
            detail: None,
        }
    }

    pub fn stuck(detail: impl Into<String>) -> Self {
        Self {
            radio: RadioAnswer::Stuck,
            detail: Some(detail.into()),
        }
    }
}

#[derive(Default)]
struct Window {
    attempted: bool,
    started: bool,
    /// `StartDiscovery` refused with `InProgress`: stuck only if no discovery of ours turns out
    /// to run.
    start_busy: Option<String>,
    stuck: Option<String>,
    /// Bricks heard, in the order first heard: (object path, brick).
    heard: Vec<(String, ScannedBrick)>,
}

impl Window {
    fn look(&mut self, objects: &BluezObjects, before: &[(String, u32)]) {
        for device in objects.devices() {
            let Some(address) = device.address.as_deref() else {
                continue;
            };
            let Some(rssi) = device.rssi else {
                continue;
            };
            if !is_lego_mac(address) {
                continue;
            }
            let earlier = before
                .iter()
                .find(|(path, _)| *path == device.path)
                .map_or(0, |(_, count)| *count);
            // Heard only on a report during the window.
            if objects.rssi_reports(&device.path) <= earlier {
                continue;
            }
            let brick = ScannedBrick {
                mac: address.to_ascii_uppercase(),
                name: device_name(&device),
                paired: device.paired,
                signal: Some(rssi),
            };
            match self.heard.iter_mut().find(|(path, _)| *path == device.path) {
                Some((_, known)) => *known = brick,
                None => self.heard.push((device.path.clone(), brick)),
            }
        }
    }
}

/// One inquiry window on `bus`: every LEGO brick BlueZ heard during it, paired or not, and what
/// the window said about the radio. The discovery is stopped however the window ends; a cancel
/// ends it early.
///
/// Run it to its end: it is the caller that is dropped, never this.
pub async fn inquiry_window(
    bus: Arc<dyn BluezBus>,
    objects: Arc<BluezObjects>,
    window: Duration,
    cancel: Arc<CancelFlag>,
    activity: Arc<dyn Activity>,
) -> (Result<Vec<ScannedBrick>, String>, InquiryOutcome) {
    let Some(adapter) = objects.adapter() else {
        return (
            Err("This computer has no Bluetooth adapter BlueZ knows.".into()),
            InquiryOutcome::unclear(),
        );
    };
    let before: Vec<(String, u32)> = objects
        .devices()
        .into_iter()
        .map(|device| {
            let count = objects.rssi_reports(&device.path);
            (device.path, count)
        })
        .collect();
    let mut state = Window::default();
    let result = run_window(
        bus.as_ref(),
        &objects,
        &adapter.path,
        window,
        &cancel,
        &before,
        &mut state,
    )
    .await;

    let mut outcome = match &state.stuck {
        Some(detail) => InquiryOutcome::stuck(detail.clone()),
        None => InquiryOutcome::unclear(),
    };
    if state.attempted {
        match bus.stop_discovery(&adapter.path).await {
            Ok(()) => {
                if state.started && outcome.radio == RadioAnswer::Unclear {
                    outcome = InquiryOutcome::answered();
                }
            }
            Err(error) => {
                let not_discovering =
                    error.is(ERROR_FAILED) && error.message.contains("No discovery started");
                if not_discovering && let Some(busy) = &state.start_busy {
                    // Start refused as busy, yet no discovery of ours runs: the kernel's start
                    // never finished (measured on a radio dead since a presence check).
                    outcome = InquiryOutcome::stuck(format!("StartDiscovery: {busy}"));
                } else if not_discovering {
                    if state.started && outcome.radio == RadioAnswer::Unclear {
                        outcome = InquiryOutcome::answered();
                    }
                } else if error.is(ERROR_IN_PROGRESS) {
                    // Our own discovery, refused: the kernel could not stop it. Said once by the
                    // radio watch, not every minute.
                    if outcome.radio != RadioAnswer::Stuck {
                        outcome = InquiryOutcome::stuck(format!("StopDiscovery: {error}"));
                    }
                } else {
                    activity.warn(&format!(
                        "StopDiscovery failed; the radio may still be discovering. {error}"
                    ));
                }
            }
        }
    }
    let result = result.map(|()| state.heard.into_iter().map(|(_, brick)| brick).collect());
    (result.map_err(|error| error.to_string()), outcome)
}

async fn run_window(
    bus: &dyn BluezBus,
    objects: &BluezObjects,
    adapter: &str,
    window: Duration,
    cancel: &CancelFlag,
    before: &[(String, u32)],
    state: &mut Window,
) -> Result<(), BluezError> {
    let mut changes = objects.subscribe();
    changes.borrow_and_update();
    bus.set_discovery_filter_bredr(adapter).await?;
    state.attempted = true;
    if let Err(error) = bus.start_discovery(adapter).await {
        if error.is(ERROR_FAILED) {
            state.stuck = Some(format!("StartDiscovery: {error}"));
        }
        if error.is(ERROR_IN_PROGRESS) {
            state.start_busy = Some(error.to_string());
        }
        return Err(error);
    }
    state.started = true;
    let end = Instant::now() + window;
    let mut watching = true;
    loop {
        tokio::select! {
            () = sleep_until(end) => break,
            () = cancel.cancelled() => break,
            changed = changes.changed(), if watching => {
                if changed.is_err() {
                    watching = false;
                } else {
                    state.look(objects, before);
                }
            }
        }
    }
    state.look(objects, before);
    Ok(())
}
