//! Pairing a brick with this computer through WinRT `DeviceInformationCustomPairing`, inside the
//! daemon, on a thread of its own.
//!
//! The ceremony: a brick already paired is answered from Windows' own records, with no air time
//! (the inquiry below is scoped to unpaired devices and cannot see it). Otherwise a live watcher
//! runs up to two inquiry windows, because one window missed a brick in range more than once, and
//! the brick's entry from that watcher is paired while the watcher stays alive. Only `ProvidePin`
//! is offered, with the EV3's fixed 1234: no other kind is one the brick's legacy pairing can
//! satisfy, and a request of another kind is left unanswered rather than accepted blindly.
//!
//! The rules live in [`run_pairing`], over [`PairingSteps`]; [`pair_on_this_thread`] runs them on
//! WinRT, on a single-threaded apartment that keeps dispatching COM calls and window messages
//! while it waits, so the `PairingRequested` event has somewhere to arrive.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tokio::sync::Notify;

use crate::bt::PAIRING_PIN;
use crate::bt_windows::discovery::id_matches_address;
use crate::provider::PairingOutcome;

/// The reason a pairing gives when it was cancelled, by whoever started it or on the brick.
pub const PAIRING_CANCELLED: &str = "The pairing was cancelled.";

/// Inquiry windows a pairing gets before it reports the brick not found.
pub const INQUIRY_WINDOWS: u32 = 2;

/// One pairing inquiry window. A cold find measured 4.7 s; this is headroom for a brick that is
/// slow to answer an inquiry.
pub const PAIRING_INQUIRY_WINDOW: Duration = Duration::from_secs(30);

/// The whole pairing's deadline: both windows and the ceremony, which measured between 5 s and
/// 46 s and includes the time a person takes to confirm on the brick's display.
pub const PAIRING_TIMEOUT: Duration = Duration::from_secs(120);

/// `DevicePairingKinds.ProvidePin`.
pub const PROVIDE_PIN: u32 = 4;

/// What a pairing offers Windows: the pairing kinds, and the PIN it answers with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PairingOffer {
    /// `DevicePairingKinds` flags.
    pub kinds: u32,
    pub pin: &'static str,
}

/// The EV3's offer: `ProvidePin` only, with 1234.
pub const EV3_OFFER: PairingOffer = PairingOffer {
    kinds: PROVIDE_PIN,
    pin: PAIRING_PIN,
};

/// The PIN a pairing request of `kind` is answered with, or `None` to leave it unanswered.
pub fn answer_pairing_request(offer: &PairingOffer, kind: u32) -> Option<&'static str> {
    (kind == PROVIDE_PIN && offer.kinds & PROVIDE_PIN != 0).then_some(offer.pin)
}

/// Cancels a pairing from outside: from the async side ([`PairingCancel::cancel`]) to the thread
/// running the ceremony, which looks at it between waits.
#[derive(Debug, Default)]
pub struct PairingCancel {
    cancelled: AtomicBool,
    notify: Notify,
}

impl PairingCancel {
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once cancelled.
    pub async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}

/// How the pairing call itself ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairResult {
    /// Windows' status, by its name (`Paired`, `AuthenticationTimeout`, ...).
    Status(String),
    /// Cancelled from outside before it finished.
    Cancelled,
}

/// The WinRT calls a pairing makes, one per step, so the rules above them can be tested without
/// a radio.
pub trait PairingSteps {
    /// The brick as the watcher reported it, kept alive until the pairing is done.
    type Found;
    /// Whether Windows' records hold a pairing with the brick.
    fn is_paired(&mut self, address: u64) -> Result<bool, String>;
    /// One inquiry window on unpaired devices; the brick's entry once it appears. Returns early,
    /// without it, when cancelled.
    fn watch(
        &mut self,
        address: u64,
        window: Duration,
        cancel: &PairingCancel,
    ) -> Result<Option<Self::Found>, String>;
    fn found_is_paired(&self, found: &Self::Found) -> bool;
    /// Pairs the found brick, offering `offer`.
    fn pair(
        &mut self,
        found: Self::Found,
        offer: &PairingOffer,
        cancel: &PairingCancel,
    ) -> Result<PairResult, String>;
}

fn cancelled(status: Option<&str>) -> PairingOutcome {
    PairingOutcome {
        ok: false,
        reason: Some(PAIRING_CANCELLED.into()),
        status: status.map(str::to_owned),
    }
}

fn already_paired() -> PairingOutcome {
    PairingOutcome {
        ok: true,
        reason: None,
        status: Some("AlreadyPaired".into()),
    }
}

fn failed(reason: String) -> PairingOutcome {
    PairingOutcome {
        ok: false,
        reason: Some(reason),
        status: None,
    }
}

/// Reads Windows' status. Only `Paired` is a success; `PairingCanceled` was cancelled, not
/// refused.
pub fn outcome_of_status(status: &str) -> PairingOutcome {
    match status {
        "Paired" => PairingOutcome {
            ok: true,
            reason: None,
            status: Some(status.into()),
        },
        "PairingCanceled" => cancelled(Some(status)),
        _ => PairingOutcome {
            ok: false,
            reason: Some(describe_status(status)),
            status: Some(status.into()),
        },
    }
}

/// Wording for the statuses a user can do something about.
///
/// `AuthenticationTimeout` usually means nobody pressed on the brick, but it does not prove the
/// brick asked: one linked to a phone app timed out with no question on its display. And a brick
/// held by another Bluetooth device fails as `NotFound` with Bluetooth and visibility both on.
/// So both name that cause too, and neither claims more than the status says.
pub fn describe_status(status: &str) -> String {
    match status {
        "NotFound" => {
            "Could not find the brick over Bluetooth. Check that it is switched on, that \
                       Bluetooth and visibility are enabled on the brick itself, and that it is \
                       not connected to another Bluetooth device, such as another brick or a phone."
                .into()
        }
        "AuthenticationTimeout" => "Nobody confirmed the pairing on the brick in time. Watch the \
                                    brick's display and confirm there, then try again; if no \
                                    question appeared on it, the brick may be connected to \
                                    another Bluetooth device, such as another brick or a phone."
            .into(),
        "RejectedByHandler" | "AccessDenied" => format!("Windows refused the pairing ({status})."),
        _ => format!("Pairing did not complete ({status})."),
    }
}

/// The name of a `DevicePairingResultStatus` value.
pub fn status_name(code: i32) -> String {
    let name = match code {
        0 => "Paired",
        1 => "NotReadyToPair",
        2 => "NotPaired",
        3 => "AlreadyPaired",
        4 => "ConnectionRejected",
        5 => "TooManyConnections",
        6 => "HardwareFailure",
        7 => "AuthenticationTimeout",
        8 => "AuthenticationNotAllowed",
        9 => "AuthenticationFailure",
        10 => "NoSupportedProfiles",
        11 => "ProtectionLevelCouldNotBeMet",
        12 => "AccessDenied",
        13 => "InvalidCeremonyData",
        14 => "PairingCanceled",
        15 => "OperationAlreadyInProgress",
        16 => "RequiredHandlerNotRegistered",
        17 => "RejectedByHandler",
        18 => "RemoteDeviceHasAssociation",
        19 => "Failed",
        other => return format!("Status{other}"),
    };
    name.into()
}

/// The pairing ceremony's rules, over whatever runs its steps.
pub fn run_pairing<S: PairingSteps>(
    steps: &mut S,
    address: u64,
    window: Duration,
    cancel: &PairingCancel,
) -> PairingOutcome {
    if cancel.is_cancelled() {
        return cancelled(None);
    }
    match steps.is_paired(address) {
        Ok(true) => return already_paired(),
        Ok(false) => {}
        Err(reason) => return failed(reason),
    }
    let mut found = None;
    for _ in 0..INQUIRY_WINDOWS {
        if cancel.is_cancelled() {
            return cancelled(None);
        }
        match steps.watch(address, window, cancel) {
            Ok(Some(entry)) => {
                found = Some(entry);
                break;
            }
            Ok(None) => {}
            Err(reason) => return failed(reason),
        }
    }
    if cancel.is_cancelled() {
        return cancelled(None);
    }
    let Some(found) = found else {
        return outcome_of_status("NotFound");
    };
    if steps.found_is_paired(&found) {
        return already_paired();
    }
    match steps.pair(found, &EV3_OFFER, cancel) {
        Ok(PairResult::Cancelled) => cancelled(None),
        Ok(PairResult::Status(status)) => outcome_of_status(&status),
        Err(reason) => failed(reason),
    }
}

/// Runs the whole ceremony on WinRT, on the calling thread, which it makes a single-threaded
/// apartment. Blocks until the pairing ends; run it on a thread of its own.
pub fn pair_on_this_thread(
    address: u64,
    window: Duration,
    cancel: &PairingCancel,
) -> PairingOutcome {
    use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoUninitialize};
    if let Err(reason) = crate::bt_windows::discovery::keep_com_alive() {
        return failed(reason);
    }
    // SAFETY: the caller made this thread for this call; it is uninitialised below once every
    // WinRT object made here is gone.
    let initialised = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    let outcome = match winrt::WinrtSteps::new() {
        Ok(mut steps) => run_pairing(&mut steps, address, window, cancel),
        Err(reason) => failed(reason),
    };
    if initialised {
        // SAFETY: balances the successful initialise above, on the same thread.
        unsafe { CoUninitialize() };
    }
    outcome
}

mod winrt {
    use super::{Duration, Instant, id_matches_address, status_name};
    use super::{PairResult, PairingCancel, PairingOffer, PairingSteps, answer_pairing_request};
    use std::sync::{Arc, Mutex};
    use windows::Devices::Bluetooth::BluetoothDevice;
    use windows::Devices::Enumeration::{
        DeviceInformation, DeviceInformationCustomPairing, DeviceInformationUpdate,
        DevicePairingKinds, DevicePairingProtectionLevel, DevicePairingRequestedEventArgs,
        DeviceWatcher,
    };
    use windows::Foundation::TypedEventHandler;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Com::{
        COWAIT_DISPATCH_CALLS, COWAIT_DISPATCH_WINDOW_MESSAGES, CoWaitForMultipleHandles,
    };
    use windows::core::HSTRING;

    /// One wait between looks at a WinRT operation or the cancel flag.
    const PUMP_MS: u32 = 50;

    /// `AsyncStatus` values. Named here because the type lives in a crate this one does not
    /// name.
    const ASYNC_COMPLETED: i32 = 1;
    const ASYNC_CANCELED: i32 = 2;
    const ASYNC_ERROR: i32 = 3;

    /// Waits for a WinRT operation, dispatching while it runs, and cancels it once `cancel` is
    /// set. `Some(results)` when it completed, `None` when it ended cancelled. A macro rather
    /// than a function: the operation's type lives in a crate this one does not name.
    macro_rules! wait_for {
        ($steps:expr, $operation:expr, $cancel:expr) => {{
            let operation = $operation;
            let mut cancel_sent = false;
            loop {
                let status = operation.Status().map_err(|e| text(&e))?.0;
                if status == ASYNC_COMPLETED {
                    break Some(operation.GetResults().map_err(|e| text(&e))?);
                }
                if status == ASYNC_CANCELED {
                    break None;
                }
                if status == ASYNC_ERROR {
                    let code = operation.ErrorCode().map_err(|e| text(&e))?;
                    return Err(text(&windows::core::Error::from_hresult(code)));
                }
                if $cancel.is_cancelled() && !cancel_sent {
                    cancel_sent = true;
                    let _ = operation.Cancel();
                }
                $steps.pump();
            }
        }};
    }

    fn text(error: &windows::core::Error) -> String {
        format!("{} ({:#010x})", error.message(), error.code().0)
    }

    /// An event nobody signals, waited on with COM's dispatching wait: a sleep that keeps the
    /// apartment answering calls and window messages.
    pub(super) struct WinrtSteps {
        idle: windows_sys::Win32::Foundation::HANDLE,
    }

    impl WinrtSteps {
        pub(super) fn new() -> Result<Self, String> {
            use windows_sys::Win32::System::Threading::CreateEventW;
            // SAFETY: a manual-reset, unsignalled, unnamed event; closed in Drop.
            let idle = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
            if idle.is_null() {
                return Err("Could not create the pairing thread's wait event.".into());
            }
            Ok(Self { idle })
        }

        fn pump(&self) {
            let flags = (COWAIT_DISPATCH_CALLS.0 | COWAIT_DISPATCH_WINDOW_MESSAGES.0) as u32;
            // SAFETY: `idle` is a live event handle; the wait times out after PUMP_MS, which is
            // its ordinary outcome and not an error worth reading.
            let _ = unsafe { CoWaitForMultipleHandles(flags, PUMP_MS, &[HANDLE(self.idle)]) };
        }
    }

    impl Drop for WinrtSteps {
        fn drop(&mut self) {
            // SAFETY: `idle` was created in `new` and is closed once.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(self.idle) };
        }
    }

    pub(super) struct Found {
        info: DeviceInformation,
        /// Kept alive through the pairing; stopped once it is done.
        watcher: DeviceWatcher,
    }

    impl Drop for Found {
        fn drop(&mut self) {
            let _ = self.watcher.Stop();
        }
    }

    impl PairingSteps for WinrtSteps {
        type Found = Found;

        fn is_paired(&mut self, address: u64) -> Result<bool, String> {
            let selector =
                BluetoothDevice::GetDeviceSelectorFromPairingState(true).map_err(|e| text(&e))?;
            let operation =
                DeviceInformation::FindAllAsyncAqsFilter(&selector).map_err(|e| text(&e))?;
            let Some(paired) = wait_for!(self, operation, PairingCancel::default()) else {
                return Ok(false);
            };
            for index in 0..paired.Size().map_err(|e| text(&e))? {
                let id = paired.GetAt(index).and_then(|info| info.Id());
                if id.is_ok_and(|id| id_matches_address(&id.to_string(), address)) {
                    return Ok(true);
                }
            }
            Ok(false)
        }

        fn watch(
            &mut self,
            address: u64,
            window: Duration,
            cancel: &PairingCancel,
        ) -> Result<Option<Found>, String> {
            // The unpaired selector is the one whose filter makes the radio run a live inquiry;
            // the general selector is paired-only and never finds a brick this host has not met.
            let selector =
                BluetoothDevice::GetDeviceSelectorFromPairingState(false).map_err(|e| text(&e))?;
            let watcher =
                DeviceInformation::CreateWatcherAqsFilter(&selector).map_err(|e| text(&e))?;
            let found: Arc<Mutex<Option<DeviceInformation>>> = Arc::new(Mutex::new(None));
            {
                let found = Arc::clone(&found);
                watcher
                    .Added(&TypedEventHandler::<DeviceWatcher, DeviceInformation>::new(
                        move |_, info| {
                            if let Some(info) = info.as_ref() {
                                let matches = info
                                    .Id()
                                    .is_ok_and(|id| id_matches_address(&id.to_string(), address));
                                let mut slot = found
                                    .lock()
                                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                                if matches && slot.is_none() {
                                    *slot = Some(info.clone());
                                }
                            }
                            Ok(())
                        },
                    ))
                    .map_err(|e| text(&e))?;
            }
            // Every event subscribed, though only Added is read: a watcher with only Added lost
            // live inquiry results after its enumeration completed.
            watcher
                .Updated(
                    &TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(
                        |_, _| Ok(()),
                    ),
                )
                .map_err(|e| text(&e))?;
            watcher
                .Removed(
                    &TypedEventHandler::<DeviceWatcher, DeviceInformationUpdate>::new(
                        |_, _| Ok(()),
                    ),
                )
                .map_err(|e| text(&e))?;
            watcher.Start().map_err(|e| text(&e))?;
            let started = Instant::now();
            loop {
                let entry = found
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take();
                if let Some(info) = entry {
                    return Ok(Some(Found { info, watcher }));
                }
                if cancel.is_cancelled() || started.elapsed() >= window {
                    let _ = watcher.Stop();
                    return Ok(None);
                }
                self.pump();
            }
        }

        fn found_is_paired(&self, found: &Found) -> bool {
            found
                .info
                .Pairing()
                .and_then(|pairing| pairing.IsPaired())
                .unwrap_or(false)
        }

        fn pair(
            &mut self,
            found: Found,
            offer: &PairingOffer,
            cancel: &PairingCancel,
        ) -> Result<PairResult, String> {
            let custom = found
                .info
                .Pairing()
                .and_then(|pairing| pairing.Custom())
                .map_err(|e| text(&e))?;
            let offer = *offer;
            let token = custom
                .PairingRequested(&TypedEventHandler::<
                    DeviceInformationCustomPairing,
                    DevicePairingRequestedEventArgs,
                >::new(move |_, request| {
                    if let Some(request) = request.as_ref() {
                        let kind = request.PairingKind()?;
                        if let Some(pin) = answer_pairing_request(&offer, kind.0) {
                            request.AcceptWithPin(&HSTRING::from(pin))?;
                        }
                    }
                    Ok(())
                }))
                .map_err(|e| text(&e))?;
            let result = (|| -> Result<Option<i32>, String> {
                let operation = custom
                    .PairWithProtectionLevelAsync(
                        DevicePairingKinds(offer.kinds),
                        DevicePairingProtectionLevel::Default,
                    )
                    .map_err(|e| text(&e))?;
                Ok(match wait_for!(self, operation, cancel) {
                    Some(result) => Some(result.Status().map_err(|e| text(&e))?.0),
                    None => None,
                })
            })();
            let _ = custom.RemovePairingRequested(token);
            drop(found);
            Ok(match result? {
                None => PairResult::Cancelled,
                Some(code) => PairResult::Status(status_name(code)),
            })
        }
    }
}
