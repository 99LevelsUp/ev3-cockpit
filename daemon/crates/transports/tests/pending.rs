//! The exchange machinery: message counters, the round-trip timer, stale replies, and the receive
//! buffer an abandoned exchange leaves behind.

mod common;

use std::time::Duration;

use async_trait::async_trait;
use common::{reply_packet, request};
use ev3_transports::{
    ErrorCode, Exchanger, LinkIo, MAX_STALE_REPLIES, MessageCounter, SendOptions, TransportError,
};
use tokio::sync::mpsc;

/// A link whose incoming bytes the test feeds by hand, as if they arrived from the brick.
struct ScriptedLink {
    incoming: mpsc::UnboundedReceiver<Vec<u8>>,
    written: Vec<Vec<u8>>,
}

fn scripted() -> (ScriptedLink, mpsc::UnboundedSender<Vec<u8>>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (
        ScriptedLink {
            incoming: rx,
            written: Vec::new(),
        },
        tx,
    )
}

#[async_trait]
impl LinkIo for ScriptedLink {
    async fn write_packet(&mut self, packet: &[u8]) -> Result<(), TransportError> {
        self.written.push(packet.to_vec());
        Ok(())
    }

    async fn read_some(&mut self, into: &mut Vec<u8>) -> Result<(), TransportError> {
        match self.incoming.recv().await {
            Some(bytes) => {
                into.extend(bytes);
                Ok(())
            }
            None => std::future::pending().await,
        }
    }
}

fn expecting(counter: u16, timeout_ms: u64) -> SendOptions {
    SendOptions {
        timeout: Some(Duration::from_millis(timeout_ms)),
        expected_message_counter: Some(counter),
    }
}

fn exchanger() -> Exchanger {
    Exchanger::new("TEST", Duration::from_secs(1))
}

#[test]
fn the_first_message_counter_is_one_and_it_wraps_at_sixteen_bits() {
    let mut counter = MessageCounter::new();
    assert_eq!(counter.next_counter(), 1);
    assert_eq!(counter.next_counter(), 2);
    for _ in 2..u16::MAX {
        counter.next_counter();
    }
    assert_eq!(counter.next_counter(), 0);
    assert_eq!(counter.next_counter(), 1);
}

#[tokio::test(start_paused = true)]
async fn an_exchange_returns_a_reply_that_arrives_in_pieces() {
    let (mut link, brick) = scripted();
    let mut exchanger = exchanger();
    let reply = reply_packet(1, &[0x10, 0x20, 0x30]);
    brick.send(reply[..2].to_vec()).unwrap();
    brick.send(reply[2..].to_vec()).unwrap();
    let got = exchanger
        .exchange(&mut link, &request(1, &[0x01]), &expecting(1, 100))
        .await
        .unwrap();
    assert_eq!(got, reply);
    assert_eq!(link.written, vec![request(1, &[0x01])]);
}

#[tokio::test(start_paused = true)]
async fn an_abandoned_exchange_discards_its_late_bytes_so_the_next_reads_its_own_reply() {
    let (mut link, brick) = scripted();
    let mut exchanger = exchanger();

    // Only the first bytes of the reply arrive before the budget runs out.
    let late = reply_packet(1, &[0xaa, 0xbb, 0xcc]);
    brick.send(late[..3].to_vec()).unwrap();
    let error = exchanger
        .exchange(&mut link, &request(1, &[0x01]), &expecting(1, 100))
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
    assert_eq!(
        error.message,
        "TEST send timed out after 100 ms with no matching reply."
    );

    // The next exchange gets its own reply, not one parsed from the partial frame.
    let own = reply_packet(2, &[0x11]);
    brick.send(own.clone()).unwrap();
    let got = exchanger
        .exchange(&mut link, &request(2, &[0x02]), &expecting(2, 100))
        .await
        .unwrap();
    assert_eq!(got, own);
}

#[tokio::test(start_paused = true)]
async fn an_exchange_its_caller_dropped_leaves_nothing_for_the_next() {
    let (mut link, brick) = scripted();
    let mut exchanger = exchanger();

    let late = reply_packet(1, &[0xaa, 0xbb, 0xcc]);
    brick.send(late[..3].to_vec()).unwrap();
    let dropped = tokio::time::timeout(
        Duration::from_millis(50),
        exchanger.exchange(&mut link, &request(1, &[0x01]), &expecting(1, 0)),
    )
    .await;
    assert!(dropped.is_err());
    assert_eq!(exchanger.buffered(), 3);

    let own = reply_packet(2, &[0x11]);
    brick.send(own.clone()).unwrap();
    let got = exchanger
        .exchange(&mut link, &request(2, &[0x02]), &expecting(2, 100))
        .await
        .unwrap();
    assert_eq!(got, own);
}

#[tokio::test(start_paused = true)]
async fn a_whole_late_reply_after_the_next_request_is_stepped_over_by_its_counter() {
    let (mut link, brick) = scripted();
    let mut exchanger = exchanger();
    exchanger
        .exchange(&mut link, &request(1, &[0x01]), &expecting(1, 100))
        .await
        .unwrap_err();

    // The abandoned reply arrives after the next request went out, then the right one.
    brick.send(reply_packet(1, &[0xaa])).unwrap();
    brick.send(reply_packet(2, &[0x22])).unwrap();
    let got = exchanger
        .exchange(&mut link, &request(2, &[0x02]), &expecting(2, 100))
        .await
        .unwrap();
    assert_eq!(got, reply_packet(2, &[0x22]));
}

#[tokio::test(start_paused = true)]
async fn four_stale_replies_are_stepped_over() {
    let (mut link, brick) = scripted();
    let mut exchanger = exchanger();
    for stale in 0..MAX_STALE_REPLIES {
        brick
            .send(reply_packet(100 + u16::try_from(stale).unwrap(), &[0x00]))
            .unwrap();
    }
    brick.send(reply_packet(7, &[0x77])).unwrap();
    let got = exchanger
        .exchange(&mut link, &request(7, &[0x07]), &expecting(7, 100))
        .await
        .unwrap();
    assert_eq!(got, reply_packet(7, &[0x77]));
}

#[tokio::test(start_paused = true)]
async fn a_fifth_stale_reply_declares_the_channel_out_of_step() {
    let (mut link, brick) = scripted();
    let mut exchanger = exchanger();
    for stale in 0..=MAX_STALE_REPLIES {
        brick
            .send(reply_packet(100 + u16::try_from(stale).unwrap(), &[0x00]))
            .unwrap();
    }
    brick.send(reply_packet(7, &[0x77])).unwrap();
    let error = exchanger
        .exchange(&mut link, &request(7, &[0x07]), &expecting(7, 100))
        .await
        .unwrap_err();
    assert_eq!(
        error,
        TransportError::transport_failed(
            "TEST reply stream stayed out of step after 4 stale replies."
        )
    );
    assert_eq!(exchanger.buffered(), 0);
}

#[tokio::test(start_paused = true)]
async fn without_an_expected_counter_the_first_reply_is_accepted() {
    let (mut link, brick) = scripted();
    let mut exchanger = exchanger();
    brick.send(reply_packet(99, &[0x01])).unwrap();
    let got = exchanger
        .exchange(&mut link, &request(1, &[0x01]), &SendOptions::default())
        .await
        .unwrap();
    assert_eq!(got, reply_packet(99, &[0x01]));
}

/// The brick answers after ten seconds.
async fn answer_after_ten_seconds(options: SendOptions) -> Result<Vec<u8>, TransportError> {
    let (mut link, brick) = scripted();
    let mut exchanger = exchanger();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        brick.send(reply_packet(1, &[0x01])).unwrap();
        // Keep the sender open, so the link never reads as closed.
        std::future::pending::<()>().await;
    });
    exchanger
        .exchange(&mut link, &request(1, &[0x01]), &options)
        .await
}

#[tokio::test(start_paused = true)]
async fn a_zero_budget_disables_the_timer() {
    let options = SendOptions {
        timeout: Some(Duration::ZERO),
        expected_message_counter: Some(1),
    };
    assert_eq!(
        answer_after_ten_seconds(options).await.unwrap(),
        reply_packet(1, &[0x01])
    );
}

#[tokio::test(start_paused = true)]
async fn no_budget_takes_the_transports_own() {
    let options = SendOptions {
        timeout: None,
        expected_message_counter: Some(1),
    };
    let error = answer_after_ten_seconds(options).await.unwrap_err();
    assert_eq!(
        error.message,
        "TEST send timed out after 1000 ms with no matching reply."
    );
}

struct FailingLink;

#[async_trait]
impl LinkIo for FailingLink {
    async fn write_packet(&mut self, _packet: &[u8]) -> Result<(), TransportError> {
        Err(TransportError::link_failed("TEST", "port closed"))
    }

    async fn read_some(&mut self, _into: &mut Vec<u8>) -> Result<(), TransportError> {
        unreachable!("nothing is read after a failed write")
    }
}

#[tokio::test(start_paused = true)]
async fn a_link_failure_ends_the_exchange_with_the_links_error() {
    let error = exchanger()
        .exchange(&mut FailingLink, &request(1, &[0x01]), &expecting(1, 100))
        .await
        .unwrap_err();
    assert_eq!(
        error,
        TransportError::transport_failed("TEST link failed: port closed")
    );
}

struct SilentLink;

#[async_trait]
impl LinkIo for SilentLink {
    async fn write_packet(&mut self, _packet: &[u8]) -> Result<(), TransportError> {
        Ok(())
    }

    async fn read_some(&mut self, _into: &mut Vec<u8>) -> Result<(), TransportError> {
        Ok(())
    }
}

#[tokio::test(start_paused = true)]
async fn a_read_that_returns_nothing_fails_instead_of_spinning() {
    let error = exchanger()
        .exchange(&mut SilentLink, &request(1, &[0x01]), &expecting(1, 0))
        .await
        .unwrap_err();
    assert_eq!(
        error,
        TransportError::transport_failed("TEST receive returned no data.")
    );
}
