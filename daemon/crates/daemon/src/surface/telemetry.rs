//! Telemetry and the daisy chain: subscriptions with a snapshot first, each client's foreground
//! brick (the brick it shows, which `daemon/status` names and `daemon/showsChanged` announces), and
//! the chain as the read model sees it.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::{Arc, Mutex};

use ev3_contract::{
    ChainChanged, ChainSubscription, ClientStatus, ContractChain, ContractError, Notification,
    ShowsChanged, TelemetryForegroundParams, TelemetryRate, TelemetryRowList,
    TelemetrySubscribeParams, TelemetrySubscription, TelemetryUpdateKind, TelemetryValue,
};
use ev3_runtime::{ClaimRequest, DeliveryTarget, RowRate, chain_of};

use super::{Subscription, Surface, errors};
use crate::rpc::RequestContext;

/// A granted rate as the contract carries it: whole milliseconds, or once.
fn rate_of(rate: RowRate) -> TelemetryRate {
    match rate {
        RowRate::Every(ms) => TelemetryRate::Interval(ms.round().max(0.0) as u64),
        RowRate::Once => TelemetryRate::Once,
    }
}

/// Hears every chain change once, for every chain subscription: the read model's listeners
/// cannot be taken back, so the surface listens once and routes by brick.
pub(super) fn follow_chains(surface: &Arc<Surface>) {
    let weak = Arc::downgrade(surface);
    surface
        .runtime
        .read_model
        .listen_chain(Arc::new(move |brick_id: &str, depth| {
            let Some(surface) = weak.upgrade() else {
                return;
            };
            let chain = chain_of(brick_id, depth);
            let followers: Vec<(u64, String)> = surface
                .lock()
                .subscriptions
                .iter()
                .flat_map(|(connection, subs)| {
                    subs.iter().filter_map(move |(id, sub)| match sub {
                        Subscription::Chain { brick_id: b } if b == brick_id => {
                            Some((*connection, id.clone()))
                        }
                        _ => None,
                    })
                })
                .collect();
            for client in surface.shared.clients() {
                for (connection, id) in &followers {
                    if client.id == *connection {
                        let notification = Notification::ChainChanged(ChainChanged {
                            subscription_id: id.clone(),
                            chain: chain.clone(),
                        });
                        if let Ok(params) = notification.params() {
                            client.peer.notify(notification.method(), params);
                        }
                    }
                }
            }
        }));
}

impl Surface {
    pub fn telemetry_rows(&self) -> TelemetryRowList {
        TelemetryRowList {
            rows: self.runtime.telemetry.rows(),
        }
    }

    pub async fn telemetry_subscribe(
        self: &Arc<Self>,
        cx: &RequestContext,
        params: TelemetrySubscribeParams,
    ) -> Result<TelemetrySubscription, ContractError> {
        let brick_id = self.brick_of(cx, params.brick.as_deref()).await?;
        let request = params.request;
        let ticket = self
            .runtime
            .telemetry
            .claim(
                &brick_id,
                &ClaimRequest {
                    row_ids: request.rows.clone(),
                    interval_ms: request.interval_ms as f64,
                    modes: request.modes.clone(),
                },
                &cx.client.info.name,
            )
            .map_err(|e| errors::from_telemetry(&e))?;
        let id = super::new_id();
        let rows: BTreeSet<String> = request.rows.iter().cloned().collect();
        let row_list: Vec<String> = request.rows.clone();
        let snapshot: Arc<Mutex<Vec<TelemetryValue>>> = Arc::new(Mutex::new(Vec::new()));
        // The first snapshot is in the answer; the delivery's own copy of it is not sent again.
        let answered = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let client = cx.client.clone();
        let weak = Arc::downgrade(self);
        let (ended_connection, ended_id) = (cx.client.id, id.clone());
        let delivery = self.runtime.delivery.open(
            DeliveryTarget {
                subscription_id: id.clone(),
                brick_id: brick_id.clone(),
                handle: ticket.handle.clone(),
                rows,
                listener: Arc::new(move |update| {
                    if update.kind == TelemetryUpdateKind::Snapshot
                        && !answered.swap(true, std::sync::atomic::Ordering::SeqCst)
                    {
                        return;
                    }
                    let notification = Notification::TelemetryUpdate(update);
                    if let Ok(params) = notification.params() {
                        client.peer.notify(notification.method(), params);
                    }
                }),
                owner: cx.client.info.name.clone(),
                on_ended: Arc::new(move || {
                    if let Some(surface) = weak.upgrade()
                        && let Some(subs) = surface.lock().subscriptions.get_mut(&ended_connection)
                    {
                        subs.remove(&ended_id);
                    }
                }),
            },
            {
                let (snapshot, read_model, brick) = (
                    snapshot.clone(),
                    self.runtime.read_model.clone(),
                    brick_id.clone(),
                );
                move || {
                    let values: Vec<TelemetryValue> = read_model
                        .snapshot(&brick, Some(&row_list))
                        .iter()
                        .map(ev3_runtime::telemetry::ReadValue::to_contract)
                        .collect();
                    *snapshot.lock().expect("snapshot lock") = values.clone();
                    values
                }
            },
        );
        self.lock()
            .subscriptions
            .entry(cx.client.id)
            .or_default()
            .insert(
                id.clone(),
                Subscription::Telemetry {
                    delivery,
                    claim: ticket.handle.clone(),
                },
            );
        let grant: BTreeMap<String, TelemetryRate> = ticket
            .grant
            .iter()
            .map(|(row, rate)| (row.clone(), rate_of(*rate)))
            .collect();
        let snapshot = snapshot.lock().expect("snapshot lock").clone();
        Ok(TelemetrySubscription {
            subscription_id: id,
            brick_id,
            grant,
            snapshot,
        })
    }

    pub async fn telemetry_foreground(
        &self,
        cx: &RequestContext,
        params: TelemetryForegroundParams,
    ) -> Result<(), ContractError> {
        let changed = match params.brick {
            None => self.lock().foreground.remove(&cx.client.id).is_some(),
            Some(brick) => {
                let brick_id = self.brick_of(cx, Some(&brick)).await?;
                let before = self
                    .lock()
                    .foreground
                    .insert(cx.client.id, brick_id.clone());
                before.as_deref() != Some(brick_id.as_str())
            }
        };
        self.apply_foreground();
        if changed {
            self.shows_changed();
        }
        Ok(())
    }

    /// Every connected client as `daemon/status` names it, with the brick each shows.
    pub fn client_status(&self) -> Vec<ClientStatus> {
        let foreground = self.lock().foreground.clone();
        self.shared
            .clients()
            .iter()
            .map(|client| ClientStatus {
                name: client.info.name.clone(),
                kind: client.info.kind,
                version: client.info.version.clone(),
                build_kind: client.info.build_kind,
                shows: foreground.get(&client.id).cloned(),
            })
            .collect()
    }

    /// Tells every client that the brick a client shows changed. The list is read and sent under
    /// one lock, so two changes close together reach every client in the order of their lists and
    /// the last list a client hears is the current one.
    pub(super) fn shows_changed(&self) {
        let _order = self.shows_order.lock().expect("shows lock");
        self.shared
            .broadcast(&Notification::DaemonShowsChanged(ShowsChanged {
                clients: self.client_status(),
            }));
    }

    /// Reads every brick a client shows in the foreground.
    pub(super) fn apply_foreground(&self) {
        let bricks: HashSet<String> = self.lock().foreground.values().cloned().collect();
        self.runtime.telemetry.set_foreground_bricks(Some(bricks));
    }

    pub async fn chain_get(
        &self,
        cx: &RequestContext,
        brick: Option<String>,
    ) -> Result<ContractChain, ContractError> {
        let brick_id = self.brick_of(cx, brick.as_deref()).await?;
        Ok(chain_of(
            &brick_id,
            self.runtime.read_model.chain_depth(&brick_id),
        ))
    }

    pub async fn chain_follow(
        &self,
        cx: &RequestContext,
        brick: Option<String>,
    ) -> Result<ChainSubscription, ContractError> {
        let brick_id = self.brick_of(cx, brick.as_deref()).await?;
        let id = self.subscribe(
            cx.client.id,
            Subscription::Chain {
                brick_id: brick_id.clone(),
            },
        );
        Ok(ChainSubscription {
            subscription_id: id,
            chain: chain_of(&brick_id, self.runtime.read_model.chain_depth(&brick_id)),
        })
    }
}
