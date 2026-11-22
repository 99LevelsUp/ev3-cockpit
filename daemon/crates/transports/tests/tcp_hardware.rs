//! Opt-in checks against a real Wi-Fi brick. Both are ignored by default.
//!
//! Set `EV3_TCP_HOST` to the brick's LAN address in your shell, then:
//!
//! ```text
//! cargo test -p ev3-transports --test tcp_hardware -- --ignored --nocapture --test-threads=1
//! ```
//!
//! Nothing here changes a firewall or network setting, and nothing prints the brick's serial.

use std::time::{Duration, Instant};

use ev3_protocol::packet::decode_ev3_packet;
use ev3_protocol::{BrickCommand, BrickResponse, build_command, encode_ev3_packet, parse_response};
use ev3_transports::tcp::{TcpOptions, TcpProvider};
use ev3_transports::{BrickKey, SendOptions, Transport, TransportProvider};

fn host() -> String {
    std::env::var("EV3_TCP_HOST").expect("set EV3_TCP_HOST to the brick's LAN address")
}

/// Listens for the brick's beacon for about 12 seconds, with the firewall prime running, and
/// says whether it arrived.
#[tokio::test]
#[ignore = "needs a Wi-Fi brick and EV3_TCP_HOST"]
async fn beacon_arrives_with_the_firewall_prime() {
    let host = host();
    let provider = TcpProvider::new(TcpOptions {
        host: Some(host),
        ..TcpOptions::default()
    });
    let started = Instant::now();
    let mut first_seen = None;
    while started.elapsed() < Duration::from_secs(12) {
        let scan = provider.discover().await.expect("beacon port binds");
        if first_seen.is_none() && !scan.items.is_empty() {
            first_seen = Some(started.elapsed());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    match first_seen {
        Some(after) => println!("BEACON: arrived after {} ms", after.as_millis()),
        None => println!("BEACON: none arrived in 12 s"),
    }
    provider.dispose().await;
}

/// Connects over TCP with the unlock handshake and lists the programs folder a few times.
#[tokio::test]
#[ignore = "needs a Wi-Fi brick and EV3_TCP_HOST"]
async fn connects_and_lists_the_programs_folder() {
    const LISTINGS: u16 = 20;
    let provider = TcpProvider::new(TcpOptions {
        use_discovery: false,
        ..TcpOptions::default()
    });
    let key = BrickKey::new(Transport::Tcp, &host()).unwrap();

    let started = Instant::now();
    provider.connect(&key).await.expect("connect and unlock");
    println!("CONNECT: {} ms", started.elapsed().as_millis());

    let command = BrickCommand::FsList {
        path: "/home/root/lms2012/prjs/".into(),
    };
    let encoded = build_command(&command).unwrap();
    let mut entries = 0;
    let started = Instant::now();
    for counter in 1..=LISTINGS {
        let packet =
            encode_ev3_packet(u32::from(counter), encoded.packet_type, &encoded.payload).unwrap();
        let answer = provider
            .send_packet(
                &key,
                &packet,
                &SendOptions {
                    expected_message_counter: Some(counter),
                    ..SendOptions::default()
                },
            )
            .await
            .expect("listing exchange");
        let decoded = decode_ev3_packet(&answer).unwrap();
        match parse_response(&command, &decoded).unwrap() {
            BrickResponse::FsList { listing, .. } => {
                entries = ev3_protocol::responses::parse_listing(&listing).len();
            }
            other => panic!("not a listing: {other:?}"),
        }
    }
    let elapsed = started.elapsed();
    println!(
        "LISTINGS: {LISTINGS} in {} ms = {:.1} per second, {entries} entries each",
        elapsed.as_millis(),
        f64::from(LISTINGS) / elapsed.as_secs_f64()
    );
    provider.disconnect(&key).await.unwrap();
    provider.dispose().await;
}
