//! The request-reply exchange every byte link shares: message counters, the round-trip timer,
//! stepping over stale replies, and discarding what an abandoned exchange left behind.
//!
//! The EV3 is strictly request-reply on every channel, so nothing legitimate waits in the
//! receive buffer between exchanges. Whatever is there belongs to an exchange that was abandoned
//! (timed out, failed, or dropped by its caller), and parsing the next reply starting from it
//! would silently corrupt every exchange after it.

use std::time::Duration;

use async_trait::async_trait;
use ev3_protocol::extract_length_prefixed_packet;
use ev3_protocol::packet::message_counter_of;

use crate::error::TransportError;
use crate::provider::SendOptions;

/// How many replies with the wrong message counter an exchange steps over before it declares the
/// channel desynchronised. Bounded, or a genuinely desynchronised channel would spin forever.
pub const MAX_STALE_REPLIES: usize = 4;

/// Hands out message counters for one session.
///
/// Session-scoped, because two counters over one connection would collide and match each other's
/// replies. Starts at zero, so the first command sends 1, and wraps at 16 bits.
#[derive(Debug, Clone, Default)]
pub struct MessageCounter {
    last: u16,
}

impl MessageCounter {
    pub fn new() -> Self {
        Self::default()
    }

    /// The counter for the next command.
    pub fn next_counter(&mut self) -> u16 {
        self.last = self.last.wrapping_add(1);
        self.last
    }
}

/// The two halves of a byte link the exchange drives. A transport implements it over its own
/// socket, serial port or endpoint pair.
#[async_trait]
pub trait LinkIo: Send {
    /// Puts one whole packet on the link.
    async fn write_packet(&mut self, packet: &[u8]) -> Result<(), TransportError>;

    /// Waits for bytes and appends what arrived to `into`: at least one byte, or an error. A
    /// frame-based link (USB) appends only the packet its length prefix declares, never the
    /// padding behind it.
    async fn read_some(&mut self, into: &mut Vec<u8>) -> Result<(), TransportError>;
}

/// One link's exchange state: its receive buffer, its default budget, and its name for messages.
///
/// An exchange takes `&mut self`, so two exchanges on one link cannot overlap; the provider holds
/// one exchanger per link behind its own lock.
#[derive(Debug)]
pub struct Exchanger {
    label: String,
    default_timeout: Duration,
    buffer: Vec<u8>,
}

impl Exchanger {
    /// `label` names the transport in messages (`USB`, `TCP`, `BT`); `default_timeout` is the
    /// budget an exchange gets when its caller names none.
    pub fn new(label: impl Into<String>, default_timeout: Duration) -> Self {
        Self {
            label: label.into(),
            default_timeout,
            buffer: Vec::new(),
        }
    }

    /// Drops whatever is in the receive buffer.
    pub fn discard(&mut self) {
        self.buffer.clear();
    }

    /// Bytes waiting in the receive buffer.
    pub fn buffered(&self) -> usize {
        self.buffer.len()
    }

    /// One request-reply exchange: send `packet`, return the reply that carries the expected
    /// counter.
    ///
    /// The buffer is discarded before the request goes out, which also covers an exchange whose
    /// caller dropped it half way, and again on every failure. A whole reply that arrives late,
    /// after the next request went out, carries the old counter and is stepped over.
    pub async fn exchange<L: LinkIo + ?Sized>(
        &mut self,
        link: &mut L,
        packet: &[u8],
        options: &SendOptions,
    ) -> Result<Vec<u8>, TransportError> {
        self.buffer.clear();
        let budget = options.timeout.unwrap_or(self.default_timeout);
        let expected = options.expected_message_counter;
        let result = if budget.is_zero() {
            self.run(link, packet, expected).await
        } else {
            match tokio::time::timeout(budget, self.run(link, packet, expected)).await {
                Ok(result) => result,
                Err(_) => Err(TransportError::timeout(format!(
                    "{} send timed out after {} ms with no matching reply.",
                    self.label,
                    budget.as_millis()
                ))),
            }
        };
        if result.is_err() {
            self.buffer.clear();
        }
        result
    }

    async fn run<L: LinkIo + ?Sized>(
        &mut self,
        link: &mut L,
        packet: &[u8],
        expected: Option<u16>,
    ) -> Result<Vec<u8>, TransportError> {
        link.write_packet(packet).await?;
        let mut stale = 0;
        loop {
            while let Some(reply) = self.take_packet() {
                if expected.is_none() || message_counter_of(&reply) == expected {
                    return Ok(reply);
                }
                stale += 1;
                if stale > MAX_STALE_REPLIES {
                    return Err(TransportError::transport_failed(format!(
                        "{} reply stream stayed out of step after {MAX_STALE_REPLIES} stale replies.",
                        self.label
                    )));
                }
            }
            let before = self.buffer.len();
            link.read_some(&mut self.buffer).await?;
            if self.buffer.len() == before {
                return Err(TransportError::transport_failed(format!(
                    "{} receive returned no data.",
                    self.label
                )));
            }
        }
    }

    fn take_packet(&mut self) -> Option<Vec<u8>> {
        let length = extract_length_prefixed_packet(&self.buffer)?.0.len();
        Some(self.buffer.drain(..length).collect())
    }
}
