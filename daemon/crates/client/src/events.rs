//! The daemon's notifications, typed, and the subscriptions built on them.
//!
//! - [`Events`] reads every notification the daemon sends to this client as the contract's
//!   [`Notification`], in the order the daemon sent them.
//! - [`ProgramStates`] follows one brick's program: the state when it was subscribed, then every
//!   change, in order, for that subscription alone. Its notifications are heard from before the
//!   subscribe request, so one the daemon sends before its answer is not lost; dropping it cancels
//!   the subscription.
//! - [`FileFollow`] follows a file on a brick as it grows, the same way.

use ev3_contract::{
    FileAppended, FileFollowEnded, FileFollowEndedReason, FileFollowSubscription,
    FilesFollowParams, Notification, ProgramState, ProgramStateChanged,
};
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

use crate::endpoint::Endpoint;

/// Resolves when the connection closed. The notification channel stays open while the client
/// lives, so a reader watches this beside it.
type Closed = std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>;

/// Every notification the daemon sends this client, typed.
pub struct Events {
    heard: broadcast::Receiver<(String, Value)>,
    closed: Closed,
    skipped: u64,
}

impl Events {
    pub(crate) fn new(endpoint: &Endpoint) -> Self {
        Self {
            heard: endpoint.notifications(),
            closed: Box::pin(endpoint.closed()),
            skipped: 0,
        }
    }

    /// The next notification; `None` once the connection closed. A notification this version of
    /// the contract does not know, or one that does not decode, is passed over. A reader that falls
    /// behind the daemon by more than the buffer loses the oldest ones and counts them in
    /// [`Events::skipped`]; the brick list comes whole in every `bricks/changed`, so the next one
    /// sets it right.
    pub async fn next(&mut self) -> Option<Notification> {
        loop {
            let heard = tokio::select! {
                heard = self.heard.recv() => heard,
                () = &mut self.closed => return None,
            };
            match heard {
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
        let closed = endpoint.closed();
        let forward = tokio::spawn({
            let id = id.clone();
            async move {
                tokio::pin!(closed);
                loop {
                    let next = tokio::select! {
                        next = heard.recv() => next,
                        () = &mut closed => return,
                    };
                    match next {
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

/// What a followed file says next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileEvent {
    /// The bytes the file grew by, from `offset` on: bytes, not text, so a character may be split
    /// between two.
    Appended { offset: u64, data: Vec<u8> },
    /// The follow ended without being cancelled, and why; nothing follows.
    Ended(FileFollowEndedReason),
}

/// A file on a brick followed as it grows: [`FileFollow::next`] hands over every growth in order,
/// then [`FileEvent::Ended`] if the daemon ends the follow. Dropping it cancels the follow.
pub struct FileFollow {
    /// Where the follow started.
    pub offset: u64,
    /// The file's size when the follow started.
    pub size: u64,
    /// The offset the bytes handed over so far reach.
    reached: u64,
    subscription_id: String,
    events: mpsc::UnboundedReceiver<FileEvent>,
    forward: JoinHandle<()>,
    endpoint: Endpoint,
}

impl FileFollow {
    /// Follows `path` on `brick` from `from_offset` (0 when `None`).
    pub(crate) async fn follow(
        endpoint: &Endpoint,
        brick: &str,
        path: &str,
        from_offset: Option<u64>,
    ) -> crate::Result<Self> {
        // Heard from before the request: the daemon may send bytes before its answer.
        let mut heard = endpoint.notifications();
        let params = FilesFollowParams {
            brick: Some(brick.to_owned()),
            path: path.to_owned(),
            from_offset,
        };
        let answer = endpoint
            .request(
                "files/follow",
                serde_json::to_value(params).unwrap_or_default(),
            )
            .await?;
        let followed: FileFollowSubscription = serde_json::from_value(answer).map_err(|error| {
            crate::ClientError::contract(
                "internal",
                format!("The daemon's answer to files/follow does not decode ({error})."),
            )
        })?;
        let id = followed.subscription_id.clone();
        let (sender, events) = mpsc::unbounded_channel();
        let closed = endpoint.closed();
        let forward = tokio::spawn({
            let id = id.clone();
            async move {
                tokio::pin!(closed);
                loop {
                    let next = tokio::select! {
                        next = heard.recv() => next,
                        () = &mut closed => return,
                    };
                    let event = match next {
                        Ok((method, params)) if method == "files/appended" => {
                            match serde_json::from_value::<FileAppended>(params) {
                                Ok(appended) if appended.subscription_id == id => {
                                    let Ok(data) =
                                        ev3_contract::base64::decode(&appended.data, "data")
                                    else {
                                        continue;
                                    };
                                    FileEvent::Appended {
                                        offset: appended.offset,
                                        data,
                                    }
                                }
                                _ => continue,
                            }
                        }
                        Ok((method, params)) if method == "files/followEnded" => {
                            match serde_json::from_value::<FileFollowEnded>(params) {
                                Ok(ended) if ended.subscription_id == id => {
                                    let _ = sender.send(FileEvent::Ended(ended.reason));
                                    return;
                                }
                                _ => continue,
                            }
                        }
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return,
                    };
                    if sender.send(event).is_err() {
                        return;
                    }
                }
            }
        });
        Ok(Self {
            offset: followed.offset,
            size: followed.size,
            reached: followed.offset,
            subscription_id: id,
            events,
            forward,
            endpoint: endpoint.clone(),
        })
    }

    /// The next growth, or the follow's end; `None` once the connection closed. Bytes the daemon
    /// sent again for an offset already reached are not handed over twice.
    pub async fn next(&mut self) -> Option<FileEvent> {
        loop {
            let event = self.events.recv().await?;
            if let FileEvent::Appended { offset, data } = &event {
                let end = offset + data.len() as u64;
                if end <= self.reached {
                    continue;
                }
                let skip = self.reached.saturating_sub(*offset) as usize;
                let (offset, data) = (offset + skip as u64, data[skip..].to_vec());
                self.reached = end;
                return Some(FileEvent::Appended { offset, data });
            }
            return Some(event);
        }
    }

    /// The offset the bytes handed over so far reach: where to follow again from.
    pub fn reached(&self) -> u64 {
        self.reached
    }

    /// The daemon's id of this follow.
    pub fn subscription_id(&self) -> &str {
        &self.subscription_id
    }
}

impl Drop for FileFollow {
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
