//! The TCP link to a brick: connect, the unlock handshake, and the byte link the exchange
//! machinery drives.

use std::io;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::error::TransportError;
use crate::pending::LinkIo;

/// Budget for the TCP connect and for each unlock attempt.
pub const UNLOCK_TIMEOUT: Duration = Duration::from_millis(2_000);
/// Round-trip budget of a command, about 17 times the value measured on Wi-Fi.
pub const SEND_TIMEOUT: Duration = Duration::from_millis(1_000);
/// How often TCP keepalive probes an idle connection, so a half-open one shows up before a send
/// times out.
pub const KEEPALIVE: Duration = Duration::from_millis(3_000);

/// Told to a macOS user whose connect is unreachable: macOS keeps an app off the local network
/// until the user allows it, and until then a connect fails while the brick's beacons still
/// arrive.
pub const MAC_LOCAL_NETWORK_HINT: &str = "macOS may be keeping VS Code off the local network: allow it in System Settings \u{2192} Privacy & Security \u{2192} Local Network, then connect again.";

/// A connect failure with the transport's code and, on macOS for an unreachable host, the hint.
pub fn connect_failure(error: &io::Error, on_macos: bool) -> TransportError {
    let hint = if on_macos && error.kind() == io::ErrorKind::HostUnreachable {
        format!(" {MAC_LOCAL_NETWORK_HINT}")
    } else {
        String::new()
    };
    TransportError::transport_failed(format!("TCP connection failed: {error}{hint}"))
}

/// Whether a handshake reply accepts the connection: `Accept:EV3`, any case, any spacing
/// around the colon.
pub fn is_accept_response(response: &str) -> bool {
    let lower = response.to_ascii_lowercase();
    let mut rest = lower.as_str();
    while let Some(index) = rest.find("accept") {
        let after = rest[index + "accept".len()..].trim_start();
        if let Some(after) = after.strip_prefix(':')
            && after.trim_start().starts_with("ev3")
        {
            return true;
        }
        rest = &rest[index + 1..];
    }
    false
}

/// Percent-encodes everything but the characters a URL component leaves alone.
fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The two unlock requests, tried in turn: the full HTTP-like request with its blank-line
/// terminator, then the bare one.
pub fn unlock_requests(serial: &str, protocol: &str) -> [String; 2] {
    let serial = encode_component(if serial.is_empty() { "n/a" } else { serial });
    [
        format!("GET /target?sn={serial} VMTP1.0\r\nProtocol: {protocol}\r\n\r\n"),
        format!("GET /target?sn={serial} VMTP1.0\nProtocol: {protocol}"),
    ]
}

/// One unlock attempt: send `request`, read until the reply is `Accept:EV3` or a complete
/// header that is not.
async fn unlock_attempt<S>(stream: &mut S, request: &str) -> Result<(), TransportError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| TransportError::link_failed("TCP", e))?;
    let mut received: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 512];
    loop {
        let read = stream
            .read(&mut chunk)
            .await
            .map_err(|e| TransportError::link_failed("TCP", e))?;
        if read == 0 {
            return Err(TransportError::transport_failed(
                "TCP connection closed by the brick.",
            ));
        }
        received.extend_from_slice(&chunk[..read]);
        let text = String::from_utf8_lossy(&received);
        if is_accept_response(&text) {
            return Ok(());
        }
        if let Some(end) = text.find("\r\n\r\n") {
            return Err(TransportError::transport_failed(format!(
                "Unexpected unlock response \"{}\".",
                text[..end + 4].trim()
            )));
        }
    }
}

/// The unlock handshake. Each of the two requests gets `budget`; a brick that answers neither
/// is reported unreachable with the last failure.
pub async fn unlock_handshake<S>(
    stream: &mut S,
    serial: &str,
    protocol: &str,
    budget: Duration,
) -> Result<(), TransportError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut last: Option<TransportError> = None;
    for request in unlock_requests(serial, protocol) {
        match timeout(budget, unlock_attempt(stream, &request)).await {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(error)) => last = Some(error),
            Err(_) => {
                last = Some(TransportError::timeout(format!(
                    "TCP unlock handshake timeout after {}ms.",
                    budget.as_millis()
                )));
            }
        }
    }
    let detail = last.map_or_else(String::new, |e| e.message);
    Err(TransportError::transport_failed(format!(
        "TCP unlock handshake failed: {detail}"
    )))
}

/// The byte link of one connected brick.
#[derive(Debug)]
pub struct TcpLink {
    stream: TcpStream,
}

impl TcpLink {
    /// Connects, with no delay and keepalive, and unlocks the brick.
    pub async fn open(
        host: &str,
        port: u16,
        serial: &str,
        protocol: &str,
        budget: Duration,
    ) -> Result<Self, TransportError> {
        let stream = match timeout(budget, TcpStream::connect((host, port))).await {
            Ok(Ok(stream)) => stream,
            Ok(Err(error)) => return Err(connect_failure(&error, cfg!(target_os = "macos"))),
            Err(_) => {
                return Err(TransportError::timeout(format!(
                    "TCP connect timeout after {}ms ({host}:{port}).",
                    budget.as_millis()
                )));
            }
        };
        stream
            .set_nodelay(true)
            .map_err(|e| TransportError::link_failed("TCP", e))?;
        let keepalive = socket2::TcpKeepalive::new().with_time(KEEPALIVE);
        socket2::SockRef::from(&stream)
            .set_tcp_keepalive(&keepalive)
            .map_err(|e| TransportError::link_failed("TCP", e))?;
        let mut link = Self { stream };
        unlock_handshake(&mut link.stream, serial, protocol, budget).await?;
        Ok(link)
    }
}

#[async_trait]
impl LinkIo for TcpLink {
    async fn write_packet(&mut self, packet: &[u8]) -> Result<(), TransportError> {
        self.stream
            .write_all(packet)
            .await
            .map_err(|e| TransportError::link_failed("TCP", e))
    }

    async fn read_some(&mut self, into: &mut Vec<u8>) -> Result<(), TransportError> {
        let mut chunk = [0u8; 4096];
        let read = self
            .stream
            .read(&mut chunk)
            .await
            .map_err(|e| TransportError::link_failed("TCP", e))?;
        if read == 0 {
            return Err(TransportError::transport_failed(
                "TCP connection closed by the brick.",
            ));
        }
        into.extend_from_slice(&chunk[..read]);
        Ok(())
    }
}
