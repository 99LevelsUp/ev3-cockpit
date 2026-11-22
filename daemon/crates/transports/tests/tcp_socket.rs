//! The TCP link and provider: the unlock handshake, the exchange over a socket, and beacon
//! discovery over real loopback datagrams. The fake brick is a loopback listener.

use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use ev3_protocol::encode_ev3_packet;
use ev3_protocol::packet::{command, decode_ev3_packet, reply};
use ev3_transports::tcp::socket::{
    MAC_LOCAL_NETWORK_HINT, connect_failure, is_accept_response, unlock_handshake, unlock_requests,
};
use ev3_transports::tcp::{TcpOptions, TcpProvider};
use ev3_transports::{BrickKey, ErrorCode, NameSource, SendOptions, Transport, TransportProvider};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, UdpSocket};

const FIRST: &str = "GET /target?sn=n%2Fa VMTP1.0\r\nProtocol: WiFi\r\n\r\n";
const SECOND: &str = "GET /target?sn=n%2Fa VMTP1.0\nProtocol: WiFi";

async fn read_exactly(stream: &mut (impl AsyncReadExt + Unpin), length: usize) -> String {
    let mut bytes = vec![0u8; length];
    stream.read_exact(&mut bytes).await.unwrap();
    String::from_utf8(bytes).unwrap()
}

#[test]
fn the_unlock_requests_are_the_two_the_brick_has_always_been_sent() {
    let [first, second] = unlock_requests("", "WiFi");
    assert_eq!(first, FIRST);
    assert_eq!(second, SECOND);
    let [first, _] = unlock_requests("001653aabbcc", "WiFi");
    assert!(first.starts_with("GET /target?sn=001653aabbcc VMTP1.0\r\n"));
}

#[test]
fn accept_is_recognised_in_any_case_and_spacing() {
    assert!(is_accept_response("Accept:EV3\r\n\r\n"));
    assert!(is_accept_response("HTTP/1.0 200\r\naccept : ev3\r\n"));
    assert!(!is_accept_response("Accept: NXT\r\n\r\n"));
    assert!(!is_accept_response("Reject\r\n\r\n"));
}

#[tokio::test]
async fn the_handshake_succeeds_when_the_brick_accepts() {
    let (mut client, mut server) = tokio::io::duplex(1024);
    let brick = tokio::spawn(async move {
        assert_eq!(read_exactly(&mut server, FIRST.len()).await, FIRST);
        server.write_all(b"Accept:EV3\r\n\r\n").await.unwrap();
    });
    unlock_handshake(&mut client, "", "WiFi", Duration::from_secs(2))
        .await
        .unwrap();
    brick.await.unwrap();
}

#[tokio::test]
async fn a_refusal_falls_through_to_the_second_request() {
    let (mut client, mut server) = tokio::io::duplex(1024);
    let brick = tokio::spawn(async move {
        read_exactly(&mut server, FIRST.len()).await;
        server.write_all(b"HTTP/1.0 400 Bad\r\n\r\n").await.unwrap();
        assert_eq!(read_exactly(&mut server, SECOND.len()).await, SECOND);
        server.write_all(b"Accept: EV3").await.unwrap();
    });
    unlock_handshake(&mut client, "", "WiFi", Duration::from_secs(2))
        .await
        .unwrap();
    brick.await.unwrap();
}

#[tokio::test]
async fn a_brick_that_closes_is_unreachable_at_once() {
    let (mut client, server) = tokio::io::duplex(1024);
    drop(server);
    let started = tokio::time::Instant::now();
    let error = unlock_handshake(&mut client, "", "WiFi", Duration::from_secs(2))
        .await
        .unwrap_err();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(error.code, ErrorCode::TransportFailed);
    assert!(error.message.starts_with("TCP unlock handshake failed:"));
}

#[tokio::test(start_paused = true)]
async fn a_silent_brick_is_unreachable_once_each_request_has_had_two_seconds() {
    let (mut client, mut server) = tokio::io::duplex(1024);
    let started = tokio::time::Instant::now();
    let error = unlock_handshake(&mut client, "", "WiFi", Duration::from_millis(2000))
        .await
        .unwrap_err();
    assert_eq!(started.elapsed(), Duration::from_millis(4000));
    assert_eq!(error.code, ErrorCode::TransportFailed);
    assert_eq!(
        error.message,
        "TCP unlock handshake failed: TCP unlock handshake timeout after 2000ms."
    );
    // Both requests went out, the second only after the first had waited its budget.
    let sent = read_exactly(&mut server, FIRST.len() + SECOND.len()).await;
    assert_eq!(sent, format!("{FIRST}{SECOND}"));
}

#[test]
fn a_mac_user_is_told_where_to_allow_the_local_network() {
    let unreachable = std::io::Error::from(std::io::ErrorKind::HostUnreachable);
    assert!(
        connect_failure(&unreachable, true)
            .message
            .ends_with(MAC_LOCAL_NETWORK_HINT)
    );
    assert!(
        !connect_failure(&unreachable, false)
            .message
            .contains("macOS")
    );
    let refused = std::io::Error::from(std::io::ErrorKind::ConnectionRefused);
    assert!(!connect_failure(&refused, true).message.contains("macOS"));
}

/// A fake brick on loopback: unlocks, then answers each packet with its payload plus one.
/// Returns where it listens.
async fn fake_brick(accept: bool) -> SocketAddr {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut seen = Vec::new();
                let mut chunk = [0u8; 512];
                loop {
                    let n = stream.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    seen.extend_from_slice(&chunk[..n]);
                    if seen.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                if !accept {
                    return; // closes without a word
                }
                stream.write_all(b"Accept:EV3\r\n\r\n").await.unwrap();
                loop {
                    let mut head = [0u8; 2];
                    if stream.read_exact(&mut head).await.is_err() {
                        return;
                    }
                    let mut body = vec![0u8; usize::from(u16::from_le_bytes(head))];
                    if stream.read_exact(&mut body).await.is_err() {
                        return;
                    }
                    let mut packet = head.to_vec();
                    packet.extend(body);
                    let decoded = decode_ev3_packet(&packet).unwrap();
                    let payload: Vec<u8> =
                        decoded.payload.iter().map(|b| b.wrapping_add(1)).collect();
                    let answer = encode_ev3_packet(
                        u32::from(decoded.message_counter),
                        reply::DIRECT_REPLY,
                        &payload,
                    )
                    .unwrap();
                    if stream.write_all(&answer).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    addr
}

fn request(counter: u16, payload: &[u8]) -> Vec<u8> {
    encode_ev3_packet(u32::from(counter), command::DIRECT_COMMAND_REPLY, payload).unwrap()
}

fn expecting(counter: u16) -> SendOptions {
    SendOptions {
        expected_message_counter: Some(counter),
        ..SendOptions::default()
    }
}

#[tokio::test]
async fn connects_by_address_unlocks_and_exchanges_over_a_socket() {
    let addr = fake_brick(true).await;
    let provider = TcpProvider::new(TcpOptions {
        port: Some(addr.port()),
        use_discovery: false,
        ..TcpOptions::default()
    });
    let key = BrickKey::new(Transport::Tcp, "127.0.0.1").unwrap();
    let handle = provider.connect(&key).await.unwrap();
    assert_eq!(handle.transport, Transport::Tcp);
    assert_eq!(provider.priority(), 10);
    assert_eq!(provider.max_packet_bytes(&key), None);

    for counter in 1..=3u16 {
        let answer = provider
            .send_packet(&key, &request(counter, &[0x10, 0x20]), &expecting(counter))
            .await
            .unwrap();
        let decoded = decode_ev3_packet(&answer).unwrap();
        assert_eq!(decoded.message_counter, counter);
        assert_eq!(decoded.payload, &[0x11, 0x21]);
    }

    let twice = provider.connect(&key).await.unwrap_err();
    assert!(twice.message.contains("already connected"));

    provider.disconnect(&key).await.unwrap();
    let gone = provider
        .send_packet(&key, &request(4, &[1]), &expecting(4))
        .await
        .unwrap_err();
    assert!(gone.message.ends_with("is not connected."));
    provider.dispose().await;
}

#[tokio::test]
async fn a_brick_that_drops_the_unlock_fails_the_connect() {
    let addr = fake_brick(false).await;
    let provider = TcpProvider::new(TcpOptions {
        port: Some(addr.port()),
        use_discovery: false,
        ..TcpOptions::default()
    });
    let key = BrickKey::new(Transport::Tcp, "127.0.0.1").unwrap();
    let error = provider.connect(&key).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::TransportFailed);
    assert!(
        error
            .message
            .starts_with("Connect failed for tcp:127.0.0.1: ")
    );
    assert!(error.message.contains("unlock handshake failed"));
}

#[tokio::test]
async fn a_serial_key_with_no_beacon_names_the_missing_address() {
    let provider = TcpProvider::new(TcpOptions {
        use_discovery: false,
        ..TcpOptions::default()
    });
    let key = BrickKey::new(Transport::Tcp, "001653aabbcc").unwrap();
    let error = provider.connect(&key).await.unwrap_err();
    assert!(
        error
            .message
            .contains("No address known for tcp:001653aabbcc")
    );
}

/// A UDP port nobody holds right now.
async fn free_udp_port() -> u16 {
    UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

async fn announce(text: &str, port: u16) {
    let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    socket
        .send_to(text.as_bytes(), (Ipv4Addr::LOCALHOST, port))
        .await
        .unwrap();
}

fn beacon(serial: &str, name: &str) -> String {
    format!("Serial-Number: {serial}\r\nPort: 5555\r\nName: {name}\r\nProtocol: EV3\r\n")
}

async fn eventually_listed(provider: &TcpProvider, count: usize) -> Vec<String> {
    for _ in 0..100 {
        let scan = provider.discover().await.unwrap();
        if scan.items.len() >= count {
            return scan.items.iter().map(|i| i.brick_key.to_string()).collect();
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    provider
        .discover()
        .await
        .unwrap()
        .items
        .iter()
        .map(|i| i.brick_key.to_string())
        .collect()
}

#[tokio::test]
async fn lists_a_brick_that_announces_itself() {
    let port = free_udp_port().await;
    let provider = TcpProvider::new(TcpOptions {
        discovery_port: port,
        ..TcpOptions::default()
    });
    provider.discover().await.unwrap();
    announce(&beacon("001653F00A0A", "AAA"), port).await;

    assert_eq!(
        eventually_listed(&provider, 1).await,
        vec!["tcp:001653f00a0a".to_owned()]
    );
    let scan = provider.discover().await.unwrap();
    assert_eq!(scan.items[0].display_name, "AAA");
    assert_eq!(scan.items[0].name_source, Some(NameSource::Beacon));
    assert_eq!(scan.items[0].transport, Transport::Tcp);
    provider.dispose().await;
}

#[tokio::test]
async fn an_unnamed_beacon_is_listed_by_its_address() {
    let port = free_udp_port().await;
    let provider = TcpProvider::new(TcpOptions {
        discovery_port: port,
        ..TcpOptions::default()
    });
    provider.discover().await.unwrap();
    announce(&beacon("001653F00A0A", ""), port).await;
    eventually_listed(&provider, 1).await;
    let scan = provider.discover().await.unwrap();
    assert_eq!(scan.items[0].display_name, "EV3 [127.0.0.1]");
    assert_eq!(scan.items[0].name_source, Some(NameSource::Fallback));
    provider.dispose().await;
}

#[tokio::test]
async fn ignores_an_announcement_whose_serial_is_not_an_ev3_identity() {
    let port = free_udp_port().await;
    let provider = TcpProvider::new(TcpOptions {
        discovery_port: port,
        ..TcpOptions::default()
    });
    provider.discover().await.unwrap();
    announce(&beacon("not-a-serial", "Impostor"), port).await;
    announce(&beacon("", "Nameless"), port).await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(provider.discover().await.unwrap().items.is_empty());
    provider.dispose().await;
}

#[tokio::test]
async fn reports_the_disabled_state_instead_of_an_empty_network() {
    let provider = TcpProvider::new(TcpOptions {
        use_discovery: false,
        ..TcpOptions::default()
    });
    let error = provider.discover().await.unwrap_err();
    assert!(error.message.contains("discovery is disabled"));
    assert!(!provider.listening(), "and nothing was bound");
}

#[tokio::test]
async fn two_cockpits_share_the_beacon_port() {
    let port = free_udp_port().await;
    let first = TcpProvider::new(TcpOptions {
        discovery_port: port,
        ..TcpOptions::default()
    });
    let second = TcpProvider::new(TcpOptions {
        discovery_port: port,
        ..TcpOptions::default()
    });
    first.discover().await.unwrap();
    second.discover().await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    second.discover().await.unwrap();
    first.discover().await.unwrap();
    first.dispose().await;
    second.dispose().await;
}

#[tokio::test]
async fn a_host_filter_lists_only_the_brick_announcing_from_there() {
    let port = free_udp_port().await;
    let provider = TcpProvider::new(TcpOptions {
        discovery_port: port,
        host: Some("192.0.2.99".into()),
        ..TcpOptions::default()
    });
    provider.discover().await.unwrap();
    announce(&beacon("001653F00A0A", "AAA"), port).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(provider.discover().await.unwrap().items.is_empty());
    provider.dispose().await;
}

#[tokio::test(start_paused = true)]
async fn the_port_is_held_only_while_scans_continue() {
    let port = free_udp_port().await;
    let provider = TcpProvider::new(TcpOptions {
        discovery_port: port,
        ..TcpOptions::default()
    });
    assert!(
        !provider.listening(),
        "nothing is bound before the first scan"
    );
    provider.discover().await.unwrap();
    assert!(provider.listening());

    tokio::time::sleep(Duration::from_secs(10)).await;
    provider.discover().await.unwrap();
    tokio::time::sleep(Duration::from_secs(10)).await;
    assert!(provider.listening(), "a scan 10 s ago keeps it");

    tokio::time::sleep(Duration::from_secs(20)).await;
    assert!(
        !provider.listening(),
        "scans stopped, so the port is let go"
    );

    provider.discover().await.unwrap();
    assert!(provider.listening(), "and the next scan binds it again");
    provider.dispose().await;
    assert!(!provider.listening());
    assert!(provider.discover().await.is_err());
}
