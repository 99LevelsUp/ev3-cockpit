//! What the two USB links share: the trait the provider holds them by, the count of blocking
//! calls still running, and how a blocking call is run.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::backend::UsbLocation;
use crate::error::TransportError;
use crate::provider::SendOptions;

/// Which wire a session ended up on. Reported, because the two are not equivalent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsbBackendKind {
    /// The interrupt endpoints through libusb, at the brick's full frame.
    Libusb,
    /// The HID fallback: 64 bytes per packet on Windows and Linux.
    Hid,
}

/// One open USB link to a brick, over either backend.
#[async_trait]
pub trait UsbLink: Send + Sync {
    fn backend(&self) -> UsbBackendKind;

    /// Largest packet this link carries; `None` once it is closed.
    fn max_packet_bytes(&self) -> Option<usize>;

    /// Where the device sits on the bus, when the backend says (libusb does, HID does not).
    fn location(&self) -> Option<UsbLocation>;

    /// One request-reply exchange. Exchanges on one link run one at a time; a second waits.
    async fn send(&self, packet: &[u8], options: &SendOptions) -> Result<Vec<u8>, TransportError>;

    /// Gives the device back. Waits for transfers still running, at most
    /// [`super::CLOSE_DRAIN_MAX`]. A second close waits for the first.
    async fn close(&self);
}

/// Why an exchange stops when its link was closed under it.
pub(crate) const CLOSED_DURING_EXCHANGE: &str = "USB transport was closed during the exchange.";

/// Blocking calls handed to the pool and not yet returned. A close waits for none.
#[derive(Debug, Clone)]
pub(crate) struct InFlight {
    count: Arc<watch::Sender<usize>>,
}

impl InFlight {
    pub(crate) fn new() -> Self {
        Self {
            count: Arc::new(watch::channel(0).0),
        }
    }

    /// Counts one call until the returned guard drops.
    pub(crate) fn start(&self) -> InFlightGuard {
        self.count.send_modify(|n| *n += 1);
        InFlightGuard {
            count: self.count.clone(),
        }
    }

    /// Resolves once every counted call has returned, or after `max`, whichever comes first.
    pub(crate) async fn drained(&self, max: Duration) {
        let mut idle = self.count.subscribe();
        let _ = tokio::time::timeout(max, idle.wait_for(|n| *n == 0)).await;
    }
}

pub(crate) struct InFlightGuard {
    count: Arc<watch::Sender<usize>>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.count.send_modify(|n| *n = n.saturating_sub(1));
    }
}

/// Runs one blocking call on the pool, counted in `in_flight` until it returns.
///
/// The count is taken before the call is handed over and released by the call itself, so a
/// caller that stops waiting (a timeout, a dropped future) leaves the call counted until the
/// library really lets go.
pub(crate) async fn run_blocking<T, F>(in_flight: &InFlight, call: F) -> Result<T, TransportError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, TransportError> + Send + 'static,
{
    let guard = in_flight.start();
    match tokio::task::spawn_blocking(move || {
        let _counted = guard;
        call()
    })
    .await
    {
        Ok(result) => result,
        Err(join) => Err(TransportError::transport_failed(format!(
            "USB worker stopped: {join}"
        ))),
    }
}
