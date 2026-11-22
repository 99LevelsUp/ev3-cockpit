//! The Linux RFCOMM data path, against the real kernel where no radio is needed: a Unix socket
//! pair stands in for the brick's channel, a loopback TCP socket for a non-blocking connect.
#![cfg(target_os = "linux")]

use std::io::{Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use ev3_transports::bt_linux::rfcomm::{
    ConnectFailure, FdLink, PendingConnect, RawSockaddr, RfcommLink, SOCKADDR_L2_SIZE,
    SOCKADDR_RC_SIZE, SocketFailure, bdaddr, connect_socket, finish_connect, sockaddr_l2,
    sockaddr_rc,
};
use ev3_transports::{ErrorCode, Exchanger, LinkIo, SendOptions};

const AAA: u64 = 0x0016_53F0_0A0A;

#[test]
fn bdaddr_reverses_the_bytes() {
    assert_eq!(bdaddr(AAA), [0x0A, 0x0A, 0xF0, 0x53, 0x16, 0x00]);
}

#[test]
fn sockaddr_rc_is_family_reversed_address_channel_then_padding() {
    let address = sockaddr_rc(AAA, 1).expect("valid");
    assert_eq!(SOCKADDR_RC_SIZE, 10);
    assert_eq!(
        address.as_bytes(),
        &[31, 0, 0x0A, 0x0A, 0xF0, 0x53, 0x16, 0x00, 1, 0]
    );
}

#[test]
fn sockaddr_rc_refuses_a_channel_outside_1_to_30() {
    assert!(sockaddr_rc(AAA, 0).is_none());
    assert!(sockaddr_rc(AAA, 31).is_none());
    assert!(sockaddr_rc(AAA, 30).is_some());
}

#[test]
fn sockaddr_l2_is_family_psm_reversed_address_no_cid_bredr() {
    let address = sockaddr_l2(AAA, 1).expect("valid");
    assert_eq!(SOCKADDR_L2_SIZE, 14);
    assert_eq!(
        address.as_bytes(),
        &[31, 0, 1, 0, 0x0A, 0x0A, 0xF0, 0x53, 0x16, 0x00, 0, 0, 0, 0]
    );
    assert!(sockaddr_l2(AAA, 0).is_none());
}

#[test]
fn errnos_of_a_brick_that_did_not_answer_read_as_unreachable() {
    for code in [
        libc::EHOSTDOWN,
        libc::EHOSTUNREACH,
        libc::ETIMEDOUT,
        libc::ECONNREFUSED,
        libc::EBUSY,
    ] {
        assert_eq!(
            ConnectFailure::from_errno(code),
            ConnectFailure::Unreachable(code)
        );
    }
    assert_eq!(
        ConnectFailure::from_errno(libc::EACCES),
        ConnectFailure::Failed(libc::EACCES)
    );
}

#[test]
fn ebusy_says_the_channel_was_closed_a_moment_ago() {
    let error = ConnectFailure::from_errno(libc::EBUSY).into_error("00:16:53:F0:0A:0A");
    assert_eq!(error.code, ErrorCode::TransportFailed);
    assert!(error.message.contains("001653F00A0A"), "{}", error.message);
    assert!(
        error.message.contains("errno 16") && error.message.contains("closed a moment ago"),
        "{}",
        error.message
    );
}

#[test]
fn a_host_without_bluetooth_sockets_is_unavailable_not_a_failed_connect() {
    let failure = ConnectFailure::from_socket(SocketFailure::Socket(libc::EAFNOSUPPORT));
    match failure {
        ConnectFailure::Unavailable(reason) => {
            assert!(reason.contains("no Bluetooth stack"), "{reason}");
        }
        other => panic!("expected unavailable, got {other:?}"),
    }
}

#[test]
fn a_connect_that_never_lands_is_a_timeout() {
    let error = ConnectFailure::from_socket(SocketFailure::TimedOut(Duration::from_secs(15)))
        .into_error("00:16:53:F0:0A:0A");
    assert_eq!(error.code, ErrorCode::Timeout);
}

fn loopback(port: u16) -> RawSockaddr {
    let mut bytes = [0u8; 16];
    bytes[0..2].copy_from_slice(&u16::try_from(libc::AF_INET).unwrap().to_le_bytes());
    bytes[2..4].copy_from_slice(&port.to_be_bytes());
    bytes[4..8].copy_from_slice(&[127, 0, 0, 1]);
    RawSockaddr::from_bytes(&bytes).unwrap()
}

#[tokio::test]
async fn a_non_blocking_connect_lands_and_hands_back_the_socket() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let fd = connect_socket(
        libc::AF_INET,
        libc::SOCK_STREAM,
        0,
        &loopback(port),
        Duration::from_secs(5),
    )
    .await
    .expect("connected");
    assert!(fd.as_raw_fd() >= 0);
}

#[tokio::test]
async fn a_refused_connect_reports_its_errno() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let failure = connect_socket(
        libc::AF_INET,
        libc::SOCK_STREAM,
        0,
        &loopback(port),
        Duration::from_secs(5),
    )
    .await
    .expect_err("refused");
    assert_eq!(failure, SocketFailure::Connect(libc::ECONNREFUSED));
}

struct FakePending {
    lands: bool,
    error: i32,
    reads: std::sync::atomic::AtomicUsize,
}

impl PendingConnect for FakePending {
    fn writable(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<()>> + Send + '_>> {
        let lands = self.lands;
        Box::pin(async move {
            if lands {
                Ok(())
            } else {
                std::future::pending().await
            }
        })
    }

    fn socket_error(&self) -> i32 {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.error
    }
}

#[tokio::test(start_paused = true)]
async fn gives_up_on_a_connect_that_never_answers() {
    let pending = FakePending {
        lands: false,
        error: 0,
        reads: Default::default(),
    };
    let result = finish_connect(pending, Duration::from_secs(15)).await;
    assert!(matches!(result, Err(SocketFailure::TimedOut(_))));
}

#[tokio::test]
async fn reads_so_error_once_and_reports_it() {
    let pending = FakePending {
        lands: true,
        error: libc::EHOSTDOWN,
        reads: Default::default(),
    };
    let result = finish_connect(pending, Duration::from_secs(15)).await;
    assert!(matches!(result, Err(SocketFailure::Connect(code)) if code == libc::EHOSTDOWN));
}

fn pair() -> (FdLink, UnixStream) {
    let (ours, brick) = UnixStream::pair().unwrap();
    let fd = OwnedFd::from(ours);
    (FdLink::new(fd).unwrap(), brick)
}

/// `[len, len, counter, counter, type, ...]`
fn packet(counter: u16, body: &[u8]) -> Vec<u8> {
    let length = u16::try_from(2 + body.len()).unwrap();
    let mut bytes = length.to_le_bytes().to_vec();
    bytes.extend_from_slice(&counter.to_le_bytes());
    bytes.extend_from_slice(body);
    bytes
}

fn read_packet(brick: &mut UnixStream) -> Vec<u8> {
    let mut head = [0u8; 2];
    brick.read_exact(&mut head).unwrap();
    let mut rest = vec![0u8; usize::from(u16::from_le_bytes(head))];
    brick.read_exact(&mut rest).unwrap();
    [head.to_vec(), rest].concat()
}

#[tokio::test]
async fn returns_the_reply_whose_counter_matches_the_request() {
    let (mut link, mut brick) = pair();
    let request = packet(7, &[0x01, 0x99]);
    let answering = std::thread::spawn(move || {
        let got = read_packet(&mut brick);
        brick.write_all(&packet(6, &[0x02])).unwrap();
        brick.write_all(&packet(7, &[0x02, 0x55])).unwrap();
        got
    });
    let mut exchanger = Exchanger::new("BT", Duration::from_secs(2));
    let options = SendOptions {
        timeout: None,
        expected_message_counter: Some(7),
    };
    let reply = exchanger
        .exchange(&mut link, &request, &options)
        .await
        .unwrap();
    assert_eq!(reply, packet(7, &[0x02, 0x55]));
    assert_eq!(answering.join().unwrap(), request);
}

#[tokio::test]
async fn reassembles_a_reply_split_across_two_reads() {
    let (mut link, mut brick) = pair();
    let answering = std::thread::spawn(move || {
        read_packet(&mut brick);
        let reply = packet(1, &[0x02, 1, 2, 3]);
        brick.write_all(&reply[..3]).unwrap();
        std::thread::sleep(Duration::from_millis(50));
        brick.write_all(&reply[3..]).unwrap();
    });
    let mut exchanger = Exchanger::new("BT", Duration::from_secs(2));
    let reply = exchanger
        .exchange(&mut link, &packet(1, &[0x01]), &SendOptions::default())
        .await
        .unwrap();
    assert_eq!(reply, packet(1, &[0x02, 1, 2, 3]));
    answering.join().unwrap();
}

#[tokio::test]
async fn a_brick_that_hangs_up_breaks_the_link() {
    let (mut link, brick) = pair();
    drop(brick);
    let mut into = Vec::new();
    let error = link.read_some(&mut into).await.unwrap_err();
    assert!(
        error.message.contains("closed by the brick"),
        "{}",
        error.message
    );
    assert!(link.is_broken());
}

#[tokio::test]
async fn a_send_to_a_vanished_brick_fails_with_epipe_and_keeps_the_process() {
    let (mut link, brick) = pair();
    drop(brick);
    let error = link.write_packet(&packet(1, &[0x01])).await.unwrap_err();
    assert!(
        error.message.contains(&format!("errno {}", libc::EPIPE)),
        "{}",
        error.message
    );
    // Nothing went out, so only the exchange failed.
    assert!(!link.is_broken());
}

#[tokio::test]
async fn times_out_an_exchange_the_brick_never_answers_and_stays_usable() {
    let (mut link, mut brick) = pair();
    let mut exchanger = Exchanger::new("BT", Duration::from_millis(100));
    let error = exchanger
        .exchange(&mut link, &packet(1, &[0x01]), &SendOptions::default())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(!link.is_broken());
    read_packet(&mut brick);
    let answering = std::thread::spawn(move || {
        read_packet(&mut brick);
        brick.write_all(&packet(2, &[0x02])).unwrap();
    });
    let reply = exchanger
        .exchange(&mut link, &packet(2, &[0x01]), &SendOptions::default())
        .await
        .unwrap();
    assert_eq!(reply, packet(2, &[0x02]));
    answering.join().unwrap();
}

fn shrink_buffers(stream: &UnixStream, ours: &impl AsRawFd) {
    let small: libc::c_int = 4096;
    for (fd, option) in [
        (ours.as_raw_fd(), libc::SO_SNDBUF),
        (stream.as_raw_fd(), libc::SO_RCVBUF),
    ] {
        // SAFETY: plain setsockopt on live descriptors with a c_int value.
        let result = unsafe {
            libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                option,
                (&raw const small).cast(),
                libc::socklen_t::try_from(std::mem::size_of::<libc::c_int>()).unwrap(),
            )
        };
        assert_eq!(result, 0);
    }
}

#[tokio::test]
async fn a_packet_left_half_sent_breaks_the_link() {
    let (ours, brick) = UnixStream::pair().unwrap();
    shrink_buffers(&brick, &ours);
    let fd = OwnedFd::from(ours);
    let mut link = FdLink::new(fd).unwrap();
    // Far more than both buffers hold, and nobody reads: the write stops part way.
    let big = packet(1, &vec![0x55; 60_000]);
    let abandoned = tokio::time::timeout(Duration::from_millis(200), link.write_packet(&big)).await;
    assert!(
        abandoned.is_err(),
        "the write should still have been waiting"
    );
    assert!(link.is_broken());
    let error = link.write_packet(&packet(2, &[0x01])).await.unwrap_err();
    assert!(
        error.message.contains("cut off part way"),
        "{}",
        error.message
    );
    drop(brick);
}

#[tokio::test]
async fn writes_the_whole_packet_even_when_the_socket_takes_it_in_pieces() {
    let (ours, mut brick) = UnixStream::pair().unwrap();
    shrink_buffers(&brick, &ours);
    let fd = OwnedFd::from(ours);
    let mut link = FdLink::new(fd).unwrap();
    let big = packet(1, &vec![0x33; 60_000]);
    let expected = big.clone();
    let reading = std::thread::spawn(move || read_packet(&mut brick));
    link.write_packet(&big).await.unwrap();
    assert_eq!(reading.join().unwrap(), expected);
    assert!(!link.is_broken());
}

#[test]
fn raw_sockaddr_refuses_more_than_it_holds() {
    assert!(RawSockaddr::from_bytes(&[0u8; 33]).is_none());
    assert_eq!(
        RawSockaddr::from_bytes(&[1, 2]).unwrap().as_bytes(),
        &[1, 2]
    );
}
