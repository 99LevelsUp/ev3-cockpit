//! One FIFO per session: commands to a brick over one channel go out one at a time, in the
//! order they were sent.
//!
//! The exchange runs in the caller's own future, under a fair lock, rather than on a worker the
//! caller waits for. Dropping a provider's exchange future abandons the exchange, and the link
//! steps over what the abandoned exchange leaves behind; a worker would keep waiting on an
//! exchange its caller had given up, and hold every command behind it.
//!
//! A drain refuses everything still waiting, its turn or its admission, without sending it. A
//! command already on the wire is not called back: it fails by itself, on its own timeout.

use std::future::Future;

use ev3_transports::BrickKey;
use tokio::sync::{Mutex, watch};

use crate::error::SessionError;

/// Why waiting commands were refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrainReason {
    /// The link was lost and the session is reconnecting. Not held for the new link either: a
    /// motor command arriving late does harm.
    LinkLost,
    /// The session ended.
    Disconnected,
}

/// A session's command queue.
pub struct CommandQueue {
    brick_key: BrickKey,
    /// Fair: lock requests are granted in the order they were made, which is the FIFO.
    turn: Mutex<()>,
    /// The drain count and the last drain's reason. A command remembers the count it was sent
    /// under; any change refuses it.
    drained: watch::Sender<(u64, DrainReason)>,
}

impl CommandQueue {
    pub fn new(brick_key: BrickKey) -> Self {
        let (drained, _) = watch::channel((0, DrainReason::Disconnected));
        Self {
            brick_key,
            turn: Mutex::new(()),
            drained,
        }
    }

    /// The drain count now; a command is sent under the count read when it was sent.
    pub fn epoch(&self) -> u64 {
        self.drained.borrow().0
    }

    /// Refuses every command waiting now. Commands sent afterwards are not affected.
    pub fn drain(&self, reason: DrainReason) {
        self.drained.send_modify(|(epoch, why)| {
            *epoch += 1;
            *why = reason;
        });
    }

    fn refusal(&self, reason: DrainReason) -> SessionError {
        let brick_key = self.brick_key.clone();
        match reason {
            DrainReason::LinkLost => SessionError::LinkLost { brick_key },
            DrainReason::Disconnected => SessionError::Disconnected { brick_key },
        }
    }

    fn drained_since(&self, epoch: u64) -> Option<DrainReason> {
        let current = *self.drained.borrow();
        (current.0 != epoch).then_some(current.1)
    }

    /// Runs one command when its turn comes: waits for the commands before it, then for
    /// `admit` (the guard's slot), then runs `execute`.
    ///
    /// `epoch` is [`CommandQueue::epoch`] as read when the command was sent. A drain since then,
    /// before `execute` starts, refuses the command unsent. `admit` and `execute` are futures
    /// and do nothing until their turn: each command gets its own admission, never one a
    /// command before it was waiting for.
    pub async fn submit<T>(
        &self,
        epoch: u64,
        admit: impl Future<Output = Result<(), SessionError>>,
        execute: impl Future<Output = Result<T, SessionError>>,
    ) -> Result<T, SessionError> {
        let mut drained = self.drained.subscribe();
        let _turn = tokio::select! {
            biased;
            reason = wait_for_drain(&mut drained, epoch) => return Err(self.refusal(reason)),
            turn = self.turn.lock() => turn,
        };
        tokio::select! {
            biased;
            reason = wait_for_drain(&mut drained, epoch) => return Err(self.refusal(reason)),
            admitted = admit => admitted?,
        }
        if let Some(reason) = self.drained_since(epoch) {
            return Err(self.refusal(reason));
        }
        execute.await
    }
}

/// Resolves once the drain count differs from `epoch`, with the reason.
async fn wait_for_drain(
    drained: &mut watch::Receiver<(u64, DrainReason)>,
    epoch: u64,
) -> DrainReason {
    loop {
        let current = *drained.borrow_and_update();
        if current.0 != epoch {
            return current.1;
        }
        if drained.changed().await.is_err() {
            // The queue is gone; nothing will drain it.
            return std::future::pending().await;
        }
    }
}
