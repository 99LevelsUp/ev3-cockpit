//! Records a session at the provider trait: every provider call, its result or failure, and how
//! long it took, with identifiers replaced as they are captured.
//!
//! The recorder writes into the directory it is handed and nowhere else; making that directory
//! owner-only is the caller's job. A recording that cannot be written in full (a disk error, an
//! identifier with no placeholder that fits) stops recording and says so from
//! [`Recorder::finish`]; the live session goes on untouched.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use serde_json::Value;
use tokio::time::Instant;

use crate::brick_key::{BrickKey, Transport};
use crate::error::TransportError;
use crate::fixture::{
    Event, FORMAT_VERSION, Header, Line, Outcome, RECORDER_VERSION, RECORDING_FILE, Via, from_hex,
    to_hex,
};
use crate::provider::{
    DiscoveryScanResult, ForgetResidue, PairingOutcome, ProbeLink, SendOptions, SessionHandle,
    TransportCapabilities, TransportProvider,
};
use crate::scrub::Scrubber;

/// Fields whose values are fixed vocabulary, never identifiers: left as they are, so a host name
/// that happens to equal one cannot turn a tag into nonsense.
const VOCABULARY_KEYS: [&str; 7] = [
    "event",
    "code",
    "transport",
    "presence_state",
    "name_source",
    "strength",
    "via",
];

/// A recording in progress, shared by every provider it wraps.
#[derive(Clone)]
pub struct Recorder {
    state: Arc<Mutex<State>>,
}

struct State {
    file: File,
    path: PathBuf,
    scrubber: Scrubber,
    started: Instant,
    start_epoch_ms: i64,
    failure: Option<String>,
}

impl Recorder {
    /// Starts a recording of `scenario` in `dir`, writing its header. Refuses to overwrite a
    /// recording already there.
    ///
    /// `scrubber` carries the identifiers known before the session starts: this computer's name
    /// and adapter address, the user's name, the LAN addresses. Brick addresses are learned from
    /// the session itself.
    pub fn create(dir: &Path, scenario: &str, scrubber: Scrubber) -> io::Result<Self> {
        let path = dir.join(RECORDING_FILE);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        let start_epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
            .unwrap_or(0);
        let mut state = State {
            file,
            path,
            scrubber,
            started: Instant::now(),
            start_epoch_ms,
            failure: None,
        };
        let header = Header {
            format: FORMAT_VERSION,
            recorder: RECORDER_VERSION,
            scenario: scenario.to_owned(),
        };
        let value = serde_json::to_value(&header).map_err(io::Error::other)?;
        state.write_value(value).map_err(io::Error::other)?;
        Ok(Self {
            state: Arc::new(Mutex::new(state)),
        })
    }

    /// Where the recording is written.
    pub fn path(&self) -> PathBuf {
        self.lock().path.clone()
    }

    /// Wraps a provider so every call through it is recorded, and records the provider itself.
    pub fn wrap(&self, provider: Arc<dyn TransportProvider>) -> Arc<dyn TransportProvider> {
        self.record(
            self.now_ms(),
            Event::Provider {
                transport: provider.transport(),
                priority: provider.priority(),
                capabilities: provider.capabilities(),
            },
        );
        Arc::new(RecordingProvider {
            inner: provider,
            recorder: self.clone(),
        })
    }

    /// Flushes the recording, or reports why it is incomplete.
    pub fn finish(&self) -> io::Result<()> {
        let mut state = self.lock();
        if let Some(failure) = &state.failure {
            return Err(io::Error::other(format!(
                "The recording stopped early and is incomplete: {failure}"
            )));
        }
        state.file.flush()?;
        state.file.sync_all()
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn now_ms(&self) -> u64 {
        elapsed_ms(self.lock().started)
    }

    fn record(&self, at_ms: u64, mut event: Event) {
        let mut state = self.lock();
        if state.failure.is_some() {
            return;
        }
        if let Event::Discover {
            outcome: Outcome::Ok(scan),
            ..
        } = &mut event
        {
            scan.shift_times(-state.start_epoch_ms);
        }
        let result = serde_json::to_value(Line { at_ms, event })
            .map_err(|e| e.to_string())
            .and_then(|value| state.write_value(value));
        if let Err(failure) = result {
            state.failure = Some(failure);
        }
    }

    /// Starts timing a call. Until it is finished, dropping the guard records the call as
    /// abandoned.
    fn begin(&self, abandoned: Event) -> CallGuard {
        CallGuard {
            recorder: self.clone(),
            at_ms: self.now_ms(),
            started: Instant::now(),
            abandoned: Some(abandoned),
        }
    }
}

impl State {
    /// Learns every identifier the line carries, then writes it with all of them replaced.
    fn write_value(&mut self, mut value: Value) -> Result<(), String> {
        learn(&mut self.scrubber, &value, None).map_err(|e| e.to_string())?;
        scrub(&self.scrubber, &mut value, None).map_err(|e| e.to_string())?;
        let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
        writeln!(self.file, "{text}").map_err(|e| e.to_string())?;
        self.file.flush().map_err(|e| e.to_string())
    }
}

fn is_hex_key(key: Option<&str>) -> bool {
    key.is_some_and(|k| k.ends_with("_hex"))
}

fn is_vocabulary(key: Option<&str>) -> bool {
    key.is_some_and(|k| VOCABULARY_KEYS.contains(&k))
}

fn learn(
    scrubber: &mut Scrubber,
    value: &Value,
    key: Option<&str>,
) -> Result<(), crate::scrub::ScrubError> {
    match value {
        Value::String(text) if is_hex_key(key) => {
            scrubber.learn_from_bytes(&from_hex(text).unwrap_or_default())
        }
        Value::String(text) if !is_vocabulary(key) => scrubber.learn_from_text(text),
        Value::Array(items) => items.iter().try_for_each(|v| learn(scrubber, v, key)),
        Value::Object(map) => {
            if let (Some(Value::String(request)), Some(Value::String(reply))) =
                (map.get("request_hex"), map.get("reply_hex"))
            {
                scrubber.learn_from_exchange(
                    &from_hex(request).unwrap_or_default(),
                    &from_hex(reply).unwrap_or_default(),
                )?;
            } else if let Some(Value::String(request)) = map.get("request_hex") {
                scrubber.learn_from_exchange(&from_hex(request).unwrap_or_default(), &[])?;
            }
            map.iter()
                .try_for_each(|(k, v)| learn(scrubber, v, Some(k)))
        }
        _ => Ok(()),
    }
}

fn scrub(
    scrubber: &Scrubber,
    value: &mut Value,
    key: Option<&str>,
) -> Result<(), crate::scrub::ScrubError> {
    match value {
        Value::String(text) if is_hex_key(key) => {
            let bytes = from_hex(text).unwrap_or_default();
            *text = to_hex(&scrubber.scrub_bytes(&bytes)?);
            Ok(())
        }
        Value::String(text) if !is_vocabulary(key) => {
            *text = scrubber.scrub_text(text);
            Ok(())
        }
        Value::Array(items) => items.iter_mut().try_for_each(|v| scrub(scrubber, v, key)),
        Value::Object(map) => map
            .iter_mut()
            .try_for_each(|(k, v)| scrub(scrubber, v, Some(k))),
        _ => Ok(()),
    }
}

fn elapsed_ms(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// One call being timed. Finished with its real event, or dropped and recorded as abandoned.
struct CallGuard {
    recorder: Recorder,
    at_ms: u64,
    started: Instant,
    abandoned: Option<Event>,
}

impl CallGuard {
    fn finish(mut self, mut event: Event) {
        self.abandoned = None;
        event.set_elapsed_ms(elapsed_ms(self.started));
        self.recorder.record(self.at_ms, event);
    }
}

impl Drop for CallGuard {
    fn drop(&mut self) {
        if let Some(mut event) = self.abandoned.take() {
            event.set_elapsed_ms(elapsed_ms(self.started));
            self.recorder.record(self.at_ms, event);
        }
    }
}

fn exchange_event(
    transport: Transport,
    brick_key: &BrickKey,
    via: Via,
    request: &[u8],
    result: Option<&Result<Vec<u8>, TransportError>>,
) -> Event {
    Event::Exchange {
        transport,
        brick_key: brick_key.clone(),
        via,
        request_hex: to_hex(request),
        reply_hex: result.and_then(|r| r.as_ref().ok()).map(|b| to_hex(b)),
        error: result.and_then(|r| r.as_ref().err()).cloned(),
        elapsed_ms: 0,
    }
}

struct RecordingProvider {
    inner: Arc<dyn TransportProvider>,
    recorder: Recorder,
}

#[async_trait]
impl TransportProvider for RecordingProvider {
    fn transport(&self) -> Transport {
        self.inner.transport()
    }

    fn priority(&self) -> i32 {
        self.inner.priority()
    }

    fn capabilities(&self) -> TransportCapabilities {
        self.inner.capabilities()
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        let transport = self.transport();
        let guard = self.recorder.begin(Event::Discover {
            transport,
            elapsed_ms: 0,
            outcome: Outcome::Abandoned,
        });
        let result = self.inner.discover().await;
        guard.finish(Event::Discover {
            transport,
            elapsed_ms: 0,
            outcome: (&result).into(),
        });
        result
    }

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        let transport = self.transport();
        let guard = self.recorder.begin(Event::Connect {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: Outcome::Abandoned,
            max_packet_bytes: None,
        });
        let result = self.inner.connect(brick_key).await;
        guard.finish(Event::Connect {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: (&result).into(),
            max_packet_bytes: result
                .as_ref()
                .ok()
                .and_then(|_| self.inner.max_packet_bytes(brick_key)),
        });
        result
    }

    async fn disconnect(&self, brick_key: &BrickKey) -> Result<(), TransportError> {
        let transport = self.transport();
        let guard = self.recorder.begin(Event::Disconnect {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: Outcome::Abandoned,
        });
        let result = self.inner.disconnect(brick_key).await;
        guard.finish(Event::Disconnect {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: (&result).into(),
        });
        result
    }

    async fn send_packet(
        &self,
        brick_key: &BrickKey,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        let transport = self.transport();
        let guard = self.recorder.begin(exchange_event(
            transport,
            brick_key,
            Via::Session,
            packet,
            None,
        ));
        let result = self.inner.send_packet(brick_key, packet, options).await;
        guard.finish(exchange_event(
            transport,
            brick_key,
            Via::Session,
            packet,
            Some(&result),
        ));
        result
    }

    fn max_packet_bytes(&self, brick_key: &BrickKey) -> Option<usize> {
        self.inner.max_packet_bytes(brick_key)
    }

    async fn open_probe(&self, brick_key: &BrickKey) -> Result<Box<dyn ProbeLink>, TransportError> {
        let transport = self.transport();
        let guard = self.recorder.begin(Event::OpenProbe {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: Outcome::Abandoned,
        });
        let result = self.inner.open_probe(brick_key).await;
        guard.finish(Event::OpenProbe {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: match &result {
                Ok(_) => Outcome::Ok(()),
                Err(error) => Outcome::Err(error.clone()),
            },
        });
        result.map(|probe| {
            Box::new(RecordingProbe {
                inner: probe,
                recorder: self.recorder.clone(),
                transport,
                brick_key: brick_key.clone(),
            }) as Box<dyn ProbeLink>
        })
    }

    async fn recover(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        let transport = self.transport();
        let guard = self.recorder.begin(Event::Recover {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: Outcome::Abandoned,
            max_packet_bytes: None,
        });
        let result = self.inner.recover(brick_key).await;
        guard.finish(Event::Recover {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: (&result).into(),
            max_packet_bytes: result
                .as_ref()
                .ok()
                .and_then(|_| self.inner.max_packet_bytes(brick_key)),
        });
        result
    }

    async fn forget(&self, brick_key: &BrickKey) -> Result<Vec<ForgetResidue>, TransportError> {
        let transport = self.transport();
        let guard = self.recorder.begin(Event::Forget {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: Outcome::Abandoned,
        });
        let result = self.inner.forget(brick_key).await;
        guard.finish(Event::Forget {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: (&result).into(),
        });
        result
    }

    async fn pair(&self, brick_key: &BrickKey) -> Result<PairingOutcome, TransportError> {
        let transport = self.transport();
        let guard = self.recorder.begin(Event::Pair {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: Outcome::Abandoned,
        });
        let result = self.inner.pair(brick_key).await;
        guard.finish(Event::Pair {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: (&result).into(),
        });
        result
    }

    async fn check_presence(&self, brick_key: &BrickKey) -> Result<bool, TransportError> {
        let transport = self.transport();
        let guard = self.recorder.begin(Event::Presence {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: Outcome::Abandoned,
        });
        let result = self.inner.check_presence(brick_key).await;
        guard.finish(Event::Presence {
            transport,
            brick_key: brick_key.clone(),
            elapsed_ms: 0,
            outcome: (&result).into(),
        });
        result
    }

    async fn dispose(&self) {
        self.inner.dispose().await;
    }
}

struct RecordingProbe {
    inner: Box<dyn ProbeLink>,
    recorder: Recorder,
    transport: Transport,
    brick_key: BrickKey,
}

#[async_trait]
impl ProbeLink for RecordingProbe {
    async fn send_packet(
        &mut self,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        let guard = self.recorder.begin(exchange_event(
            self.transport,
            &self.brick_key,
            Via::Probe,
            packet,
            None,
        ));
        let result = self.inner.send_packet(packet, options).await;
        guard.finish(exchange_event(
            self.transport,
            &self.brick_key,
            Via::Probe,
            packet,
            Some(&result),
        ));
        result
    }

    async fn close(&mut self) {
        self.inner.close().await;
    }
}
