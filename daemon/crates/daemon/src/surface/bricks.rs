//! The brick methods: the list, connecting and disconnecting with holders, the brick's name and
//! storage, pairing, forgetting and clearing its Bluetooth list, and an inquiry.

use std::sync::Arc;

use ev3_contract::{
    BrickInfo, BrickList, BricksConnectParams, BricksDisconnectParams, BricksDisconnectResult,
    BricksListParams, ClearListResult, ClearedEntry, ContractBrick, ContractError, ErrorCode,
    ForgetResult, PairingResult, StorageUsage,
};
use ev3_protocol::{BrickCommand, BrickResponse};
use ev3_runtime::{BrickFilesystem, ChannelState, CommandOptions, ForgetReport};
use ev3_transports::Transport;

use super::{DISCOVERY_WAIT, Surface, errors, requester_of};
use crate::holders::{Holder, holder_name};
use crate::log::Level;
use crate::rpc::RequestContext;

/// The forget report as lines ready to show.
fn forget_lines(report: &ForgetReport) -> Vec<String> {
    let contract = report.to_contract();
    let mut lines = vec![format!(
        "On the brick: {}",
        serde_json::to_string(&contract.brick_side).unwrap_or_default()
    )];
    for pairing in &contract.pairing {
        lines.push(match pairing {
            ev3_contract::PairingRemoval::Removed { channel } => {
                format!("Pairing removed: {channel}")
            }
            ev3_contract::PairingRemoval::Refused { channel, reason } => {
                format!("Pairing refused: {channel}: {reason}")
            }
        });
    }
    lines.push("Remembered bricks: cleared".into());
    for residue in &contract.residue {
        lines.push(format!(
            "Left behind: {}",
            serde_json::to_string(residue).unwrap_or_default()
        ));
    }
    lines
}

impl Surface {
    pub async fn bricks_list(&self, params: BricksListParams) -> BrickList {
        if params.wait_for_discovery == Some(true) {
            self.runtime.discovery_settled(DISCOVERY_WAIT).await;
        }
        BrickList {
            bricks: self.bricks(),
        }
    }

    pub async fn bricks_connect(
        self: &Arc<Self>,
        cx: &RequestContext,
        params: BricksConnectParams,
    ) -> Result<ContractBrick, ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        let hold = params.hold == Some(true);
        let holder = if hold {
            Holder::Hold
        } else {
            Holder::Client {
                connection: cx.client.id,
                name: cx.client.info.name.clone(),
            }
        };
        // The person asked for this brick: a suspended check may run again, and the Bluetooth
        // joins this connect starts wait for it.
        self.runtime.check.connect_requested(&brick_id);
        *self.lock().connecting.entry(brick_id.clone()).or_default() += 1;
        let surface = self.clone();
        // Cancelled before the connection's teardown runs: a client that left is known gone here
        // before its holds are dropped, never after.
        let gone = cx.cancel.clone();
        let brick = brick_id.clone();
        // On a task of its own: a client that goes away mid-connect leaves no brick connected
        // with no holder, whatever await the request was dropped at.
        let connected = tokio::spawn(async move {
            let outcome = surface.connect_now(&brick).await;
            let outcome = match outcome {
                Ok(()) => {
                    // Under the surface's lock, which the client's teardown takes to drop its
                    // holds: either the holder lands first and goes with them, or the teardown
                    // ran first and its cancel is seen here.
                    let mut state = surface.lock();
                    if !hold && gone.is_cancelled() {
                        state.orphaned.insert(brick.clone());
                        Err(ContractError::new(
                            ErrorCode::Cancelled,
                            "The client went away while its brick was being connected.",
                        ))
                    } else {
                        surface
                            .holders
                            .add(&brick, holder)
                            .map_err(|e| ContractError::new(ErrorCode::Internal, e))
                    }
                }
                Err(error) => Err(error),
            };
            surface.holders_changed();
            let release = {
                let mut state = surface.lock();
                let left = state.connecting.get(&brick).copied().unwrap_or(1) - 1;
                if left > 0 {
                    state.connecting.insert(brick.clone(), left);
                } else {
                    state.connecting.remove(&brick);
                }
                // The last connect of the brick has ended, failed or not: one a gone client left
                // behind is signed out unless somebody holds it now.
                left == 0 && state.orphaned.remove(&brick) && !surface.holders.is_held(&brick)
            };
            if release {
                surface.runtime.bricks.sign_out(&brick).await;
            }
            outcome
        })
        .await
        .unwrap_or_else(|e| {
            Err(ContractError::new(
                ErrorCode::Internal,
                format!("The connect ended without an answer ({e})."),
            ))
        });
        connected?;
        self.shared.log.write(
            Level::Info,
            Some(&cx.client.info.name),
            &format!(
                "Connected {brick_id}{}",
                if hold { " and held" } else { "" }
            ),
        );
        let entry = self.runtime.list.brick(&brick_id).ok_or_else(|| {
            ContractError::new(
                ErrorCode::NotConnected,
                format!("Brick {brick_id} went away."),
            )
        })?;
        Ok(self.to_brick(&entry))
    }

    /// Connects a brick: every channel not connected yet when it is signed in already, else signs
    /// it in, pairing first a brick only an inquiry has heard.
    async fn connect_now(self: &Arc<Self>, brick_id: &str) -> Result<(), ContractError> {
        let bricks = &self.runtime.bricks;
        if bricks.is_signed_in(brick_id) {
            return bricks
                .connect_again(brick_id)
                .await
                .map_err(|e| errors::from_brick(&e));
        }
        // A brick only an inquiry has heard has nothing to connect over until it is paired; a
        // channel still listed as lost (a cable pulled since) does not count.
        if let Some(entry) = self.runtime.list.brick(brick_id) {
            let bt_only = entry.channels.iter().any(|c| c.transport == Transport::Bt)
                && entry.channels.iter().all(|c| {
                    c.transport == Transport::Bt
                        || matches!(c.state, ChannelState::Lost | ChannelState::Absent)
                });
            if !entry.paired && bt_only {
                let paired = self.pair_brick(brick_id).await;
                if paired.outcome != ev3_contract::PairingOutcome::Paired {
                    return Err(ContractError::new(
                        ErrorCode::NotConnected,
                        format!(
                            "Could not pair {}: {}.",
                            entry.name.value,
                            paired.message.as_deref().unwrap_or("no reason given")
                        ),
                    ));
                }
            }
        }
        bricks
            .sign_in(brick_id)
            .await
            .map_err(|e| errors::from_brick(&e))
    }

    pub async fn bricks_disconnect(
        self: &Arc<Self>,
        cx: &RequestContext,
        params: BricksDisconnectParams,
    ) -> Result<BricksDisconnectResult, ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        let sign_out = if params.for_everyone == Some(true) {
            self.holders.drop_all(&brick_id);
            true
        } else if params.release_hold == Some(true) {
            self.holders.drop_holder(&brick_id, &Holder::Hold)
        } else {
            self.holders.drop_holder(
                &brick_id,
                &Holder::Client {
                    connection: cx.client.id,
                    name: cx.client.info.name.clone(),
                },
            )
        };
        self.holders_changed();
        if sign_out {
            self.runtime.bricks.sign_out(&brick_id).await;
            self.lock().reconnecting.remove(&brick_id);
        }
        self.shared.log.write(
            Level::Info,
            Some(&cx.client.info.name),
            &format!(
                "Disconnect {brick_id}{}",
                if params.for_everyone == Some(true) {
                    " for everyone"
                } else {
                    ""
                }
            ),
        );
        Ok(BricksDisconnectResult {
            still_held_by: self
                .holders
                .holders_of(&brick_id)
                .iter()
                .map(holder_name)
                .collect(),
        })
    }

    pub async fn bricks_info(
        &self,
        cx: &RequestContext,
        brick: Option<String>,
    ) -> Result<BrickInfo, ContractError> {
        let brick_id = self.brick_of(cx, brick.as_deref()).await?;
        match self
            .runtime
            .bricks
            .send(&brick_id, &BrickCommand::Info, CommandOptions::default())
            .await
        {
            Ok(BrickResponse::Info {
                display_name,
                firmware_version,
                os_version,
            }) => Ok(BrickInfo {
                brick_id,
                name: display_name,
                firmware_version,
                os_version,
            }),
            Ok(other) => Err(ContractError::new(
                ErrorCode::ProtocolFailed,
                format!("Expected the brick's info, got {other:?}."),
            )),
            Err(error) => Err(errors::from_brick(&error)),
        }
    }

    pub async fn bricks_storage(
        &self,
        cx: &RequestContext,
        brick: Option<String>,
    ) -> Result<StorageUsage, ContractError> {
        let brick_id = self.brick_of(cx, brick.as_deref()).await?;
        let fs = self.filesystem(cx, &brick_id);
        let usage = fs.files.storage().await.map_err(|e| errors::from_fs(&e))?;
        Ok(StorageUsage {
            free_kb: u64::from(usage.free_kb),
            total_kb: u64::from(usage.total_kb),
        })
    }

    /// The brick's files for a request of `cx`'s client.
    pub(super) fn filesystem(&self, cx: &RequestContext, brick_id: &str) -> BrickFilesystem {
        BrickFilesystem::new(
            &self.runtime.bricks,
            brick_id,
            &self.runtime.ledgers,
            self.writes(&cx.client),
            CommandOptions::default(),
        )
    }

    pub async fn bricks_pair(
        self: &Arc<Self>,
        cx: &RequestContext,
        brick: Option<String>,
    ) -> Result<PairingResult, ContractError> {
        let brick_id = self.brick_of(cx, brick.as_deref()).await?;
        // The person asked for this pairing: a check suspended by an earlier one may run again.
        self.runtime.check.connect_requested(&brick_id);
        Ok(self.pair_brick(&brick_id).await)
    }

    fn label(&self, brick_id: &str) -> String {
        self.runtime
            .list
            .brick(brick_id)
            .map_or_else(|| brick_id.to_owned(), |entry| entry.name.value)
    }

    pub async fn bricks_forget(
        self: &Arc<Self>,
        cx: &RequestContext,
        brick: Option<String>,
    ) -> Result<ForgetResult, ContractError> {
        let brick_id = self.brick_of(cx, brick.as_deref()).await?;
        let name = self.label(&brick_id);
        let requester = requester_of(&cx.client);
        let surface = self.clone();
        let brick = brick_id.clone();
        let report = self
            .leased(cx, &brick_id, move |_| async move {
                surface.settle_pairings(&brick).await;
                surface
                    .runtime
                    .forget
                    .forget(&brick, &requester)
                    .await
                    .map_err(|refused| {
                        errors::from_refused(
                            &refused,
                            &format!("ev3 forget {name}"),
                            &format!("Forgetting {name}"),
                        )
                    })
            })
            .await?;
        self.holders.forget(&brick_id);
        self.lock().reconnecting.remove(&brick_id);
        if let Some(program) = self.lock().programs.remove(&brick_id) {
            program.dispose();
        }
        self.holders_changed();
        self.shared.log.write(
            Level::Info,
            Some(&cx.client.info.name),
            &format!("Forgot {brick_id}."),
        );
        Ok(ForgetResult {
            forgotten: true,
            lines: forget_lines(&report),
            report: Some(report.to_contract()),
        })
    }

    pub async fn bricks_clear_bluetooth_list(
        self: &Arc<Self>,
        cx: &RequestContext,
        brick: Option<String>,
    ) -> Result<ClearListResult, ContractError> {
        let brick_id = self.brick_of(cx, brick.as_deref()).await?;
        let name = self.label(&brick_id);
        let requester = requester_of(&cx.client);
        let surface = self.clone();
        let brick = brick_id.clone();
        let report = self
            .leased(cx, &brick_id, move |_| async move {
                surface.settle_pairings(&brick).await;
                surface
                    .runtime
                    .forget
                    .clear_bluetooth_list(&brick, &requester)
                    .await
                    .map_err(|refused| {
                        errors::from_refused(
                            &refused,
                            &format!("ev3 bt-clear {name}"),
                            &format!("Clearing {name}'s Bluetooth list"),
                        )
                    })
            })
            .await?;
        self.bricks_changed();
        let report = report.to_contract();
        let mut removed = Vec::new();
        let mut kept = Vec::new();
        for entry in &report.entries {
            match entry {
                ClearedEntry::Confirmed { name } | ClearedEntry::Sent { name, .. } => {
                    removed.push(name.clone());
                }
                ClearedEntry::Failed { name, .. } | ClearedEntry::NotRemovable { name, .. } => {
                    kept.push(name.clone());
                }
            }
        }
        kept.extend(report.left.iter().cloned());
        Ok(ClearListResult {
            removed,
            kept,
            report: Some(report),
        })
    }

    pub async fn bricks_inquiry(&self) {
        self.runtime.bluetooth.run_inquiry().await;
    }
}
