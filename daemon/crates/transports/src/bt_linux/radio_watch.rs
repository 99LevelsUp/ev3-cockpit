//! A Bluetooth adapter that has stopped answering, noticed and restarted.
//!
//! Measured on a Broadcom BCM2070 on USB: about one inquiry in six to twenty-six ends with the
//! adapter reset on the USB bus, after which it answers no command. The kernel logs "command
//! 0x0402 tx timeout" every minute; BlueZ refuses to start a discovery or to stop ours
//! (`InProgress`); every connect and presence check runs into the dead radio. Switching the
//! adapter off through BlueZ fails the same way. What brings it back is the kernel reading it
//! again, as if it had been plugged in: 0 and then 1 written to the USB device's `authorized`
//! file.
//!
//! The owner's rule: an administrative step is taken only with the user's consent, given once or
//! each time. On Linux the consent is the udev rule that ships with the extension, installed once
//! by the user, which lets the group plugdev write that file. Without it the cockpit says once
//! what happened and how to allow the restart.
//!
//! In order: two windows in a row in which the radio refused (one can be a race with another
//! client); then switching it off and on through BlueZ, which costs nothing when it works; then
//! the `authorized` file. While the adapter is known dead and cannot be restarted the radio is
//! left alone, an inquiry tried again every ten minutes, until the adapter goes and comes back.
//!
//! Past three restarts within fifteen minutes the radio is left alone too, but only for a while:
//! a dead chip never answers by itself, so a probe that finds it still dead restarts it again
//! once the oldest of those restarts is fifteen minutes old (measured: three restarts each
//! followed by a real reset within one to two minutes, then a fourth; a cockpit that gave up for
//! good left Bluetooth dead until a replug by hand).
//!
//! All timing runs on tokio's clock, so a paused test clock drives it.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use tokio::time::Instant;

use super::access::Activity;
use super::bluez::{BluezBus, BluezObjects};
use super::presence::{InquiryOutcome, RadioAnswer};

/// The rule that lets the cockpit restart a USB Bluetooth adapter, in the extension's folder.
pub const LINUX_BT_RESTART_RULE_PATH: &str = "native/linux/71-ev3-cockpit-bluetooth-restart.rules";

/// How the user allows the restart.
pub fn restart_advice(rule_path: Option<&str>) -> String {
    let rule = match rule_path {
        Some(path) => path.to_owned(),
        None => format!("{LINUX_BT_RESTART_RULE_PATH} from the extension's folder"),
    };
    format!(
        "To let the cockpit restart it, install the udev rule that ships with the extension: copy \
         {rule} to /etc/udev/rules.d/, run \"sudo udevadm control --reload\", then plug the \
         adapter in again. The user must be in the group plugdev."
    )
}

/// The adapter's USB device in sysfs. The seam the watch is tested through.
pub trait RadioSysfs: Send + Sync {
    /// The `authorized` file of the USB device under `hciN`, or `None` when it is not on USB.
    fn authorized_file(&self, hci: &str) -> Option<PathBuf>;
    fn writable(&self, file: &Path) -> bool;
    fn write(&self, file: &Path, value: &str) -> std::io::Result<()>;
}

/// This host's sysfs.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemSysfs;

impl RadioSysfs for SystemSysfs {
    fn authorized_file(&self, hci: &str) -> Option<PathBuf> {
        let digits = hci.strip_prefix("hci")?;
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        // hciN/device is the USB interface the driver bound; its parent is the USB device.
        let interface = std::fs::canonicalize(format!("/sys/class/bluetooth/{hci}/device")).ok()?;
        let device = interface.parent()?;
        if !device.join("idVendor").exists() {
            return None;
        }
        let file = device.join("authorized");
        file.exists().then_some(file)
    }

    fn writable(&self, file: &Path) -> bool {
        use std::os::unix::ffi::OsStrExt;
        let Ok(path) = std::ffi::CString::new(file.as_os_str().as_bytes()) else {
            return false;
        };
        // SAFETY: `path` is a NUL-terminated string that outlives the call.
        unsafe { libc::access(path.as_ptr(), libc::W_OK) == 0 }
    }

    fn write(&self, file: &Path, value: &str) -> std::io::Result<()> {
        std::fs::write(file, value)
    }
}

/// The watch's limits. [`Default`] is what ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RadioWatchTimings {
    /// Windows in a row the radio must refuse before it counts as stopped.
    pub windows_before_restart: u32,
    /// Between writing 0 and 1, as measured.
    pub replug_pause: Duration,
    /// Restarts allowed within `restart_span`; past them the adapter is left alone until a probe
    /// finds it still dead and the budget has room again. The measured adapter stopped six to
    /// twenty-six minutes apart for hours, then one to two minutes after each of three restarts.
    pub restarts_per_span: usize,
    pub restart_span: Duration,
    /// While left alone, how often an inquiry is tried again.
    pub probe_every: Duration,
    /// A switch off and on tried within this long is not tried again: it did not help, or it
    /// failed.
    pub switch_helped: Duration,
    /// The adapter coming back within this long of our own replug is ours coming back.
    pub own_replug: Duration,
}

impl Default for RadioWatchTimings {
    fn default() -> Self {
        Self {
            windows_before_restart: 2,
            replug_pause: Duration::from_secs(3),
            restarts_per_span: 3,
            restart_span: Duration::from_secs(15 * 60),
            probe_every: Duration::from_secs(10 * 60),
            switch_helped: Duration::from_secs(10 * 60),
            own_replug: Duration::from_secs(60),
        }
    }
}

#[derive(Debug)]
struct WatchState {
    stuck_windows: u32,
    restarting: bool,
    disposed: bool,
    /// Why the radio is being left alone, when it is.
    left_alone: Option<String>,
    left_alone_at: Instant,
    /// Left alone for the restart budget only: a probe that finds it still dead may restart it.
    left_for_budget: bool,
    restarts: Vec<Instant>,
    switch_tried_at: Option<Instant>,
    own_replug_at: Option<Instant>,
    adapter_present: bool,
}

type BusSource = Arc<dyn Fn() -> Option<Arc<dyn BluezBus>> + Send + Sync>;

/// Watches the radio through what each inquiry window says about it.
pub struct RadioWatch {
    objects: Arc<BluezObjects>,
    bus: BusSource,
    sysfs: Arc<dyn RadioSysfs>,
    activity: Arc<dyn Activity>,
    rule_path: Option<String>,
    timings: RadioWatchTimings,
    state: Mutex<WatchState>,
    listener: Mutex<Option<u64>>,
}

impl std::fmt::Debug for RadioWatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RadioWatch")
            .field("timings", &self.timings)
            .finish_non_exhaustive()
    }
}

impl RadioWatch {
    /// A watch over the adapter in `objects`, switching it through the bus `bus` hands out.
    pub fn new(
        objects: Arc<BluezObjects>,
        bus: impl Fn() -> Option<Arc<dyn BluezBus>> + Send + Sync + 'static,
        sysfs: Arc<dyn RadioSysfs>,
        activity: Arc<dyn Activity>,
        rule_path: Option<String>,
        timings: RadioWatchTimings,
    ) -> Arc<Self> {
        let watch = Arc::new(Self {
            objects: Arc::clone(&objects),
            bus: Arc::new(bus),
            sysfs,
            activity,
            rule_path,
            timings,
            state: Mutex::new(WatchState {
                stuck_windows: 0,
                restarting: false,
                disposed: false,
                left_alone: None,
                left_alone_at: Instant::now(),
                left_for_budget: false,
                restarts: Vec::new(),
                switch_tried_at: None,
                own_replug_at: None,
                adapter_present: objects.adapter().is_some(),
            }),
            listener: Mutex::new(None),
        });
        let weak: Weak<Self> = Arc::downgrade(&watch);
        let id = objects.on_change(move || {
            if let Some(watch) = weak.upgrade() {
                watch.adapter_seen();
            }
        });
        *watch
            .listener
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(id);
        watch
    }

    fn lock(&self) -> MutexGuard<'_, WatchState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Presence checks wait: while the adapter is restarted, and while it is known dead.
    pub fn checks_held(&self) -> bool {
        let state = self.lock();
        state.disposed || state.restarting || state.left_alone.is_some()
    }

    /// Inquiries wait too, except one every `probe_every` while the adapter is known dead, which
    /// may find it answering again: a probe for the inquiry alone, not the checks.
    pub fn inquiry_held(&self) -> bool {
        let state = self.lock();
        if state.disposed || state.restarting {
            return true;
        }
        if state.left_alone.is_none() {
            return false;
        }
        Instant::now().saturating_duration_since(state.left_alone_at) < self.timings.probe_every
    }

    /// Why the radio is being left alone, when it is.
    pub fn left_alone(&self) -> Option<String> {
        self.lock().left_alone.clone()
    }

    /// What one inquiry window said about the radio. Settles once a restart it started is over:
    /// the inquiry awaits it, so the restart runs while the inquiry still holds the Bluetooth
    /// queue and no pairing or connect can start meanwhile. The restart runs on a task of its
    /// own, so an adapter taken off is read again even when this future is dropped.
    pub async fn note_window(self: &Arc<Self>, outcome: InquiryOutcome) {
        let detail = outcome
            .detail
            .clone()
            .unwrap_or_else(|| "it refused a discovery".into());
        let restart = {
            let mut state = self.lock();
            if state.disposed || state.restarting {
                return;
            }
            match outcome.radio {
                RadioAnswer::Answered => {
                    state.stuck_windows = 0;
                    if state.left_alone.is_some() {
                        drop(state);
                        self.back("it answered again");
                    }
                    return;
                }
                _ if state.left_alone.is_some() => {
                    // Still dead after a pause for the budget: restart it once the budget has
                    // room again.
                    if outcome.radio == RadioAnswer::Stuck
                        && state.left_for_budget
                        && self.budget_has_room(&mut state)
                    {
                        state.left_alone = None;
                        true
                    } else {
                        // A probe that found it still dead, or found out nothing: wait another
                        // while, quietly.
                        state.left_alone_at = Instant::now();
                        false
                    }
                }
                // A window that says nothing either way neither counts nor breaks a run.
                RadioAnswer::Unclear => false,
                RadioAnswer::Stuck => {
                    state.stuck_windows += 1;
                    if state.stuck_windows < self.timings.windows_before_restart {
                        false
                    } else {
                        state.stuck_windows = 0;
                        true
                    }
                }
            }
        };
        if restart {
            let this = Arc::clone(self);
            let _ = tokio::spawn(async move { this.restart(detail).await }).await;
        }
    }

    /// Nothing new is started after this; an adapter already taken off is still read again.
    pub fn dispose(&self) {
        self.lock().disposed = true;
        if let Some(id) = self
            .listener
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()
        {
            self.objects.remove_listener(id);
        }
    }

    /// Fewer restarts than allowed within the span, counting from now.
    fn budget_has_room(&self, state: &mut WatchState) -> bool {
        let now = Instant::now();
        let span = self.timings.restart_span;
        state
            .restarts
            .retain(|at| now.saturating_duration_since(*at) < span);
        state.restarts.len() < self.timings.restarts_per_span
    }

    /// Said once: while left alone a restart is tried only when the budget has room again, so
    /// nothing comes here again until it is back or restarted.
    fn leave_alone(&self, message: String, for_budget: bool) {
        {
            let mut state = self.lock();
            state.left_alone = Some(message.clone());
            state.left_for_budget = for_budget;
            state.left_alone_at = Instant::now();
        }
        self.activity.warn(&message);
    }

    fn back(&self, how: &str) {
        {
            let mut state = self.lock();
            state.left_alone = None;
            state.stuck_windows = 0;
        }
        self.activity.info(&format!(
            "The Bluetooth adapter is back ({how}); Bluetooth bricks are looked for again."
        ));
    }

    async fn restart(self: Arc<Self>, detail: String) {
        let Some(adapter) = self.objects.adapter() else {
            return;
        };
        let hci = adapter.hci().to_owned();
        let now = Instant::now();
        let switch_lately = {
            let mut state = self.lock();
            if !self.budget_has_room(&mut state) {
                let count = state.restarts.len();
                drop(state);
                let minutes = self.timings.probe_every.as_secs() / 60;
                self.leave_alone(
                    format!(
                        "The Bluetooth adapter {hci} has stopped answering again, {count} times \
                         within 15 minutes; the cockpit pauses: no Bluetooth bricks are looked \
                         for, and in {minutes} minutes it looks at the adapter again and restarts \
                         it if it is still not answering."
                    ),
                    true,
                );
                return;
            }
            state.restarting = true;
            let lately = state
                .switch_tried_at
                .is_some_and(|at| now.saturating_duration_since(at) < self.timings.switch_helped);
            if !lately {
                state.switch_tried_at = Some(now);
            }
            lately
        };
        self.activity.warn(&format!(
            "The Bluetooth adapter {hci} has stopped answering ({detail}); restarting it."
        ));
        self.restart_steps(&adapter.path, &hci, switch_lately).await;
        self.lock().restarting = false;
    }

    async fn restart_steps(&self, adapter_path: &str, hci: &str, switch_lately: bool) {
        // Tried not long ago: it either failed or did not help. Read the adapter afresh instead.
        if !switch_lately && self.switch_off_and_on(adapter_path).await {
            self.lock().restarts.push(Instant::now());
            self.activity.info(&format!(
                "Restarted the Bluetooth adapter {hci} by switching it off and on."
            ));
            return;
        }
        if self.lock().disposed {
            return;
        }
        let Some(file) = self.sysfs.authorized_file(hci) else {
            self.leave_alone(
                format!(
                    "The cockpit cannot restart the Bluetooth adapter {hci}: it is not a USB \
                     adapter. Switching Bluetooth off and on may bring it back; until then \
                     Bluetooth bricks are not looked for."
                ),
                false,
            );
            return;
        };
        if !self.sysfs.writable(&file) {
            self.leave_alone(
                format!(
                    "The cockpit may not restart the Bluetooth adapter {hci}. {} Until then, plug \
                     the adapter out and in again; Bluetooth bricks are not looked for meanwhile.",
                    restart_advice(self.rule_path.as_deref())
                ),
                false,
            );
            return;
        }
        self.lock().own_replug_at = Some(Instant::now());
        // Taken off and read again whatever happens meanwhile, dispose included: never left off.
        let off = self.sysfs.write(&file, "0");
        if off.is_ok() {
            tokio::time::sleep(self.timings.replug_pause).await;
        }
        let on = self.sysfs.write(&file, "1");
        match off.and(on) {
            Ok(()) => {
                self.lock().restarts.push(Instant::now());
                self.activity.info(&format!(
                    "Restarted the Bluetooth adapter {hci}: the system read it again, as if it \
                     had been plugged in again."
                ));
            }
            Err(error) => self.leave_alone(
                format!(
                    "Restarting the Bluetooth adapter {hci} failed ({error}); plug it out and in \
                     again. Until then Bluetooth bricks are not looked for."
                ),
                false,
            ),
        }
    }

    /// Through BlueZ; true when it went off and came back on. A dead radio refuses the first.
    async fn switch_off_and_on(&self, adapter_path: &str) -> bool {
        let Some(bus) = (self.bus)() else {
            return false;
        };
        if bus.set_powered(adapter_path, false).await.is_err() {
            return false;
        }
        // Off but not on again: the next step reads it afresh, and BlueZ switches it on then.
        bus.set_powered(adapter_path, true).await.is_ok()
    }

    /// The adapter went and came back. After our own replug it is ours coming back, and the
    /// restart budget stands; otherwise (plugged in again by hand, another adapter, BlueZ
    /// restarted) it is a fresh start.
    fn adapter_seen(&self) {
        let present = self.objects.adapter().is_some();
        let came_back = {
            let mut state = self.lock();
            let came_back = present && !state.adapter_present;
            if came_back {
                state.stuck_windows = 0;
                let own = state.own_replug_at.is_some_and(|at| {
                    Instant::now().saturating_duration_since(at) < self.timings.own_replug
                });
                state.own_replug_at = None;
                if !own {
                    state.restarts.clear();
                    state.switch_tried_at = None;
                }
            }
            state.adapter_present = present;
            came_back && state.left_alone.is_some()
        };
        if came_back {
            self.back("the adapter came back");
        }
    }
}
