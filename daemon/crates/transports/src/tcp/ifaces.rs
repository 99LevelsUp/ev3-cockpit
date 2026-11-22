//! The computer's IPv4 interfaces: their addresses and masks, which decide where the firewall
//! prime is broadcast and which datagrams are our own.

use std::net::Ipv4Addr;

/// One IPv4 interface that is up and is not loopback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ipv4Interface {
    pub address: Ipv4Addr,
    pub netmask: Ipv4Addr,
}

/// Every up, non-loopback IPv4 interface. Empty where the platform cannot be asked (macOS), in
/// which case discovery listens but cannot prime the firewall.
pub fn local_ipv4_interfaces() -> Vec<Ipv4Interface> {
    imp::list()
}

#[cfg(windows)]
mod imp {
    use super::Ipv4Interface;
    use std::net::Ipv4Addr;
    use std::os::windows::io::AsRawSocket;

    use windows_sys::Win32::Networking::WinSock::{INTERFACE_INFO, WSAIoctl};

    /// _IOR('t', 127, ULONG); windows-sys does not define it.
    const SIO_GET_INTERFACE_LIST: u32 = 0x4004_747F;

    const IFF_UP: u32 = 1;
    const IFF_LOOPBACK: u32 = 4;
    const MAX_INTERFACES: usize = 32;

    pub fn list() -> Vec<Ipv4Interface> {
        // Creating the socket also starts Winsock for this process.
        let Ok(socket) = socket2::Socket::new(socket2::Domain::IPV4, socket2::Type::DGRAM, None)
        else {
            return Vec::new();
        };
        // SAFETY: INTERFACE_INFO is plain data, valid when zeroed.
        let mut infos: [INTERFACE_INFO; MAX_INTERFACES] = unsafe { std::mem::zeroed() };
        let mut returned: u32 = 0;
        // SAFETY: the output buffer is `infos` and its byte length is passed; the socket is
        // open for the whole call; no overlapped I/O or completion routine is requested.
        let status = unsafe {
            WSAIoctl(
                socket.as_raw_socket() as usize,
                SIO_GET_INTERFACE_LIST,
                std::ptr::null(),
                0,
                infos.as_mut_ptr().cast(),
                u32::try_from(std::mem::size_of_val(&infos)).unwrap_or(0),
                &mut returned,
                std::ptr::null_mut(),
                None,
            )
        };
        if status != 0 {
            return Vec::new();
        }
        let count = returned as usize / std::mem::size_of::<INTERFACE_INFO>();
        infos
            .iter()
            .take(count.min(MAX_INTERFACES))
            .filter(|i| i.iiFlags & IFF_UP != 0 && i.iiFlags & IFF_LOOPBACK == 0)
            .filter_map(|i| {
                // SAFETY: an IPv4 interface list fills the `AddressIn` arm of both unions.
                let (address, mask) = unsafe {
                    (
                        i.iiAddress.AddressIn.sin_addr.S_un.S_addr,
                        i.iiNetmask.AddressIn.sin_addr.S_un.S_addr,
                    )
                };
                let address = Ipv4Addr::from(address.to_ne_bytes());
                (!address.is_unspecified() && !address.is_loopback()).then(|| Ipv4Interface {
                    address,
                    netmask: Ipv4Addr::from(mask.to_ne_bytes()),
                })
            })
            .collect()
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::Ipv4Interface;
    use std::net::Ipv4Addr;

    pub fn list() -> Vec<Ipv4Interface> {
        let mut head: *mut libc::ifaddrs = std::ptr::null_mut();
        // SAFETY: `head` receives a list that is freed below with freeifaddrs.
        if unsafe { libc::getifaddrs(&mut head) } != 0 {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut cursor = head;
        while !cursor.is_null() {
            // SAFETY: `cursor` is a node of the list getifaddrs returned, alive until the free.
            let node = unsafe { &*cursor };
            cursor = node.ifa_next;
            let up = node.ifa_flags & libc::IFF_UP as u32 != 0;
            let loopback = node.ifa_flags & libc::IFF_LOOPBACK as u32 != 0;
            if !up || loopback || node.ifa_addr.is_null() || node.ifa_netmask.is_null() {
                continue;
            }
            // SAFETY: both pointers were checked non-null and point at socket addresses.
            let (family, address, mask) = unsafe {
                (
                    i32::from((*node.ifa_addr).sa_family),
                    *node.ifa_addr.cast::<libc::sockaddr_in>(),
                    *node.ifa_netmask.cast::<libc::sockaddr_in>(),
                )
            };
            if family != libc::AF_INET {
                continue;
            }
            out.push(Ipv4Interface {
                address: Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes()),
                netmask: Ipv4Addr::from(mask.sin_addr.s_addr.to_ne_bytes()),
            });
        }
        // SAFETY: `head` came from getifaddrs and nothing points into it any more.
        unsafe { libc::freeifaddrs(head) };
        out
    }
}

#[cfg(not(any(windows, target_os = "linux")))]
mod imp {
    use super::Ipv4Interface;

    pub fn list() -> Vec<Ipv4Interface> {
        Vec::new()
    }
}
