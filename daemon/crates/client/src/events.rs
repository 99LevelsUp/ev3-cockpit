//! The daemon's notifications, typed, and the subscriptions built on them.
//!
//! - [`Events`] reads every notification the daemon sends to this client as the contract's
//!   [`Notification`], in the order the daemon sent them.
//! - [`ProgramStates`] follows one brick's program: the state when it was subscribed, then every
//!   change, in order, for that subscription alone. Its notifications are heard from before the
//!   subscribe request, so one the daemon sends before its answer is not lost; dropping it cancels
//!   the subscription.

use ev3_contract::{Notification, ProgramState, ProgramStateChanged};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

use crate::endpoint::Endpoint;

/// Every notification the daemon sends this client, typed.
pub struct Events {
    heard: broadcast::Receiver<(String, Value)>,
    skipped: u64,
}

impl Events {
    pub(crate) fn new(heard: broadcast::Receiver<(String, Value)>) -> Self {
        Self { heard, skipped: 0 }
    }

    /// The next notification; `None` once the connection closed. A notification this version of
    /// the contract does not know, or one that does not decode, is passed over. A reader that falls
    /// behind the daemon by more than the buffer loses the oldest ones and counts them in
    /// [`Events::skipped`]; the brick list comes whole in every `bricks/changed`, so the next one
    /// sets it right.
    pub async fn next(&mut self) -> Option<Notification> {
        loop {
            match self.heard.recv().await {
                Ok((method, params)) => {
                    if let Some(Ok(notification)) = Notification::parse(&method, params) {
                        return Some(notification);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(lost)) => self.skipped += lost,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }

    /// How many notifications this reader lost by falling behind.
    pub fn skipped(&self) -> u64 {
        self.skipped
    }
}

/// One brick's program state: [`ProgramStates::state`] when it was subscribed, then
/// [`ProgramStates::next`] for every change, in order. Dropping it cancels the subscription.
pub struct ProgramStates {
    /// The state when the subscription was made.
    pub state: ProgramState,
    subscription_id: String,
    changes: mpsc::UnboundedReceiver<ProgramState>,
    forward: JoinHandle<()>,
    endpoint: Endpoint,
}

impl ProgramStates {
    /// Subscribes `brick`'s program state on `endpoint`.
    pub(crate) async fn subscribe(endpoint: &Endpoint, brick: &str) -> crate::Result<Self> {
        // Heard from before the request: the daemon may send a change before its answer.
        let mut heard = endpoint.notifications();
        let answer = endpoint
            .request("programs/subscribe", json!({ "brick": brick }))
            .await?;
        let subscribed: ev3_contract::ProgramSubscription = serde_json::from_value(answer)
            .map_err(|error| {
                crate::ClientError::contract(
                    "internal",
                    format!("The daemon's answer to programs/subscribe does not decode ({error})."),
                )
            })?;
        let id = subscribed.subscription_id.clone();
        let (sender, changes) = mpsc::unbounded_channel();
        let forward = tokio::spawn({
            let id = id.clone();
            async move {
                loop {
                    match heard.recv().await {
                        Ok((method, params)) if method == "programs/stateChanged" => {
                            let Ok(changed) = serde_json::from_value::<ProgramStateChanged>(params)
                            else {
                                continue;
                            };
                            if changed.subscription_id == id && sender.send(changed.state).is_err()
                            {
                                return;
                            }
                        }
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => return,
                    }
                }
            }
        });
        Ok(Self {
            state: subscribed.state,
            subscription_id: id,
            changes,
            forward,
            endpoint: endpoint.clone(),
        })
    }

    /// The next change of the program's state; `None` once the connection closed.
    pub async fn next(&mut self) -> Option<ProgramState> {
        self.changes.recv().await
    }

    /// The daemon's id of this subscription.
    pub fn subscription_id(&self) -> &str {
        &self.subscription_id
    }
}

impl Drop for ProgramStates {
    fn drop(&mut self) {
        self.forward.abort();
        if !self.endpoint.is_closed() {
            self.endpoint.send_and_forget(
                "subscriptions/cancel",
                json!({ "subscriptionId": self.subscription_id }),
            );
        }
    }
}
