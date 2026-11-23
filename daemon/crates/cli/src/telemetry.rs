//! Telemetry on demand, for `ev3 telemetry` and the MCP server: one reading, or changes until the
//! caller stops. Each runs on a subscription of its own that ends with it, so a brick is read only
//! while someone asks; connecting a brick never starts telemetry.
//!
//! The subscription ends however its reading ends: when the reading finishes, when its caller is
//! dropped (a cancelled tool call), and when the connection closes (the daemon cancels a closed
//! connection's subscriptions itself).

use std::collections::BTreeMap;
use std::future::Future;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::broadcast;

use crate::endpoint::Endpoint;
use crate::error::{CliError, Result};
use crate::output::js_number;

/// How often rows are read while a reading or a watch runs.
pub const ON_DEMAND_INTERVAL_MS: u64 = 1000;

/// The rows asked for, or every row the daemon offers when none are named.
async fn rows_of(endpoint: &Endpoint, rows: &[String]) -> Result<Vec<String>> {
    if !rows.is_empty() {
        return Ok(rows.to_vec());
    }
    let all = endpoint.request("telemetry/rows", json!({})).await?;
    Ok(all
        .get("rows")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect())
}

/// One open subscription: its first values and the updates that follow. Dropping it without
/// [`Subscription::cancel`] still cancels it on the daemon.
struct Subscription<'a> {
    endpoint: &'a Endpoint,
    id: String,
    brick_id: String,
    snapshot: Vec<Value>,
    heard: broadcast::Receiver<(String, Value)>,
    cancelled: bool,
}

impl Subscription<'_> {
    /// The next update for this subscription, or `None` when the connection closed.
    async fn next(&mut self) -> Option<Value> {
        let closed = self.endpoint.closed();
        tokio::pin!(closed);
        loop {
            tokio::select! {
                // Updates the daemon sent before it went are read first: the reader queues every
                // message before it marks the connection closed.
                biased;
                heard = self.heard.recv() => match heard {
                    Ok((method, params)) => {
                        if method == "telemetry/update"
                            && params.get("subscriptionId").and_then(Value::as_str)
                                == Some(self.id.as_str())
                        {
                            return Some(params);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => return None,
                },
                () = &mut closed => return None,
            }
        }
    }

    async fn cancel(mut self) {
        self.cancelled = true;
        let _ = self
            .endpoint
            .request("subscriptions/cancel", json!({ "subscriptionId": self.id }))
            .await;
    }
}

impl Drop for Subscription<'_> {
    fn drop(&mut self) {
        if !self.cancelled && !self.id.is_empty() {
            self.endpoint
                .send_and_forget("subscriptions/cancel", json!({ "subscriptionId": self.id }));
        }
    }
}

async fn subscribe<'a>(
    endpoint: &'a Endpoint,
    brick: &str,
    rows: &[String],
) -> Result<Subscription<'a>> {
    // Heard from before the request: the daemon may send an update before its answer.
    let heard = endpoint.notifications();
    let result = endpoint
        .request(
            "telemetry/subscribe",
            json!({ "brick": brick, "request": { "rows": rows, "intervalMs": ON_DEMAND_INTERVAL_MS } }),
        )
        .await?;
    let text = |key: &str| {
        result
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    Ok(Subscription {
        endpoint,
        id: text("subscriptionId"),
        brick_id: text("brickId"),
        snapshot: result
            .get("snapshot")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        heard,
        cancelled: false,
    })
}

fn has_value(value: &Value) -> bool {
    value.get("value").is_some_and(|v| !v.is_null())
}

fn row_of(value: &Value) -> String {
    value
        .get("rowId")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn values_of(update: &Value) -> Vec<Value> {
    update
        .get("values")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|v| has_value(v))
        .cloned()
        .collect()
}

fn ended(update: &Value) -> bool {
    update.get("kind").and_then(Value::as_str) == Some("ended")
}

/// A port's type code from its occupancy row, as `port_state.rs` of the daemon reads it: below
/// 124 a device whose value is read; 125 a device still being identified, a second or two after
/// it is plugged in; 124, 126, 127 and above nothing whose value will come.
const TYPE_TERMINAL: u64 = 124;
const TYPE_UNKNOWN: u64 = 125;

/// Whether `row` can get no value as the brick is now, by what `latest` says: the value of a
/// port its occupancy shows empty or unreadable, or a row of a daisy-chain layer deeper than the
/// chain. The daemon opens such rows only when that changes, so a reading need not wait for them.
fn cannot_come(row: &str, latest: &BTreeMap<String, Value>) -> bool {
    let number = |id: &str| {
        latest
            .get(id)
            .and_then(|v| v.get("value"))
            .and_then(Value::as_u64)
    };
    if let Some(rest) = row.strip_prefix("chain.")
        && let Some(layer) = rest.split('.').next().and_then(|l| l.parse::<u64>().ok())
        && layer > 0
        && number("chain.depth").is_some_and(|depth| depth < layer)
    {
        return true;
    }
    if let Some(port) = row.strip_suffix(".value")
        && let Some(code) = number(&format!("{port}.occupancy"))
    {
        return code >= TYPE_TERMINAL && code != TYPE_UNKNOWN;
    }
    false
}

/// Reads `rows` (every row when empty) of a connected brick once: the latest value of each row,
/// ending as soon as every row has one or cannot get one ([`cannot_come`]), after `wait`, or when
/// the connection closes. Answers `{brickId, values, missing, unavailable}`: `missing` had no
/// value yet, `unavailable` cannot have one as the brick is now.
pub async fn read_once(
    endpoint: &Endpoint,
    brick: &str,
    rows: &[String],
    wait: Duration,
) -> Result<Value> {
    let wanted = rows_of(endpoint, rows).await?;
    let mut subscription = subscribe(endpoint, brick, &wanted).await?;
    let mut brick_id = subscription.brick_id.clone();
    if brick_id.is_empty() {
        brick_id = brick.to_owned();
    }
    let mut latest: BTreeMap<String, Value> = BTreeMap::new();
    for value in subscription.snapshot.iter().filter(|v| has_value(v)) {
        latest.insert(row_of(value), value.clone());
    }
    let complete = |latest: &BTreeMap<String, Value>| {
        wanted
            .iter()
            .all(|row| latest.contains_key(row) || cannot_come(row, latest))
    };
    if !complete(&latest) {
        let _ = tokio::time::timeout(wait, async {
            while let Some(update) = subscription.next().await {
                if let Some(id) = update.get("brickId").and_then(Value::as_str) {
                    brick_id = id.to_owned();
                }
                for value in values_of(&update) {
                    latest.insert(row_of(&value), value);
                }
                if ended(&update) || complete(&latest) {
                    break;
                }
            }
        })
        .await;
    }
    subscription.cancel().await;
    let values: Vec<Value> = wanted
        .iter()
        .filter_map(|row| latest.get(row).cloned())
        .collect();
    let (unavailable, missing): (Vec<&String>, Vec<&String>) = wanted
        .iter()
        .filter(|row| !latest.contains_key(*row))
        .partition(|row| cannot_come(row, &latest));
    Ok(json!({
        "brickId": brick_id, "values": values, "missing": missing, "unavailable": unavailable,
    }))
}
/// Hears `rows` (every row when empty) until `stop` resolves or the daemon ends the subscription,
/// handing each change to `on_values`, which answers `false` to stop (nobody reads the output any
/// more). Resolves with how many updates came; fails when the connection closes first, since the
/// daemon went.
pub async fn watch(
    endpoint: &Endpoint,
    brick: &str,
    rows: &[String],
    stop: impl Future<Output = ()>,
    mut on_values: impl FnMut(&[Value]) -> bool,
) -> Result<u64> {
    let wanted = rows_of(endpoint, rows).await?;
    let mut subscription = subscribe(endpoint, brick, &wanted).await?;
    let mut updates = 0u64;
    let mut heard = true;
    let first: Vec<Value> = subscription
        .snapshot
        .iter()
        .filter(|v| has_value(v))
        .cloned()
        .collect();
    if !first.is_empty() {
        updates += 1;
        heard = on_values(&first);
    }
    tokio::pin!(stop);
    while heard {
        tokio::select! {
            () = &mut stop => break,
            update = subscription.next() => {
                let Some(update) = update else {
                    return Err(CliError::unavailable(
                        "The connection to the cockpit daemon closed while telemetry was being watched.",
                    ));
                };
                if ended(&update) { break; }
                let values = values_of(&update);
                if values.is_empty() { continue; }
                updates += 1;
                heard = on_values(&values);
            }
        }
    }
    subscription.cancel().await;
    Ok(updates)
}

/// A value as a person reads it: `system.battery.voltage = 7.9 V`.
pub fn value_line(value: &Value) -> String {
    let shown = match value.get("value") {
        Some(Value::Number(n)) => {
            let v = n.as_f64().unwrap_or(0.0);
            js_number((v * 1000.0).round() / 1000.0)
        }
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => "undefined".into(),
    };
    let unit = value
        .get("unit")
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty())
        .map(|u| format!(" {u}"))
        .unwrap_or_default();
    let stale = if value.get("stale").and_then(Value::as_bool) == Some(true) {
        " (stale)"
    } else {
        ""
    };
    format!("{} = {shown}{unit}{stale}", row_of(value))
}

/// A row as a person reads it: `system.battery.voltage (V)`, `motor.speed (%), port A`.
pub fn row_line(row: &Value) -> String {
    let unit = row
        .get("unit")
        .and_then(Value::as_str)
        .filter(|u| !u.is_empty());
    let port = row
        .get("port")
        .filter(|p| !p.is_null())
        .map(crate::output::js_string)
        .filter(|p| !p.is_empty());
    format!(
        "{}{}{}",
        row.get("id").and_then(Value::as_str).unwrap_or(""),
        unit.map(|u| format!(" ({u})")).unwrap_or_default(),
        port.map(|p| format!(", port {p}")).unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::endpoint::Duplex;
    use ev3_channel::codec::JsonRpcCodec;
    use futures_util::{SinkExt, StreamExt};
    use std::sync::{Arc, Mutex};
    use tokio_util::codec::Framed;

    /// A daemon that answers telemetry/rows, telemetry/subscribe and subscriptions/cancel, sends
    /// `updates` after the subscribe answer, and records every request it was sent. With `hang_up`
    /// it closes the connection after the updates.
    fn scripted_daemon(updates: Vec<Value>, hang_up: bool) -> (Endpoint, Arc<Mutex<Vec<Value>>>) {
        scripted_daemon_with(
            &["a", "b"],
            json!([{ "rowId": "a", "value": 1 }]),
            updates,
            hang_up,
        )
    }

    /// As [`scripted_daemon`], with the rows the daemon lists and the snapshot it answers.
    fn scripted_daemon_with(
        rows: &[&str],
        snapshot: Value,
        updates: Vec<Value>,
        hang_up: bool,
    ) -> (Endpoint, Arc<Mutex<Vec<Value>>>) {
        let rows: Vec<Value> = rows.iter().map(|id| json!({ "id": id })).collect();
        let (ours, theirs) = tokio::io::duplex(64 * 1024);
        let endpoint = Endpoint::new(Box::new(ours) as Box<dyn Duplex>, None);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        tokio::spawn(async move {
            let (mut sink, mut source) = Framed::new(theirs, JsonRpcCodec::default()).split();
            while let Some(Ok(request)) = source.next().await {
                log.lock().expect("log").push(request.clone());
                let result = match request["method"].as_str() {
                    Some("telemetry/rows") => json!({ "rows": rows }),
                    Some("telemetry/subscribe") => json!({
                        "subscriptionId": "s1", "brickId": "usb:x", "grant": {},
                        "snapshot": snapshot,
                    }),
                    _ => Value::Null,
                };
                let subscribed = request["method"] == "telemetry/subscribe";
                let _ = sink
                    .send(json!({ "jsonrpc": "2.0", "id": request["id"], "result": result }))
                    .await;
                if subscribed {
                    for update in &updates {
                        let _ = sink
                            .send(json!({ "jsonrpc": "2.0", "method": "telemetry/update", "params": update }))
                            .await;
                    }
                    if hang_up {
                        return;
                    }
                }
            }
        });
        (endpoint, seen)
    }

    fn methods(seen: &Arc<Mutex<Vec<Value>>>) -> Vec<String> {
        seen.lock()
            .expect("log")
            .iter()
            .filter_map(|r| r["method"].as_str().map(str::to_owned))
            .collect()
    }

    #[tokio::test]
    async fn a_reading_ends_when_every_row_has_a_value_and_cancels_its_subscription() {
        let update = json!({ "subscriptionId": "s1", "brickId": "usb:x", "kind": "delta",
            "values": [{ "rowId": "b", "value": 2, "unit": "V" }] });
        let (endpoint, seen) = scripted_daemon(vec![update], false);
        let reading = read_once(&endpoint, "CCC", &[], Duration::from_secs(5))
            .await
            .expect("read");
        assert_eq!(reading["missing"], json!([]));
        assert_eq!(reading["values"].as_array().expect("values").len(), 2);
        assert!(methods(&seen).contains(&"subscriptions/cancel".to_owned()));
    }

    #[test]
    fn a_row_cannot_come_from_an_empty_port_or_a_chain_layer_deeper_than_the_chain() {
        let latest: BTreeMap<String, Value> = [
            ("ports.sensor.1.occupancy", 126),
            ("ports.sensor.2.occupancy", 125),
            ("ports.sensor.3.occupancy", 29),
            ("ports.motor.A.occupancy", 127),
            ("chain.depth", 1),
        ]
        .into_iter()
        .map(|(id, value)| (id.to_owned(), json!({ "rowId": id, "value": value })))
        .collect();
        assert!(cannot_come("ports.sensor.1.value", &latest), "empty");
        assert!(
            !cannot_come("ports.sensor.2.value", &latest),
            "still identifying"
        );
        assert!(!cannot_come("ports.sensor.3.value", &latest), "a device");
        assert!(
            !cannot_come("ports.sensor.4.value", &latest),
            "nothing reported yet"
        );
        assert!(
            !cannot_come("chain.1.sensor.1.occupancy", &latest),
            "layer 1 of depth 1"
        );
        assert!(
            cannot_come("chain.2.sensor.1.occupancy", &latest),
            "layer 2 of depth 1"
        );
        assert!(!cannot_come("system.battery.voltage", &latest));
    }

    #[tokio::test]
    async fn a_reading_does_not_wait_for_rows_the_brick_cannot_have_now() {
        let rows = [
            "ports.sensor.1.occupancy",
            "ports.sensor.1.value",
            "chain.depth",
            "chain.1.sensor.1.value",
        ];
        let snapshot = json!([
            { "rowId": "ports.sensor.1.occupancy", "value": 126 },
            { "rowId": "chain.depth", "value": 0 },
        ]);
        let (endpoint, _seen) = scripted_daemon_with(&rows, snapshot, Vec::new(), false);
        let started = tokio::time::Instant::now();
        let reading = read_once(&endpoint, "CCC", &[], Duration::from_secs(30))
            .await
            .expect("read");
        assert!(started.elapsed() < Duration::from_secs(5), "it waited");
        assert_eq!(reading["missing"], json!([]));
        assert_eq!(
            reading["unavailable"],
            json!(["ports.sensor.1.value", "chain.1.sensor.1.value"])
        );
    }

    #[tokio::test]
    async fn rows_without_a_value_in_time_are_listed_as_missing() {
        let (endpoint, _seen) = scripted_daemon(Vec::new(), false);
        let reading = read_once(&endpoint, "CCC", &[], Duration::from_millis(200))
            .await
            .expect("read");
        assert_eq!(reading["missing"], json!(["b"]));
    }

    #[tokio::test]
    async fn a_reading_dropped_midway_still_cancels_its_subscription() {
        let (endpoint, seen) = scripted_daemon(Vec::new(), false);
        let rows = vec!["a".to_owned(), "b".to_owned()];
        let reading = read_once(&endpoint, "CCC", &rows, Duration::from_secs(30));
        // A cancelled tool call drops the reading while it waits for the missing row.
        assert!(
            tokio::time::timeout(Duration::from_millis(300), reading)
                .await
                .is_err()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            methods(&seen).last().map(String::as_str),
            Some("subscriptions/cancel")
        );
    }

    #[tokio::test]
    async fn a_watch_fails_when_the_daemon_goes_instead_of_waiting_for_ever() {
        let update = json!({ "subscriptionId": "s1", "brickId": "usb:x", "kind": "delta",
            "values": [{ "rowId": "a", "value": 3 }] });
        let (endpoint, _seen) = scripted_daemon(vec![update], true);
        let mut heard = 0;
        let watched = tokio::time::timeout(
            Duration::from_secs(5),
            watch(
                &endpoint,
                "CCC",
                &["a".into()],
                std::future::pending(),
                |_| {
                    heard += 1;
                    true
                },
            ),
        )
        .await
        .expect("the watch ends on its own");
        assert_eq!(
            watched.expect_err("the daemon went").code(),
            Some("daemon_unavailable")
        );
        assert_eq!(heard, 2, "the snapshot and the update");
    }

    #[tokio::test]
    async fn a_watch_stopped_by_its_caller_cancels_its_subscription() {
        let (endpoint, seen) = scripted_daemon(Vec::new(), false);
        let stop = tokio::time::sleep(Duration::from_millis(100));
        let updates = watch(&endpoint, "CCC", &["a".into()], stop, |_| true)
            .await
            .expect("watch");
        assert_eq!(updates, 1);
        assert_eq!(
            methods(&seen).last().map(String::as_str),
            Some("subscriptions/cancel")
        );
    }

    #[tokio::test]
    async fn a_watch_nobody_reads_any_more_ends_and_cancels_its_subscription() {
        // `ev3 telemetry --watch | head -1`: the pipe closes, and watching on would print nowhere
        // until Ctrl+C.
        let (endpoint, seen) = scripted_daemon(Vec::new(), false);
        let watched = tokio::time::timeout(
            Duration::from_secs(5),
            watch(
                &endpoint,
                "CCC",
                &["a".into()],
                std::future::pending(),
                |_| false,
            ),
        )
        .await
        .expect("the watch ends on its own");
        assert_eq!(watched.expect("watch"), 1);
        assert_eq!(
            methods(&seen).last().map(String::as_str),
            Some("subscriptions/cancel")
        );
    }

    #[test]
    fn a_value_line_rounds_and_names_its_unit() {
        assert_eq!(
            value_line(
                &json!({ "rowId": "system.battery.voltage", "value": 7.91234, "unit": "V" })
            ),
            "system.battery.voltage = 7.912 V"
        );
        assert_eq!(
            value_line(&json!({ "rowId": "program.running", "value": false, "stale": true })),
            "program.running = false (stale)"
        );
    }

    #[test]
    fn a_row_line_names_its_unit_and_port() {
        assert_eq!(
            row_line(&json!({ "id": "system.battery.voltage", "unit": "V" })),
            "system.battery.voltage (V)"
        );
        assert_eq!(
            row_line(&json!({ "id": "motor.speed", "unit": "%", "port": "A" })),
            "motor.speed (%), port A"
        );
        assert_eq!(row_line(&json!({ "id": "x", "port": null })), "x");
    }
}
