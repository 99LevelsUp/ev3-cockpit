//! An in-test provider over a fake byte link, and the exchange tests every provider must pass.
//!
//! The fake provider drives the crate's own exchange machinery, so a real transport and this one
//! differ only in where the bytes go. The same suite then runs against replay.

#![allow(dead_code)] // each test binary uses its own part of this module

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use ev3_protocol::encode_ev3_packet;
use ev3_protocol::packet::{command, decode_ev3_packet, reply};
use ev3_transports::{
    BrickKey, DiscoveryItem, DiscoveryScanResult, ErrorCode, Exchanger, ForgetResidue, LinkIo,
    PairingOutcome, PresenceState, ProbeLink, SendOptions, SessionHandle, Transport,
    TransportCapabilities, TransportError, TransportProvider,
};
use tokio::sync::Mutex;

/// A request payload the fake brick answers with each byte plus one.
pub const ECHO: u8 = 0x01;
/// The fake brick answers this one with a stale reply first, then its own.
pub const STALE_FIRST: u8 = 0xcc;
/// The fake brick never answers this one.
pub const SILENT: u8 = 0xdd;
/// The link fails on this one.
pub const DROPS_LINK: u8 = 0xee;
/// The fake brick answers this one with how many times it was asked, so equal requests get
/// different replies.
pub const COUNTING: u8 = 0xab;
/// The fake brick answers this one with its configured identifying reply.
pub const IDENTIFY: u8 = 0x42;

/// The message the fake link fails with.
pub const LINK_FAILURE: &str = "FAKE link failed: connection reset by peer";

/// A direct command carrying `payload`, numbered `counter`.
pub fn request(counter: u16, payload: &[u8]) -> Vec<u8> {
    encode_ev3_packet(u32::from(counter), command::DIRECT_COMMAND_REPLY, payload).unwrap()
}

/// A direct reply carrying `payload`, numbered `counter`.
pub fn reply_packet(counter: u16, payload: &[u8]) -> Vec<u8> {
    encode_ev3_packet(u32::from(counter), reply::DIRECT_REPLY, payload).unwrap()
}

pub fn now_epoch_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis(),
    )
    .unwrap()
}

/// A fresh directory under the system's temporary directory.
pub fn temp_dir(name: &str) -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "ev3-transports-{name}-{}-{}-{}",
        std::process::id(),
        now_epoch_ms(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// What the fake provider says and holds, beyond the exchange rules above.
#[derive(Clone)]
pub struct FakeConfig {
    pub transport: Transport,
    pub key: BrickKey,
    pub display_name: String,
    /// The reply payload to [`IDENTIFY`].
    pub identify_reply: Vec<u8>,
    /// Where `forget` says a record stays.
    pub residue_location: String,
}

impl FakeConfig {
    pub fn usb(serial: &str) -> Self {
        Self {
            transport: Transport::Usb,
            key: BrickKey::new(Transport::Usb, serial).unwrap(),
            display_name: "AAA".into(),
            identify_reply: b"AAA".to_vec(),
            residue_location: "nowhere".into(),
        }
    }
}

/// The fake brick at the far end of a link: it answers each request as the rules above say, a
/// few bytes at a time.
pub struct FakeLink {
    waiting: Vec<u8>,
    identify_reply: Vec<u8>,
    counted: Arc<AtomicU32>,
}

impl FakeLink {
    fn new(identify_reply: Vec<u8>, counted: Arc<AtomicU32>) -> Self {
        Self {
            waiting: Vec::new(),
            identify_reply,
            counted,
        }
    }
}

#[async_trait]
impl LinkIo for FakeLink {
    async fn write_packet(&mut self, packet: &[u8]) -> Result<(), TransportError> {
        let decoded = decode_ev3_packet(packet).unwrap();
        let counter = decoded.message_counter;
        match decoded.payload.first().copied() {
            Some(DROPS_LINK) => {
                return Err(TransportError::link_failed(
                    "FAKE",
                    "connection reset by peer",
                ));
            }
            Some(SILENT) => {}
            Some(STALE_FIRST) => {
                self.waiting
                    .extend(reply_packet(counter.wrapping_sub(1), &[0x00]));
                self.waiting.extend(reply_packet(counter, &[STALE_FIRST]));
            }
            Some(COUNTING) => {
                let count = self.counted.fetch_add(1, Ordering::SeqCst) + 1;
                self.waiting
                    .extend(reply_packet(counter, &[u8::try_from(count).unwrap()]));
            }
            Some(IDENTIFY) => {
                let payload = self.identify_reply.clone();
                self.waiting.extend(reply_packet(counter, &payload));
            }
            // A real FAVOUR_ITEM read (opCOM_GET, FAVOUR_ITEM after the globals size) gets the
            // identifying reply too, as the peer entry.
            _ if decoded.payload.get(2..4) == Some(&[0xd3, 0x0b]) => {
                let payload = self.identify_reply.clone();
                self.waiting.extend(reply_packet(counter, &payload));
            }
            _ => {
                let payload: Vec<u8> = decoded.payload.iter().map(|b| b.wrapping_add(1)).collect();
                self.waiting.extend(reply_packet(counter, &payload));
            }
        }
        Ok(())
    }

    async fn read_some(&mut self, into: &mut Vec<u8>) -> Result<(), TransportError> {
        if self.waiting.is_empty() {
            return std::future::pending().await;
        }
        let take = self.waiting.len().min(3);
        into.extend(self.waiting.drain(..take));
        Ok(())
    }
}

struct Session {
    link: FakeLink,
    exchanger: Exchanger,
}

/// A provider over [`FakeLink`]s, built on the crate's [`Exchanger`].
pub struct FakeLinkProvider {
    config: FakeConfig,
    sessions: Mutex<HashMap<BrickKey, Session>>,
    counted: Arc<AtomicU32>,
}

impl FakeLinkProvider {
    pub fn new(config: FakeConfig) -> Self {
        Self {
            config,
            sessions: Mutex::new(HashMap::new()),
            counted: Arc::new(AtomicU32::new(0)),
        }
    }

    fn not_this_brick(&self, key: &BrickKey) -> TransportError {
        TransportError::transport_failed(format!("No EV3 answers as {key}."))
    }
}

#[async_trait]
impl TransportProvider for FakeLinkProvider {
    fn transport(&self) -> Transport {
        self.config.transport
    }

    fn priority(&self) -> i32 {
        30
    }

    fn capabilities(&self) -> TransportCapabilities {
        TransportCapabilities {
            supports_forget: true,
            supports_telemetry_frames: true,
            supports_recover: true,
            supports_probe: true,
            supports_pairing: true,
            supports_presence: true,
            ..TransportCapabilities::default()
        }
    }

    async fn discover(&self) -> Result<DiscoveryScanResult, TransportError> {
        Ok(DiscoveryScanResult {
            transport: self.config.transport,
            items: vec![DiscoveryItem {
                brick_key: self.config.key.clone(),
                display_name: self.config.display_name.clone(),
                name_source: None,
                transport: self.config.transport,
                presence_state: PresenceState::Available,
                remembered: false,
                connected: false,
                favorite: false,
                paired: None,
                heard: None,
                heard_at: None,
                signal_info: None,
                bt_visible: None,
                last_seen_at: now_epoch_ms(),
            }],
        })
    }

    async fn connect(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        if *brick_key != self.config.key {
            return Err(self.not_this_brick(brick_key));
        }
        self.sessions.lock().await.insert(
            brick_key.clone(),
            Session {
                link: FakeLink::new(self.config.identify_reply.clone(), self.counted.clone()),
                exchanger: Exchanger::new("FAKE", Duration::from_secs(2)),
            },
        );
        Ok(SessionHandle {
            brick_key: brick_key.clone(),
            transport: self.config.transport,
        })
    }

    async fn disconnect(&self, brick_key: &BrickKey) -> Result<(), TransportError> {
        self.sessions.lock().await.remove(brick_key);
        Ok(())
    }

    async fn send_packet(
        &self,
        brick_key: &BrickKey,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        let mut sessions = self.sessions.lock().await;
        let session = sessions
            .get_mut(brick_key)
            .ok_or_else(|| TransportError::transport_failed("FAKE adapter is not open."))?;
        session
            .exchanger
            .exchange(&mut session.link, packet, options)
            .await
    }

    fn max_packet_bytes(&self, brick_key: &BrickKey) -> Option<usize> {
        (*brick_key == self.config.key).then_some(1024)
    }

    async fn open_probe(&self, brick_key: &BrickKey) -> Result<Box<dyn ProbeLink>, TransportError> {
        if *brick_key != self.config.key {
            return Err(self.not_this_brick(brick_key));
        }
        Ok(Box::new(FakeProbe {
            link: FakeLink::new(self.config.identify_reply.clone(), self.counted.clone()),
            exchanger: Exchanger::new("FAKE", Duration::from_secs(2)),
        }))
    }

    async fn recover(&self, brick_key: &BrickKey) -> Result<SessionHandle, TransportError> {
        self.connect(brick_key).await
    }

    async fn forget(&self, _brick_key: &BrickKey) -> Result<Vec<ForgetResidue>, TransportError> {
        Ok(vec![ForgetResidue {
            location: self.config.residue_location.clone(),
            reason: "The operating system keeps this record.".into(),
        }])
    }

    async fn pair(&self, _brick_key: &BrickKey) -> Result<PairingOutcome, TransportError> {
        Ok(PairingOutcome {
            ok: true,
            reason: None,
            status: Some("Paired".into()),
        })
    }

    async fn check_presence(&self, brick_key: &BrickKey) -> Result<bool, TransportError> {
        Ok(*brick_key == self.config.key)
    }
}

struct FakeProbe {
    link: FakeLink,
    exchanger: Exchanger,
}

#[async_trait]
impl ProbeLink for FakeProbe {
    async fn send_packet(
        &mut self,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        self.exchanger
            .exchange(&mut self.link, packet, options)
            .await
    }

    async fn close(&mut self) {}
}

fn expecting(counter: u16) -> SendOptions {
    SendOptions {
        expected_message_counter: Some(counter),
        ..SendOptions::default()
    }
}

/// The exchange tests a provider passes, whatever is behind it.
///
/// `key` is the one brick the provider can reach. Each step uses the message counter a session
/// would: 1, 2, 3, ...
pub async fn exchange_suite(provider: &dyn TransportProvider, key: &BrickKey) {
    // Discovery lists the brick, and it connects.
    let scan = provider.discover().await.unwrap();
    assert!(scan.items.iter().any(|item| item.brick_key == *key));
    let handle = provider.connect(key).await.unwrap();
    assert_eq!(handle.brick_key, *key);
    assert_eq!(provider.max_packet_bytes(key), Some(1024));

    // An exchange returns the reply that carries its own counter.
    let answer = provider
        .send_packet(key, &request(1, &[ECHO, 0x10]), &expecting(1))
        .await
        .unwrap();
    assert_eq!(answer, reply_packet(1, &[ECHO + 1, 0x11]));

    // A stale reply ahead of it is stepped over.
    let answer = provider
        .send_packet(key, &request(2, &[STALE_FIRST]), &expecting(2))
        .await
        .unwrap();
    assert_eq!(answer, reply_packet(2, &[STALE_FIRST]));

    // A brick that does not answer times out with the timeout code.
    let silent = provider
        .send_packet(
            key,
            &request(3, &[SILENT]),
            &SendOptions {
                timeout: Some(Duration::from_millis(50)),
                expected_message_counter: Some(3),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(silent.code, ErrorCode::Timeout);

    // The link is usable after the timeout.
    let answer = provider
        .send_packet(key, &request(4, &[ECHO]), &expecting(4))
        .await
        .unwrap();
    assert_eq!(answer, reply_packet(4, &[ECHO + 1]));

    // A link failure comes back as a transport failure with the link's message.
    let failed = provider
        .send_packet(key, &request(5, &[DROPS_LINK]), &expecting(5))
        .await
        .unwrap_err();
    assert_eq!(failed, TransportError::transport_failed(LINK_FAILURE));

    // The operating-system side.
    assert!(provider.check_presence(key).await.unwrap());
    assert!(provider.pair(key).await.unwrap().ok);
    assert_eq!(provider.forget(key).await.unwrap().len(), 1);

    // A probe link asks outside the session.
    let mut probe = provider.open_probe(key).await.unwrap();
    let answer = probe
        .send_packet(&request(1, &[ECHO]), &expecting(1))
        .await
        .unwrap();
    assert_eq!(answer, reply_packet(1, &[ECHO + 1]));
    probe.close().await;

    provider.disconnect(key).await.unwrap();
}
