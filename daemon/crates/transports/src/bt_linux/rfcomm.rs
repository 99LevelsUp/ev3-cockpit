//! The Bluetooth data path on Linux: an RFCOMM socket in the kernel's `AF_BLUETOOTH` family,
//! connected non-blocking and driven by tokio.
//!
//! Linux exposes RFCOMM and L2CAP as ordinary sockets, so a brick is reached with `socket`,
//! `connect`, `send` and `recv` from libc and nothing else: no D-Bus, no group membership. The
//! connect is never a blocking call: the socket is opened non-blocking, the kernel's answer is
//! waited for through tokio's reactor, and `SO_ERROR`, read once (Linux clears it on reading),
//! says how it ended. A deadline is a plain close of a socket nobody is waiting in, which also
//! abandons the connect.
//!
//! The struct layouts are written as bytes rather than declared as Rust structs: they are small
//! and fixed, a byte test pins them, and no padding byte is ever read. Every architecture the
//! cockpit ships on Linux (x64, arm64) is little-endian.

use std::future::Future;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::pin::Pin;
use std::time::Duration;

use async_trait::async_trait;
use tokio::io::Interest;
use tokio::io::unix::AsyncFd;

use crate::bt::describe_address;
use crate::error::TransportError;
use crate::pending::LinkIo;

/// The kernel's Bluetooth socket family.
pub const AF_BLUETOOTH: i32 = 31;
/// L2CAP, the protocol the presence probe opens.
pub const BTPROTO_L2CAP: i32 = 0;
/// RFCOMM, the brick's serial port.
pub const BTPROTO_RFCOMM: i32 = 3;

/// The RFCOMM channel the EV3 serves its serial port on, its only service. Addressed by channel
/// rather than by a service lookup, as on Windows.
pub const EV3_RFCOMM_CHANNEL: u8 = 1;

/// `sizeof(struct sockaddr_rc)`: family, the address, the channel, padded to ten bytes.
pub const SOCKADDR_RC_SIZE: usize = 10;
/// `sizeof(struct sockaddr_l2)`: family, PSM, the address, CID, address type, padded to 14.
pub const SOCKADDR_L2_SIZE: usize = 14;
/// `bdaddr_type` for BR/EDR, the classic radio the brick speaks.
pub const BDADDR_BREDR: u8 = 0;

/// Deadline for one connect. A measured open took about five seconds; this leaves room for a
/// slow one.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Round-trip budget for one exchange. A reply takes 42-107 ms on Linux; RFCOMM is the least
/// predictable of the transports, so the budget is generous.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(2);

/// Receive buffer per read: twice the firmware's frame, so a full reply lands whole.
const RECV_CHUNK_BYTES: usize = 2048;

/// The address as `bdaddr_t` holds it: the six bytes reversed, the last written byte first.
/// `00:16:53:F0:0A:0A` (`0x001653F00A0A`) becomes `0A 0A F0 53 16 00`.
pub fn bdaddr(address: u64) -> [u8; 6] {
    let bytes = address.to_le_bytes();
    [bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]]
}

/// A socket address as the kernel reads it: bytes, aligned for the `sockaddr` the call takes.
#[repr(C, align(8))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RawSockaddr {
    bytes: [u8; 32],
    len: usize,
}

impl RawSockaddr {
    /// The address over the given bytes; at most 32.
    pub fn from_bytes(source: &[u8]) -> Option<Self> {
        if source.len() > 32 {
            return None;
        }
        let mut bytes = [0u8; 32];
        bytes[..source.len()].copy_from_slice(source);
        Some(Self {
            bytes,
            len: source.len(),
        })
    }

    /// The bytes the kernel is given.
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }

    fn as_ptr(&self) -> *const libc::sockaddr {
        self.bytes.as_ptr().cast()
    }

    fn socklen(&self) -> libc::socklen_t {
        libc::socklen_t::try_from(self.len).unwrap_or(0)
    }
}

/// `struct sockaddr_rc` for an RFCOMM connect: family, the reversed address, the channel, then
/// padding. `None` for a channel outside 1-30.
pub fn sockaddr_rc(address: u64, channel: u8) -> Option<RawSockaddr> {
    if !(1..=30).contains(&channel) {
        return None;
    }
    let mut bytes = [0u8; SOCKADDR_RC_SIZE];
    bytes[0..2].copy_from_slice(&u16::try_from(AF_BLUETOOTH).ok()?.to_le_bytes());
    bytes[2..8].copy_from_slice(&bdaddr(address));
    bytes[8] = channel;
    RawSockaddr::from_bytes(&bytes)
}

/// `struct sockaddr_l2`: family, PSM (little-endian), the reversed address, CID 0, BR/EDR.
/// `None` for PSM 0.
pub fn sockaddr_l2(address: u64, psm: u16) -> Option<RawSockaddr> {
    if psm == 0 {
        return None;
    }
    let mut bytes = [0u8; SOCKADDR_L2_SIZE];
    bytes[0..2].copy_from_slice(&u16::try_from(AF_BLUETOOTH).ok()?.to_le_bytes());
    bytes[2..4].copy_from_slice(&psm.to_le_bytes());
    bytes[4..10].copy_from_slice(&bdaddr(address));
    bytes[10..12].copy_from_slice(&0u16.to_le_bytes());
    bytes[12] = BDADDR_BREDR;
    RawSockaddr::from_bytes(&bytes)
}

/// `errno` of the last failed call on this thread.
pub fn last_errno() -> i32 {
    io::Error::last_os_error()
        .raw_os_error()
        .unwrap_or(libc::EIO)
}

/// How a non-blocking connect ended without a socket, with the raw errno: each caller reads it
/// its own way. RFCOMM counts a refusal as a brick that did not answer; the presence probe counts
/// it as a brick that is there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketFailure {
    /// `socket` itself failed: nothing reached the air.
    Socket(i32),
    /// The connect failed, at once or once it had started.
    Connect(i32),
    /// The deadline passed with the connect still under way; the socket was closed.
    TimedOut(Duration),
}

/// A connect under way: a socket that has started connecting and can say when it is done.
pub trait PendingConnect: Send {
    /// Resolves once the connect has finished, either way.
    fn writable(&self) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>>;
    /// The error the connect ended with (`SO_ERROR`, read once); 0 when it connected.
    fn socket_error(&self) -> i32;
}

/// Waits for a connect under way, at most `deadline`.
///
/// Readiness means the connect finished, not that it succeeded: `SO_ERROR` says which, and is
/// read exactly once because Linux clears it on reading. On any failure `pending` is dropped
/// here, which closes its socket and abandons the connect.
pub async fn finish_connect<P: PendingConnect>(
    pending: P,
    deadline: Duration,
) -> Result<P, SocketFailure> {
    match tokio::time::timeout(deadline, pending.writable()).await {
        Err(_) => Err(SocketFailure::TimedOut(deadline)),
        Ok(Err(error)) => Err(SocketFailure::Connect(
            error.raw_os_error().unwrap_or(libc::EIO),
        )),
        Ok(Ok(())) => match pending.socket_error() {
            0 => Ok(pending),
            code => Err(SocketFailure::Connect(code)),
        },
    }
}

struct SocketPending {
    fd: AsyncFd<OwnedFd>,
}

impl PendingConnect for SocketPending {
    fn writable(&self) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        Box::pin(async move { self.fd.writable().await.map(|_| ()) })
    }

    fn socket_error(&self) -> i32 {
        let mut value: libc::c_int = 0;
        let mut length = libc::socklen_t::try_from(std::mem::size_of::<libc::c_int>()).unwrap_or(4);
        // SAFETY: the descriptor is live for as long as `fd` is; `value` and `length` are
        // writable and `length` holds the size of `value`.
        let result = unsafe {
            libc::getsockopt(
                self.fd.get_ref().as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                (&raw mut value).cast(),
                &raw mut length,
            )
        };
        if result < 0 { last_errno() } else { value }
    }
}

/// Opens a non-blocking socket and connects it to `address`, at most `deadline`.
///
/// Generic over the family so the same path serves RFCOMM, the L2CAP probe, and a loopback
/// socket in tests.
pub async fn connect_socket(
    domain: i32,
    kind: i32,
    protocol: i32,
    address: &RawSockaddr,
    deadline: Duration,
) -> Result<OwnedFd, SocketFailure> {
    // SAFETY: plain system call with integer arguments.
    let raw = unsafe {
        libc::socket(
            domain,
            kind | libc::SOCK_NONBLOCK | libc::SOCK_CLOEXEC,
            protocol,
        )
    };
    if raw < 0 {
        return Err(SocketFailure::Socket(last_errno()));
    }
    // SAFETY: `raw` is a descriptor this call just opened and nothing else owns.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY: `address` points at `socklen()` readable bytes laid out as the family's sockaddr.
    let started = unsafe { libc::connect(raw, address.as_ptr(), address.socklen()) };
    if started == 0 {
        return Ok(fd);
    }
    // Read straight after the call: errno is per thread.
    let code = last_errno();
    if code != libc::EINPROGRESS {
        return Err(SocketFailure::Connect(code));
    }
    // SAFETY: the AsyncFd owns the OwnedFd, which stays open and names the same socket until the
    // AsyncFd is dropped or gives it back.
    let fd =
        unsafe { AsyncFd::register_with_interest(fd, Interest::WRITABLE) }.map_err(|error| {
            let (_, error) = error.into_parts();
            SocketFailure::Connect(error.raw_os_error().unwrap_or(libc::EIO))
        })?;
    let pending = finish_connect(SocketPending { fd }, deadline).await?;
    Ok(pending.fd.into_inner())
}

/// How an RFCOMM connect ended without a link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectFailure {
    /// This host cannot open Bluetooth sockets at all: no stack, no radio, or it is switched off.
    /// Nothing reached the air.
    Unavailable(String),
    /// The brick did not answer: off, out of range, or busy.
    Unreachable(i32),
    /// Any other refusal, with its errno.
    Failed(i32),
    /// The deadline passed with the connect still under way; the socket was closed.
    TimedOut(Duration),
}

impl ConnectFailure {
    /// Sorts a connect's errno. Off or out of range: `EHOSTDOWN`, `EHOSTUNREACH`, `ETIMEDOUT`.
    /// Busy: `EBUSY` and `ECONNREFUSED`, which a brick answers for a while after its channel was
    /// closed (measured on three bricks: 0 s after a close `EBUSY`, within 2 s `ECONNREFUSED`,
    /// from 2.5 s it connects).
    pub fn from_errno(code: i32) -> Self {
        match code {
            libc::EHOSTDOWN
            | libc::EHOSTUNREACH
            | libc::ETIMEDOUT
            | libc::ECONNREFUSED
            | libc::EBUSY => Self::Unreachable(code),
            _ => Self::Failed(code),
        }
    }

    /// From what the socket layer reported.
    pub fn from_socket(failure: SocketFailure) -> Self {
        match failure {
            SocketFailure::Socket(code) => Self::Unavailable(format!(
                "Linux refused a Bluetooth socket (errno {code}). Usually means there is no \
                 Bluetooth stack or radio, or it is switched off."
            )),
            SocketFailure::Connect(code) => Self::from_errno(code),
            SocketFailure::TimedOut(after) => Self::TimedOut(after),
        }
    }

    /// A brick that answered EBUSY: its channel was closed a moment ago.
    pub fn is_busy(&self) -> bool {
        matches!(self, Self::Unreachable(libc::EBUSY))
    }

    /// The errno, where there is one.
    pub fn errno(&self) -> Option<i32> {
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
            Self::Unreachable(libc::EBUSY) => TransportError::transport_failed(format!(
                "BT connect to {brick} failed (errno {}): its channel was closed a moment ago.",
                libc::EBUSY
            )),
            Self::Unreachable(code) => TransportError::transport_failed(format!(
                "BT connect to {brick} failed (errno {code}): the brick did not answer."
            )),
            Self::Failed(code) => TransportError::transport_failed(format!(
                "BT connect to {brick} failed (errno {code})."
            )),
            Self::TimedOut(after) => TransportError::timeout(format!(
                "BT connect to {brick} timed out after {} ms.",
                after.as_millis()
            )),
        }
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

/// A link over a connected stream socket, driven by tokio: the RFCOMM socket in the daemon, a
/// Unix socket pair in tests.
#[derive(Debug)]
pub struct FdLink {
    fd: AsyncFd<OwnedFd>,
    broken: Option<String>,
    /// A packet went out only in part, and its writer was abandoned before it finished.
    cut_off: bool,
}

fn set_nonblocking(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: plain fcntl calls on a live descriptor.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: as above.
    if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn errno_of(error: &io::Error) -> i32 {
    error.raw_os_error().unwrap_or(libc::EIO)
}

impl FdLink {
    /// A link over a connected stream socket; switches it to non-blocking.
    pub fn new(fd: OwnedFd) -> io::Result<Self> {
        set_nonblocking(&fd)?;
        Ok(Self {
            // SAFETY: the AsyncFd owns the OwnedFd, which stays open and names the same socket for
            // the AsyncFd's whole life.
            fd: unsafe { AsyncFd::register(fd) }.map_err(io::Error::from)?,
            broken: None,
            cut_off: false,
        })
    }

    fn fail(&mut self, reason: String) -> TransportError {
        let error = TransportError::transport_failed(reason.clone());
        self.broken.get_or_insert(reason);
        error
    }

    /// One `send` of `data`, with `MSG_NOSIGNAL` so a brick that went away fails the write with
    /// `EPIPE` instead of killing the daemon with `SIGPIPE`.
    async fn send_some(&self, data: &[u8]) -> io::Result<usize> {
        loop {
            let mut guard = self.fd.writable().await?;
            let attempt = guard.try_io(|inner| {
                // SAFETY: `data` is readable for its length; the descriptor is live.
                let sent = unsafe {
                    libc::send(
                        inner.get_ref().as_raw_fd(),
                        data.as_ptr().cast(),
                        data.len(),
                        libc::MSG_NOSIGNAL,
                    )
                };
                if sent < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(usize::try_from(sent).unwrap_or(0))
                }
            });
            match attempt {
                Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {}
                Ok(result) => return result,
                // Would block: readiness was cleared, wait again.
                Err(_) => {}
            }
        }
    }

    async fn recv_some(&self, chunk: &mut [u8]) -> io::Result<usize> {
        loop {
            let mut guard = self.fd.readable().await?;
            let attempt = guard.try_io(|inner| {
                // SAFETY: `chunk` is writable for its length; the descriptor is live.
                let read = unsafe {
                    libc::recv(
                        inner.get_ref().as_raw_fd(),
                        chunk.as_mut_ptr().cast(),
                        chunk.len(),
                        0,
                    )
                };
                if read < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(usize::try_from(read).unwrap_or(0))
                }
            });
            match attempt {
                Ok(Err(error)) if error.kind() == io::ErrorKind::Interrupted => {}
                Ok(result) => return result,
                Err(_) => {}
            }
        }
    }
}

#[async_trait]
impl LinkIo for FdLink {
    /// Writes the whole packet, however many writes that takes.
    ///
    /// A write may take less than it was offered. Once part of a packet is on its way, a failure,
    /// or an exchange abandoned before the rest went out, breaks the link: the brick would read
    /// the next command as the rest of this one. A failure before the first byte fails only the
    /// exchange.
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
            let result = self.send_some(&packet[sent..]).await;
            match result {
                Ok(0) => {
                    let reason = format!("BT send stalled after {sent} of {} bytes.", packet.len());
                    self.cut_off = false;
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
                    let reason = format!("BT send failed (errno {}).", errno_of(&error));
                    self.cut_off = false;
                    if sent > 0 {
                        return Err(self.fail(reason));
                    }
                    return Err(TransportError::transport_failed(reason));
                }
            }
        }
        self.cut_off = false;
        Ok(())
    }

    async fn read_some(&mut self, into: &mut Vec<u8>) -> Result<(), TransportError> {
        if let Some(reason) = &self.broken {
            return Err(TransportError::transport_failed(reason.clone()));
        }
        let mut chunk = [0u8; RECV_CHUNK_BYTES];
        match self.recv_some(&mut chunk).await {
            // A peer's orderly shutdown reads as zero bytes.
            Ok(0) => Err(self.fail("BT connection closed by the brick.".into())),
            Ok(read) => {
                into.extend_from_slice(&chunk[..read]);
                Ok(())
            }
            Err(error) => {
                Err(self.fail(format!("BT receive failed (errno {}).", errno_of(&error))))
            }
        }
    }
}

impl RfcommLink for FdLink {
    fn is_broken(&self) -> bool {
        self.broken.is_some() || self.cut_off
    }
}

/// The connector the daemon uses: a kernel RFCOMM socket to channel 1.
#[derive(Debug, Default, Clone, Copy)]
pub struct SocketConnector;

#[async_trait]
impl RfcommConnector for SocketConnector {
    async fn open(
        &self,
        address: u64,
        deadline: Duration,
    ) -> Result<Box<dyn RfcommLink>, ConnectFailure> {
        let Some(target) = sockaddr_rc(address, EV3_RFCOMM_CHANNEL) else {
            return Err(ConnectFailure::Failed(libc::EINVAL));
        };
        let fd = connect_socket(
            AF_BLUETOOTH,
            libc::SOCK_STREAM,
            BTPROTO_RFCOMM,
            &target,
            deadline,
        )
        .await
        .map_err(ConnectFailure::from_socket)?;
        let link = FdLink::new(fd).map_err(|error| ConnectFailure::Failed(errno_of(&error)))?;
        Ok(Box::new(link))
    }
}
