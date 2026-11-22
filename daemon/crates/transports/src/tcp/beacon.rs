//! The brick's UDP beacon: parsing it, and the bounded, untrusted cache of what it announced.
//!
//! The beacon is the only place bytes anyone on the subnet can send enter a provider, and a
//! connect later takes both the address and the port out of the cache. The unlock handshake
//! authenticates nothing, so whatever the cache accepts decides where a user's "connect to my
//! brick" goes. The bounds here are therefore security properties, not parsing trivia.

use std::net::Ipv4Addr;
use std::time::Duration;

use tokio::time::Instant;

/// UDP port the brick announces itself on.
pub const BEACON_PORT: u16 = 3015;
/// TCP port a brick listens on.
pub const TCP_PORT: u16 = 5555;
/// How long a received beacon stays fresh.
pub const BEACON_FRESH: Duration = Duration::from_millis(15_000);
/// Longest accepted name in a beacon, in bytes; the brick's own field holds 16 characters.
pub const BEACON_NAME_MAX: usize = 32;
/// Most beacons kept. Anything on the subnet can announce, so without a cap one datagram per
/// invented serial grows the map and fills the brick list with attacker-chosen strings.
pub const BEACON_CACHE_MAX: usize = 64;
/// How often the firewall prime goes out while scanning. Kept under the firewall's UDP mapping
/// lifetime, which is short.
pub const BEACON_PRIME_INTERVAL: Duration = Duration::from_millis(4_000);

/// The fields of one beacon, apart from who sent it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BeaconFields {
    pub serial_number: String,
    pub port: u16,
    pub protocol: String,
    pub name: String,
}

/// A beacon with the address it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BeaconInfo {
    pub ip: Ipv4Addr,
    pub port: u16,
    pub serial_number: String,
    pub protocol: String,
    pub name: String,
}

/// Reads the `Key: value` lines of a beacon.
///
/// The lines are free-form text from a datagram anyone can send, and `name` reaches the log and
/// the brick picker verbatim. Control characters are dropped and the length bounded, so the
/// network cannot forge log lines or pad the list. A port that is not 1 to 65535 makes the whole
/// beacon unusable.
pub fn parse_beacon_message(message: &str) -> Option<BeaconFields> {
    let mut fields: Vec<(String, String)> = Vec::new();
    for line in message.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if let Some(index) = line.find(':') {
            fields.push((
                line[..index].trim().to_lowercase(),
                line[index + 1..].trim().to_owned(),
            ));
        }
    }
    // A later line with the same key wins, as it does in a map.
    let get = |key: &str| {
        fields
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    };

    let port = parse_leading_int(get("port").unwrap_or(""))?;
    let port = u16::try_from(port).ok().filter(|p| *p > 0)?;
    Some(BeaconFields {
        serial_number: clean(get("serial-number").unwrap_or("")),
        port,
        protocol: clean(get("protocol").unwrap_or("WiFi")),
        name: clean(get("name").unwrap_or("")),
    })
}

/// What a lenient integer parse reads: an optional sign and the digits that follow, ignoring
/// whatever trails them.
fn parse_leading_int(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    if end == 0 {
        return None;
    }
    let value: i64 = digits[..end].parse().ok()?;
    Some(if negative { -value } else { value })
}

/// Drops control characters and cuts to [`BEACON_NAME_MAX`] bytes, never inside a character.
fn clean(value: &str) -> String {
    let mut out = String::new();
    for c in value.chars().filter(|c| !c.is_control()) {
        if out.len() + c.len_utf8() > BEACON_NAME_MAX {
            break;
        }
        out.push(c);
    }
    out
}

/// The broadcast address of an interface, or `None` when its mask makes one meaningless: a /32
/// as VPN adapters commonly report, an all-zero mask some tunnel adapters report while
/// connecting (which would give the limited broadcast and blast every attached network), or a
/// mask wider than /8.
pub fn to_broadcast_address(address: Ipv4Addr, netmask: Ipv4Addr) -> Option<Ipv4Addr> {
    let mask = netmask.octets();
    if mask.iter().all(|p| *p == 255) || mask.iter().all(|p| *p == 0) || mask[0] != 255 {
        return None;
    }
    let a = address.octets();
    Some(Ipv4Addr::from(std::array::from_fn(|i| {
        (a[i] & mask[i]) | !mask[i]
    })))
}

/// One cached announcement.
#[derive(Debug, Clone)]
struct Entry {
    key: String,
    info: BeaconInfo,
    received_at: Instant,
    received_epoch_ms: i64,
}

/// A cached beacon and when it arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenBeacon {
    pub info: BeaconInfo,
    pub received_epoch_ms: i64,
}

/// What the beacon listener has heard, treated as untrusted.
///
/// Time is passed in, so a test drives it with a paused clock.
#[derive(Debug, Default)]
pub struct BeaconState {
    /// In arrival order of first sight; an update keeps its place.
    entries: Vec<Entry>,
    /// Serials announced from two addresses while both claims were fresh, against the time the
    /// clash was seen. Timestamped because a brick that takes a new DHCP lease inside the
    /// freshness window looks exactly like a spoof, and a conflict that never expired would take
    /// it out of service for good.
    conflicts: Vec<(String, Instant)>,
    /// Local addresses, so our own broadcast probe coming back is not taken for a brick.
    local_addresses: Vec<Ipv4Addr>,
    last_scan: Option<Instant>,
    listening: bool,
}

impl BeaconState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Remembers an address as ours.
    pub fn add_local_address(&mut self, address: Ipv4Addr) {
        if !self.local_addresses.contains(&address) {
            self.local_addresses.push(address);
        }
    }

    /// Notes that a scan asked now, and says whether a listener already holds the port. The
    /// listener lets go of it once scans stop; deciding that and noting a scan happen under one
    /// lock, so a scan never finds a listener that is just about to leave.
    pub fn note_scan(&mut self, now: Instant) -> bool {
        self.last_scan = Some(now);
        self.listening
    }

    pub fn set_listening(&mut self, listening: bool) {
        self.listening = listening;
    }

    pub fn is_listening(&self) -> bool {
        self.listening
    }

    /// The listener asks at each tick whether scans have stopped for a freshness window. If so
    /// it is told to go, and what it heard is dropped with it.
    pub fn stop_if_idle(&mut self, now: Instant) -> bool {
        let idle = self
            .last_scan
            .is_none_or(|at| now.duration_since(at) > BEACON_FRESH);
        if idle {
            self.stop();
        }
        idle
    }

    /// The listener is gone: forget what it heard.
    pub fn stop(&mut self) {
        self.listening = false;
        self.entries.clear();
        self.conflicts.clear();
    }

    /// Takes one datagram.
    ///
    /// Three rules, because the datagram is untrusted: the serial must look like an EV3's
    /// (twelve hex digits, which is its Bluetooth address), so arbitrary strings cannot occupy
    /// the identity space; a still-fresh identity is never silently repointed at another
    /// address, the incumbent wins and the clash is recorded; and the cache is capped.
    ///
    /// Defence in depth, not a complete answer: the identity stays unverified until a session
    /// checks it against the serial it asked for.
    pub fn accept_datagram(
        &mut self,
        datagram: &[u8],
        sender: Ipv4Addr,
        now: Instant,
        now_epoch_ms: i64,
    ) {
        if self.local_addresses.contains(&sender) {
            return;
        }
        let Some(fields) = parse_beacon_message(&String::from_utf8_lossy(datagram)) else {
            return;
        };
        self.accept(
            BeaconInfo {
                ip: sender,
                port: fields.port,
                serial_number: fields.serial_number,
                protocol: fields.protocol,
                name: fields.name,
            },
            now,
            now_epoch_ms,
        );
    }

    fn accept(&mut self, info: BeaconInfo, now: Instant, now_epoch_ms: i64) {
        let key = info.serial_number.to_lowercase();
        if key.len() != 12 || !key.chars().all(|c| c.is_ascii_hexdigit()) {
            return;
        }

        let existing = self.entries.iter().position(|e| e.key == key);
        if let Some(index) = existing {
            let entry = &self.entries[index];
            if now.duration_since(entry.received_at) <= BEACON_FRESH && entry.info.ip != info.ip {
                self.conflicts.retain(|(k, _)| *k != key);
                self.conflicts.push((key, now));
                return;
            }
        } else if self.entries.len() >= BEACON_CACHE_MAX {
            // The oldest goes; on a tie, the one seen first.
            let mut oldest = 0;
            for (i, entry) in self.entries.iter().enumerate() {
                if entry.received_at < self.entries[oldest].received_at {
                    oldest = i;
                }
            }
            self.entries.remove(oldest);
        }

        let entry = Entry {
            key,
            info,
            received_at: now,
            received_epoch_ms: now_epoch_ms,
        };
        match existing {
            Some(index) => self.entries[index] = entry,
            None => self.entries.push(entry),
        }
    }

    /// Every fresh beacon, in arrival order. Drops what has gone stale.
    pub fn fresh(&mut self, now: Instant) -> Vec<SeenBeacon> {
        self.entries
            .retain(|e| now.duration_since(e.received_at) <= BEACON_FRESH);
        self.entries
            .iter()
            .map(|e| SeenBeacon {
                info: e.info.clone(),
                received_epoch_ms: e.received_epoch_ms,
            })
            .collect()
    }

    /// The fresh beacon for a serial, unless two addresses claimed it recently, when nobody can
    /// say which is the brick.
    pub fn find_fresh(&mut self, serial: &str, now: Instant) -> Option<BeaconInfo> {
        let key = serial.to_lowercase();
        if let Some(index) = self.conflicts.iter().position(|(k, _)| *k == key) {
            if now.duration_since(self.conflicts[index].1) <= BEACON_FRESH {
                return None;
            }
            self.conflicts.remove(index);
        }
        let entry = self.entries.iter().find(|e| e.key == key)?;
        (now.duration_since(entry.received_at) <= BEACON_FRESH).then(|| entry.info.clone())
    }
}
