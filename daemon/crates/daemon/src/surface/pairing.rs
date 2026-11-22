//! Pairing a brick over Bluetooth for a person: the surface owns it, since the runtime has no
//! pairing of its own beyond the one-sided repair's.
//!
//! A pairing runs the Bluetooth provider's `pair` (Windows custom pairing, the BlueZ agent) on a
//! task of its own, tells every client it started, its step and its end, and tells the one-sided
//! check how it went: a failed or cancelled pairing suspends the brick's check until it is
//! connected again, a successful one is recorded so the check waits for the brick's list to name
//! this computer. One pairing per brick at a time; a second request for the same brick waits for
//! the first and gets its result.
//!
//! A forget or a clear cancels a pairing in flight and waits for it to end before the brick's list
//! is read. The provider trait has no cancel, so the surface cancels by dropping the provider's
//! future: while the pairing waits for its turn in the Bluetooth queue nothing has been sent, on
//! both platforms. Once the ceremony runs, on Linux the drop trips the provider's own cancel: its
//! detached work tells BlueZ `CancelPairing`, which the surface does not wait for, and a cancel
//! that lands after BlueZ bonded the brick but before its reply leaves the brick paired. On
//! Windows the ceremony's thread runs on until the provider's own pairing timeout; the drop stops
//! nothing there, and a pairing that completes after the list was read can put this computer's
//! entry back.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ev3_contract::{
    Notification, PairingEvent, PairingOutcome as Outcome, PairingProgress, PairingResult,
};
use ev3_transports::{PairingOutcome, Transport};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::Surface;

/// How long a forget or a clear waits for a repair's pairing to end before it goes on.
const REPAIR_PAIRING_WAIT: Duration = Duration::from_secs(90);

struct InFlight {
    /// Which pairing of the brick this is, so only it removes its own entry.
    id: u64,
    cancel: CancellationToken,
    done: watch::Receiver<Option<PairingResult>>,
}

/// The pairings the surface runs, by brick.
#[derive(Default)]
pub struct Pairings {
    running: Mutex<HashMap<String, InFlight>>,
    next_id: std::sync::atomic::AtomicU64,
}

/// What a request to pair finds: a pairing of the brick already running, whose result it waits
/// for, or a new one it starts.
enum Join {
    Running(watch::Receiver<Option<PairingResult>>),
    Started {
        id: u64,
        cancel: CancellationToken,
        tx: watch::Sender<Option<PairingResult>>,
        done: watch::Receiver<Option<PairingResult>>,
    },
}

impl Pairings {
    /// Whether a pairing the surface runs is in flight.
    pub(super) fn any(&self) -> bool {
        !self.running.lock().expect("pairings lock").is_empty()
    }

    /// Joins the brick's pairing, or registers a new one: under one lock, so two requests at once
    /// never both start a ceremony.
    fn join(&self, brick_id: &str) -> Join {
        let mut running = self.running.lock().expect("pairings lock");
        if let Some(existing) = running.get(brick_id) {
            return Join::Running(existing.done.clone());
        }
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let cancel = CancellationToken::new();
        let (tx, done) = watch::channel(None);
        running.insert(
            brick_id.to_owned(),
            InFlight {
                id,
                cancel: cancel.clone(),
                done: done.clone(),
            },
        );
        Join::Started {
            id,
            cancel,
            tx,
            done,
        }
    }

    /// Removes the brick's pairing `id` when it ended; a newer pairing of the brick stays.
    fn end(&self, brick_id: &str, id: u64) {
        let mut running = self.running.lock().expect("pairings lock");
        if running.get(brick_id).is_some_and(|p| p.id == id) {
            running.remove(brick_id);
        }
    }
}

/// A provider's outcome as the contract reports it.
pub fn result_of(brick_id: &str, outcome: &PairingOutcome) -> PairingResult {
    let cancelled = outcome.status.as_deref() == Some("Cancelled")
        || outcome
            .reason
            .as_deref()
            .is_some_and(|r| r.to_lowercase().contains("cancelled"));
    PairingResult {
        brick_id: brick_id.to_owned(),
        outcome: if outcome.ok {
            Outcome::Paired
        } else if cancelled {
            Outcome::Cancelled
        } else {
            Outcome::Failed
        },
        message: outcome.reason.clone(),
        status: outcome.status.clone(),
    }
}

fn failed(brick_id: &str, reason: &str) -> PairingResult {
    PairingResult {
        brick_id: brick_id.to_owned(),
        outcome: Outcome::Failed,
        message: Some(reason.to_owned()),
        status: None,
    }
}

impl Surface {
    /// Pairs the brick with this computer; the person confirms on the brick.
    pub async fn pair_brick(self: &Arc<Self>, brick_id: &str) -> PairingResult {
        let Some(provider) = self.runtime.scheduler.provider(Transport::Bt) else {
            return failed(brick_id, "No Bluetooth provider can pair.");
        };
        let Some(key) = self
            .runtime
            .list
            .brick(brick_id)
            .and_then(|entry| entry.channel(Transport::Bt).map(|c| c.brick_key.clone()))
        else {
            return failed(
                brick_id,
                "The brick has no Bluetooth channel: switch its Bluetooth on and look for bricks.",
            );
        };
        let (id, cancel, tx, mut done) = match self.pairings.join(brick_id) {
            Join::Running(mut done) => {
                return wait_result(&mut done)
                    .await
                    .unwrap_or_else(|| failed(brick_id, "The pairing ended without an answer."));
            }
            Join::Started {
                id,
                cancel,
                tx,
                done,
            } => (id, cancel, tx, done),
        };
        self.shared.broadcast(&Notification::BricksPairingStarted(
            ev3_contract::BrickIdPayload {
                brick_id: brick_id.to_owned(),
            },
        ));
        let surface = self.clone();
        let brick = brick_id.to_owned();
        // On a task of its own: a request that goes away does not leave the pairing half-told.
        tokio::spawn(async move {
            surface
                .shared
                .broadcast(&Notification::BricksPairingEvent(PairingEvent {
                    brick_id: brick.clone(),
                    progress: PairingProgress::PairingRequested,
                }));
            let outcome = tokio::select! {
                outcome = provider.pair(&key) => outcome.unwrap_or_else(|error| PairingOutcome {
                    ok: false,
                    reason: Some(error.message),
                    status: None,
                }),
                () = cancel.cancelled() => PairingOutcome {
                    ok: false,
                    reason: Some("The pairing was cancelled: the brick is being forgotten or its Bluetooth list cleared.".into()),
                    status: Some("Cancelled".into()),
                },
            };
            let check = &surface.runtime.check;
            if outcome.ok {
                surface.runtime.list.mark_paired(&key);
                check.own_pairing_done(&brick);
            } else {
                check.suspend(&brick);
            }
            let result = result_of(&brick, &outcome);
            surface.pairings.end(&brick, id);
            surface
                .shared
                .broadcast(&Notification::BricksPairingDone(result.clone()));
            surface.bricks_changed();
            let _ = tx.send(Some(result));
        });
        wait_result(&mut done)
            .await
            .unwrap_or_else(|| failed(brick_id, "The pairing ended without an answer."))
    }

    /// Before a forget or a clear reads the brick's list: cancels the surface's pairing of the
    /// brick and waits for it to end, then waits out a pairing the one-sided repair runs, which
    /// nothing outside the runtime can cancel.
    pub async fn settle_pairings(&self, brick_id: &str) {
        let running = self
            .pairings
            .running
            .lock()
            .expect("pairings lock")
            .get(brick_id)
            .map(|p| (p.cancel.clone(), p.done.clone()));
        if let Some((cancel, mut done)) = running {
            cancel.cancel();
            let _ = wait_result(&mut done).await;
        }
        let waited = tokio::time::timeout(REPAIR_PAIRING_WAIT, async {
            loop {
                let settled = self.repair_settled.notified();
                if !self.lock().repair_pairings.contains(brick_id) {
                    return;
                }
                settled.await;
            }
        })
        .await;
        if waited.is_err() {
            self.shared.log.warn(&format!(
                "The repair's pairing of {brick_id} did not end within {} s; going on.",
                REPAIR_PAIRING_WAIT.as_secs()
            ));
        }
    }
}

async fn wait_result(done: &mut watch::Receiver<Option<PairingResult>>) -> Option<PairingResult> {
    done.wait_for(Option::is_some)
        .await
        .ok()
        .and_then(|result| result.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result(brick: &str) -> PairingResult {
        failed(brick, "test")
    }

    #[test]
    fn a_second_request_for_a_brick_joins_the_pairing_running() {
        let pairings = Pairings::default();
        let Join::Started { tx, .. } = pairings.join("b1") else {
            panic!("the first request starts the pairing");
        };
        let Join::Running(done) = pairings.join("b1") else {
            panic!("a second request must join, not start a second ceremony");
        };
        tx.send(Some(result("b1"))).expect("sent");
        assert!(
            done.borrow().is_some(),
            "the joined request hears the result"
        );
        assert!(
            matches!(pairings.join("b2"), Join::Started { .. }),
            "another brick pairs on its own"
        );
    }

    #[test]
    fn an_ended_pairing_removes_only_its_own_entry() {
        let pairings = Pairings::default();
        let Join::Started { id: first, .. } = pairings.join("b1") else {
            panic!("started");
        };
        pairings.end("b1", first);
        let Join::Started { id: second, .. } = pairings.join("b1") else {
            panic!("a new pairing after the first ended");
        };
        pairings.end("b1", first);
        assert!(
            pairings.any(),
            "a stale end must not drop the newer pairing"
        );
        pairings.end("b1", second);
        assert!(!pairings.any());
    }
}
