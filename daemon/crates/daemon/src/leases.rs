//! Write leases: one writer per brick at a time, for exactly the length of one request.
//!
//! Reads never take a lease. A second writer is refused at once with `brick_busy` naming the
//! holder. The leased work runs on a task of its own that holds the lease until the work has
//! settled: a request the client cancels, or whose connection closes, cancels the work, and the
//! brick is free only once that work has ended, so a gone client's upload never interleaves with
//! the next writer. Stop and emergency stop never take a lease.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};

use ev3_contract::{ContractError, ErrorCode};
use tokio_util::sync::CancellationToken;

/// Who holds a lease.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeaseOwner {
    /// The connection the request came on.
    pub connection: u64,
    /// The client's name, as `brick_busy` reports it.
    pub name: String,
}

struct Held {
    owner: LeaseOwner,
    token: CancellationToken,
    seq: u64,
}

#[derive(Default)]
struct State {
    held: HashMap<String, Held>,
    next: u64,
    /// The daemon is about to end: no new write starts.
    closed: bool,
}

/// Every brick's write lease.
#[derive(Default)]
pub struct Leases {
    state: Mutex<State>,
}

/// One brick's lease, released when dropped.
pub struct Lease {
    leases: Arc<Leases>,
    brick_id: String,
    seq: u64,
    token: CancellationToken,
}

impl Lease {
    /// Cancelled when the request is cancelled, its client goes, or the daemon aborts it.
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut state = self.leases.lock();
        if state
            .held
            .get(&self.brick_id)
            .is_some_and(|held| held.seq == self.seq)
        {
            state.held.remove(&self.brick_id);
        }
    }
}

/// The refusal a second writer gets.
pub fn brick_busy(holder: &str) -> ContractError {
    let mut error = ContractError::new(
        ErrorCode::BrickBusy,
        format!("The brick is busy: {holder} is writing to it. Try again when it finishes."),
    );
    error.data.holder = Some(holder.to_owned());
    error
}

impl Leases {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("leases lock")
    }

    /// Who holds the brick's lease now.
    pub fn holder(&self, brick_id: &str) -> Option<String> {
        self.lock().held.get(brick_id).map(|h| h.owner.name.clone())
    }

    /// Whether any brick's lease is held: a write is in progress.
    pub fn busy(&self) -> bool {
        !self.lock().held.is_empty()
    }

    /// Every held lease's holder, by brick.
    pub fn snapshot(&self) -> BTreeMap<String, String> {
        self.lock()
            .held
            .iter()
            .map(|(brick, held)| (brick.clone(), held.owner.name.clone()))
            .collect()
    }

    /// Takes the brick's lease, or refuses with `brick_busy` naming the holder. The lease's token
    /// is a child of `caller`, so cancelling the request cancels the work.
    pub fn take(
        self: &Arc<Self>,
        brick_id: &str,
        owner: LeaseOwner,
        caller: &CancellationToken,
    ) -> Result<Lease, ContractError> {
        let mut state = self.lock();
        if state.closed {
            return Err(ContractError::new(
                ErrorCode::DaemonUnavailable,
                "The cockpit daemon is about to exit and starts no new write; connect again in a moment.",
            ));
        }
        if let Some(held) = state.held.get(brick_id) {
            return Err(brick_busy(&held.owner.name));
        }
        state.next += 1;
        let seq = state.next;
        let token = caller.child_token();
        state.held.insert(
            brick_id.to_owned(),
            Held {
                owner,
                token: token.clone(),
                seq,
            },
        );
        Ok(Lease {
            leases: self.clone(),
            brick_id: brick_id.to_owned(),
            seq,
            token,
        })
    }

    /// Runs `work` under the brick's lease, on a task of its own that keeps the lease until the
    /// work has settled, even when the caller stops waiting. The work gets the lease's token.
    pub async fn run<T, F>(
        self: &Arc<Self>,
        brick_id: &str,
        owner: LeaseOwner,
        caller: &CancellationToken,
        work: impl FnOnce(CancellationToken) -> F,
    ) -> Result<T, ContractError>
    where
        T: Send + 'static,
        F: Future<Output = Result<T, ContractError>> + Send + 'static,
    {
        let lease = self.take(brick_id, owner, caller)?;
        let running = work(lease.token().clone());
        tokio::spawn(async move {
            let outcome = running.await;
            drop(lease);
            outcome
        })
        .await
        .unwrap_or_else(|error| {
            Err(ContractError::new(
                ErrorCode::Internal,
                format!("The write ended without an answer ({error})."),
            ))
        })
    }

    /// A client left: whatever it writes is cancelled; each lease ends as its work settles.
    pub fn client_left(&self, connection: u64) {
        for held in self.lock().held.values() {
            if held.owner.connection == connection {
                held.token.cancel();
            }
        }
    }

    /// For a daemon about to end: refuses every later write, but only while no lease is held, in
    /// one step, so a write that starts meanwhile is never cut off by the exit. Returns whether the
    /// leases are closed now.
    pub fn close_if_idle(&self) -> bool {
        let mut state = self.lock();
        if state.held.is_empty() {
            state.closed = true;
        }
        state.closed
    }

    /// Cancels every leased write, for a daemon that is about to end.
    pub fn cancel_all(&self) {
        for held in self.lock().held.values() {
            held.token.cancel();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::oneshot;

    fn terminal() -> LeaseOwner {
        LeaseOwner {
            connection: 1,
            name: "ev3 c run (terminal)".into(),
        }
    }

    fn vscode() -> LeaseOwner {
        LeaseOwner {
            connection: 2,
            name: "VS Code".into(),
        }
    }

    #[tokio::test]
    async fn a_second_writer_gets_brick_busy_naming_the_first_while_other_bricks_stay_free() {
        let leases = Leases::new();
        let never = CancellationToken::new();
        let (release, upload) = oneshot::channel::<()>();
        let first = tokio::spawn({
            let (leases, never) = (leases.clone(), never.clone());
            async move {
                leases
                    .run("CCC", terminal(), &never, |_| async move {
                        let _ = upload.await;
                        Ok(())
                    })
                    .await
            }
        });
        tokio::task::yield_now().await;
        while leases.holder("CCC").is_none() {
            tokio::task::yield_now().await;
        }
        let error = leases
            .run("CCC", vscode(), &never, |_| async { Ok(()) })
            .await
            .expect_err("busy");
        assert_eq!(error.data.code, ErrorCode::BrickBusy);
        assert_eq!(error.data.holder.as_deref(), Some("ev3 c run (terminal)"));
        leases
            .run("BBB", vscode(), &never, |_| async { Ok(()) })
            .await
            .expect("another brick is free");
        assert_eq!(
            leases.holder("CCC").as_deref(),
            Some("ev3 c run (terminal)")
        );
        release.send(()).unwrap();
        first.await.unwrap().unwrap();
        assert_eq!(
            leases.holder("CCC"),
            None,
            "the lease ends with the request"
        );
        assert!(!leases.busy());
    }

    #[tokio::test]
    async fn a_cancelled_request_frees_the_brick_only_once_its_work_has_settled() {
        let leases = Leases::new();
        let request = CancellationToken::new();
        let (settle, settled) = oneshot::channel::<()>();
        let (seen_tx, seen) = oneshot::channel::<()>();
        // The caller stops waiting at once, as the connection does when its request is cancelled.
        let waiting = tokio::spawn({
            let (leases, request) = (leases.clone(), request.clone());
            async move {
                leases
                    .run("CCC", terminal(), &request, |token| async move {
                        token.cancelled().await;
                        let _ = seen_tx.send(());
                        let _ = settled.await;
                        Err::<(), _>(ContractError::new(ErrorCode::Cancelled, "aborted upload"))
                    })
                    .await
            }
        });
        while leases.holder("CCC").is_none() {
            tokio::task::yield_now().await;
        }
        request.cancel();
        waiting.abort();
        seen.await.expect("the work saw the cancel");
        tokio::time::sleep(Duration::from_millis(10)).await;
        let busy = leases
            .run("CCC", vscode(), &CancellationToken::new(), |_| async {
                Ok(())
            })
            .await
            .expect_err("still held while the aborted upload closes its slot");
        assert_eq!(busy.data.code, ErrorCode::BrickBusy);
        settle.send(()).unwrap();
        for _ in 0..100 {
            if !leases.busy() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        leases
            .run("CCC", vscode(), &CancellationToken::new(), |_| async {
                Ok(())
            })
            .await
            .expect("free once the work settled");
    }

    #[tokio::test]
    async fn closing_waits_for_the_held_lease_and_then_refuses_every_new_write() {
        let leases = Leases::new();
        let never = CancellationToken::new();
        let held = leases.take("CCC", terminal(), &never).expect("free");
        assert!(!leases.close_if_idle(), "a held lease keeps them open");
        leases
            .run("BBB", vscode(), &never, |_| async { Ok(()) })
            .await
            .expect("still open for other bricks");
        drop(held);
        assert!(leases.close_if_idle());
        let error = leases
            .run("CCC", vscode(), &never, |_| async { Ok(()) })
            .await
            .expect_err("closed");
        assert_eq!(error.data.code, ErrorCode::DaemonUnavailable);
    }

    #[tokio::test]
    async fn a_leaving_client_has_its_write_cancelled() {
        let leases = Leases::new();
        let outcome = tokio::spawn({
            let leases = leases.clone();
            async move {
                leases
                    .run(
                        "CCC",
                        terminal(),
                        &CancellationToken::new(),
                        |token| async move {
                            token.cancelled().await;
                            Err::<(), _>(ContractError::new(ErrorCode::Cancelled, "cancelled"))
                        },
                    )
                    .await
            }
        });
        while leases.holder("CCC").is_none() {
            tokio::task::yield_now().await;
        }
        leases.client_left(2);
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(leases.busy(), "another client's leaving cancels nothing");
        leases.client_left(1);
        let error = outcome.await.unwrap().expect_err("cancelled");
        assert_eq!(error.data.code, ErrorCode::Cancelled);
        assert!(!leases.busy());
    }
}
