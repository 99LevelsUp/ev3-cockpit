//! The Bluetooth data path: an RFCOMM socket in the Winsock `AF_BTH` family, connected
//! non-blocking and driven by tokio.
//!
//! Windows exposes RFCOMM as an ordinary socket family, so a brick is reached with `socket`,
//! `connect`, `send` and `recv` from `ws2_32.dll` and nothing else.
//!
//! The connect is never a blocking call aborted by a close. That was tried: closing did not end
//! the blocked call, and after four connects ran into their deadline in one process every later
//! connect failed without reaching the radio and the process could not exit. Here the socket is
//! switched to non-blocking before the connect starts and handed to tokio's reactor as a stream;
//! tokio reports the connect's completion, and `SO_ERROR` says how it ended. A deadline is a
//! plain close of a socket nobody is waiting in. Only the stream's read, write and readiness are
//! used, never its address methods, which assume an internet socket.

use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::bt::describe_address;
use crate::error::TransportError;
use crate::pending::LinkIo;

/// The RFCOMM channel the EV3 serves its serial port on. Addressed by channel rather than by a
/// service lookup: the brick has served it on channel 1 since the firmware shipped, and the
/// lookup is a round trip on a link where round trips are the expensive part.
pub const EV3_RFCOMM_CHANNEL: u32 = 1;

/// Deadline for one connect. A measured open took 4851 ms; this leaves room for a slow one.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Round-trip budget for one exchange: about sixteen times the measured round trip, because
/// RFCOMM is the least predictable of the transports.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(2);

/// `WSAEWOULDBLOCK`: a non-blocking connect has started and is under way.
pub const WSAEWOULDBLOCK: i32 = 10035;
/// `WSAETIMEDOUT`: the brick did not answer the connection request.
pub const WSAETIMEDOUT: i32 = 10060;
/// `WSAEHOSTDOWN`: what a brick with Bluetooth switched off answers, and what a connect too soon
/// after a close answers.
pub const WSAEHOSTDOWN: i32 = 10064;
/// `WSAEHOSTUNREACH`.
pub const WSAEHOSTUNREACH: i32 = 10065;

/// Receive buffer per read: twice the firmware's frame, so a full reply lands whole.
const RECV_CHUNK_BYTES: usize = 2048;

/// How a connect ended without a link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectFailure {
    /// This host cannot open Bluetooth sockets at all: no radio, or it is switched off. Nothing
    /// reached the air.
    Unavailable(String),
    /// The brick did not answer: timed out, host down, host unreachable.
    Unreachable(i32),
    /// Any other refusal, with its Winsock code.
    Failed(i32),
    /// The deadline passed with the connect still under way; the socket was closed.
    TimedOut(Duration),
}

impl ConnectFailure {
    /// Sorts a Winsock code: the three a brick that never answered produces, and the rest.
    pub fn from_code(code: i32) -> Self {
        match code {
            WSAETIMEDOUT | WSAEHOSTDOWN | WSAEHOSTUNREACH => Self::Unreachable(code),
            _ => Self::Failed(code),
        }
    }

    /// A brick that answered WSAEHOSTDOWN, which is also how a connect too soon after a close
    /// is refused.
    pub fn is_busy(&self) -> bool {
        matches!(self, Self::Unreachable(WSAEHOSTDOWN))
    }

    /// The Winsock code, where there is one.
    pub fn wsa_code(&self) -> Option<i32> {
        match self {
            Self::Unreachable(code) | Self::Failed(code) => Some(*code),
            Self::Unavailable(_) | Self::TimedOut(_) => None,
        }
    }

    /// The error a caller gets, naming the brick by its address.
    pub fn into_error(self, mac: &str) -> TransportError {
        let brick = describe_address(mac);
        match self {
            Self::Unavailable(reason) => TransportError::transport_failed(reason),
            Self::Unreachable(code) => TransportError::transport_failed(format!(
                "BT connect to {brick} failed (WSA error {code}): the brick did not answer."
            )),
            Self::Failed(code) => TransportError::transport_failed(format!(
                "BT connect to {brick} failed (WSA error {code})."
            )),
            Self::TimedOut(after) => TransportError::timeout(format!(
                "BT connect to {brick} timed out after {} ms.",
                after.as_millis()
            )),
        }
    }
}

/// A connect under way: a socket that has started connecting and can say when it is done.
pub trait PendingConnect: Send {
    /// Resolves once the connect has finished, either way.
    fn writable(&self) -> Pin<Box<dyn Future<Output = std::io::Result<()>> + Send + '_>>;
    /// The error the connect ended with (`SO_ERROR`); 0 when it connected.
    fn socket_error(&self) -> i32;
}

/// Waits for a connect under way, at most `deadline`.
///
/// Read through `SO_ERROR` once the socket is ready: readiness means the connect finished, not
/// that it succeeded. On any failure `pending` is dropped here, which closes its socket, so
/// nothing stays parked once the attempt is over and the next connect reaches the stack at once.
pub async fn finish_connect<P: PendingConnect>(
    pending: P,
    deadline: Duration,
) -> Result<P, ConnectFailure> {
    match tokio::time::timeout(deadline, pending.writable()).await {
        Err(_) => Err(ConnectFailure::TimedOut(deadline)),
        Ok(Err(error)) => Err(ConnectFailure::from_code(error.raw_os_error().unwrap_or(0))),
        Ok(Ok(())) => match pending.socket_error() {
            0 => Ok(pending),
            code => Err(ConnectFailure::from_code(code)),
        },
    }
}

/// A byte link to one brick, as a session holds it.
pub trait RfcommLink: LinkIo {
    /// The link can no longer carry an exchange (the brick hung up, a packet was cut off part
    /// way); the session must be closed and opened again.
    fn is_broken(&self) -> bool;
}

/// Opens RFCOMM links. The seam the provider is tested through.
#[async_trait]
pub trait RfcommConnector: Send + Sync {
    /// One attempt to connect to the brick at `address`, given up after `deadline`.
    async fn open(
        &self,
        address: u64,
        deadline: Duration,
    ) -> Result<Box<dyn RfcommLink>, ConnectFailure>;
}

/// A link over any byte stream: the Winsock socket in the daemon, an in-memory pipe in tests.
#[derive(Debug)]
pub struct StreamLink<S> {
    stream: S,
    broken: Option<String>,
    /// A packet went out only in part, and its writer was abandoned before it finished.
    cut_off: bool,
}

impl<S> StreamLink<S> {
    pub fn new(stream: S) -> Self {
        Self {
            stream,
            broken: None,
            cut_off: false,
        }
    }

    /// The stream underneath.
    pub fn get_ref(&self) -> &S {
        &self.stream
    }

    fn fail(&mut self, reason: String) -> TransportError {
        let error = TransportError::transport_failed(reason.clone());
        self.broken.get_or_insert(reason);
        error
    }
}

#[async_trait]
impl<S> LinkIo for StreamLink<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    /// Writes the whole packet, however many writes that takes.
    ///
    /// A write may accept less than it was offered, and on a 115200-baud link with a full frame
    /// it will. Once part of a packet is on its way, a failure, or an exchange abandoned before
    /// the rest went out, breaks the link: the next command would be read as the rest of this one.
    async fn write_packet(&mut self, packet: &[u8]) -> Result<(), TransportError> {
        if let Some(reason) = &self.broken {
            return Err(TransportError::transport_failed(reason.clone()));
        }
        if self.cut_off {
            return Err(self.fail(
                "BT link was left with a command cut off part way; it has to be reopened.".into(),
            ));
        }
        let mut sent = 0;
        while sent < packet.len() {
            match self.stream.write(&packet[sent..]).await {
                Ok(0) => {
                    let reason = format!("BT send stalled after {sent} of {} bytes.", packet.len());
                    if sent > 0 {
                        return Err(self.fail(reason));
                    }
                    return Err(TransportError::transport_failed(reason));
                }
                Ok(written) => {
                    sent += written;
                    self.cut_off = sent < packet.len();
                }
                Err(error) => {
                    let reason = match error.raw_os_error() {
                        Some(code) => format!("BT send failed (WSA error {code})."),
                        None => format!("BT send failed: {error}"),
                    };
                    self.cut_off = false;
                    if sent > 0 {
                        return Err(self.fail(reason));
                    }
                    return Err(TransportError::transport_failed(reason));
                }
            }
        }
        self.cut_off = false;
        if let Err(error) = self.stream.flush().await {
            return Err(self.fail(format!("BT send failed: {error}")));
        }
        Ok(())
    }

    async fn read_some(&mut self, into: &mut Vec<u8>) -> Result<(), TransportError> {
        if let Some(reason) = &self.broken {
            return Err(TransportError::transport_failed(reason.clone()));
        }
        let mut chunk = [0u8; RECV_CHUNK_BYTES];
        match self.stream.read(&mut chunk).await {
            // A peer's orderly shutdown reads as zero bytes.
            Ok(0) => Err(self.fail("BT connection closed by the brick.".into())),
            Ok(read) => {
                into.extend_from_slice(&chunk[..read]);
                Ok(())
            }
            Err(error) => {
                let reason = match error.raw_os_error() {
                    Some(code) => format!("BT receive failed (WSA error {code})."),
                    None => format!("BT receive failed: {error}"),
                };
                Err(self.fail(reason))
            }
        }
    }
}

impl<S> RfcommLink for StreamLink<S>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
{
    fn is_broken(&self) -> bool {
        self.broken.is_some() || self.cut_off
    }
}

/// `WSAStartup`, once per process. Reference counted by Windows and never undone: the daemon
/// uses sockets until it exits.
pub(crate) fn ensure_winsock() -> Result<(), String> {
    static STARTED: OnceLock<Result<(), String>> = OnceLock::new();
    STARTED
        .get_or_init(|| {
            use windows_sys::Win32::Networking::WinSock::{WSADATA, WSAStartup};
            // SAFETY: WSADATA is plain data, valid when zeroed; WSAStartup writes into it.
            let mut data: WSADATA = unsafe { std::mem::zeroed() };
            // SAFETY: `data` is a live, writable WSADATA.
            match unsafe { WSAStartup(0x0202, &mut data) } {
                0 => Ok(()),
                code => Err(format!("WSAStartup failed with {code}.")),
            }
        })
        .clone()
}

/// The connector the daemon uses: Winsock `AF_BTH`, channel 1.
#[derive(Debug, Default, Clone, Copy)]
pub struct WinsockConnector;

struct WinsockPending {
    stream: tokio::net::TcpStream,
    raw: windows_sys::Win32::Networking::WinSock::SOCKET,
}

impl PendingConnect for WinsockPending {
    fn writable(&self) -> Pin<Box<dyn Future<Output = std::io::Result<()>> + Send + '_>> {
        Box::pin(self.stream.writable())
    }

    fn socket_error(&self) -> i32 {
        use windows_sys::Win32::Networking::WinSock::{
            SO_ERROR, SOCKET_ERROR, SOL_SOCKET, WSAGetLastError, getsockopt,
        };
        let mut value: i32 = 0;
        let mut length = i32::try_from(std::mem::size_of::<i32>()).unwrap_or(4);
        // SAFETY: `raw` is the live socket `stream` owns; `value` and `length` are writable and
        // `length` holds the size of `value`.
        let status = unsafe {
            getsockopt(
                self.raw,
                SOL_SOCKET,
                SO_ERROR,
                (&raw mut value).cast(),
                &mut length,
            )
        };
        if status == SOCKET_ERROR {
            // Why the query failed, never an error value it did not write.
            // SAFETY: reads this thread's last Winsock error.
            return unsafe { WSAGetLastError() };
        }
        value
    }
}

#[async_trait]
impl RfcommConnector for WinsockConnector {
    async fn open(
        &self,
        address: u64,
        deadline: Duration,
    ) -> Result<Box<dyn RfcommLink>, ConnectFailure> {
        let pending = start_connect(address)?;
        let pending = finish_connect(pending, deadline).await?;
        Ok(Box::new(StreamLink::new(pending.stream)))
    }
}

/// Creates the socket, switches it to non-blocking and starts the connect, then hands it to
/// tokio. Everything here returns at once.
fn start_connect(address: u64) -> Result<WinsockPending, ConnectFailure> {
    use std::os::windows::io::FromRawSocket;
    use windows_sys::Win32::Devices::Bluetooth::{AF_BTH, BTHPROTO_RFCOMM, SOCKADDR_BTH};
    use windows_sys::Win32::Networking::WinSock::{
        FIONBIO, INVALID_SOCKET, SOCK_STREAM, SOCKADDR, WSAGetLastError, closesocket, connect,
        ioctlsocket, socket,
    };

    ensure_winsock().map_err(ConnectFailure::Unavailable)?;
    // SAFETY: plain call with constant arguments.
    let raw = unsafe {
        socket(
            i32::from(AF_BTH),
            SOCK_STREAM,
            i32::try_from(BTHPROTO_RFCOMM).unwrap_or(3),
        )
    };
    if raw == INVALID_SOCKET {
        // SAFETY: reads this thread's last Winsock error, straight after the failed call.
        let code = unsafe { WSAGetLastError() };
        return Err(ConnectFailure::Unavailable(format!(
            "Windows refused a Bluetooth socket (WSA error {code}). Usually means the host has no \
             Bluetooth radio, or it is switched off."
        )));
    }
    let close = |code: i32| {
        // SAFETY: `raw` is a socket this function created and nothing else holds.
        unsafe { closesocket(raw) };
        ConnectFailure::from_code(code)
    };

    let mut non_blocking: u32 = 1;
    // SAFETY: `raw` is a live socket and `non_blocking` is a writable u32.
    if unsafe { ioctlsocket(raw, FIONBIO, &mut non_blocking) } != 0 {
        // SAFETY: as above.
        let code = unsafe { WSAGetLastError() };
        return Err(close(code));
    }

    // Packed to 30 bytes, as the kernel reads it; the padded layout fails with WSA 10049.
    let target = SOCKADDR_BTH {
        addressFamily: AF_BTH,
        btAddr: address,
        serviceClassId: windows_sys::core::GUID::from_u128(0),
        port: EV3_RFCOMM_CHANNEL,
    };
    let length = i32::try_from(std::mem::size_of::<SOCKADDR_BTH>()).unwrap_or(30);
    // SAFETY: `target` is a live SOCKADDR_BTH of `length` bytes; `raw` is a live socket.
    let started = unsafe { connect(raw, (&raw const target).cast::<SOCKADDR>(), length) };
    if started != 0 {
        // Read on this thread, straight after the call: the error code is per thread.
        // SAFETY: as above.
        let code = unsafe { WSAGetLastError() };
        if code != WSAEWOULDBLOCK {
            return Err(close(code));
        }
    }

    // SAFETY: `raw` is a live socket this function owns; ownership moves to the stream, which
    // closes it when dropped.
    // A SOCKET is pointer-sized: RawSocket is u64 on 64-bit Windows and u32 on 32-bit.
    let std_stream =
        unsafe { std::net::TcpStream::from_raw_socket(raw as std::os::windows::io::RawSocket) };
    let stream = tokio::net::TcpStream::from_std(std_stream).map_err(|error| {
        ConnectFailure::Unavailable(format!(
            "The Bluetooth socket could not be registered for asynchronous use: {error}"
        ))
    })?;
    Ok(WinsockPending { stream, raw })
}
