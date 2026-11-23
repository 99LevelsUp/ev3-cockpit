---
topic: Transports
last_compiled: 2026-11-23
status: active
---

# Transports

## Purpose [coverage: high — 8 sources]

`daemon/crates/transports` (`ev3-transports`) is the I/O layer to the bricks over USB, TCP and Bluetooth: the provider trait every transport implements, the request-reply machinery the byte links share, and record and replay at the provider level. A provider carries bytes and knows nothing about what a command means; the [runtime](runtime.md) above owns the codec ([protocol](protocol.md)).

## Architecture [coverage: high — 8 sources]

- **`provider.rs`** — `TransportProvider`: `transport`, `priority`, `capabilities`, `discover`, `connect`, `disconnect`, `send_packet`, `max_packet_bytes`, `open_probe`, and with defaults `recover`, `forget`, `pair`, `check_presence`, `dispose`. Also `DiscoveryItem`, `DiscoveryScanResult`, `SessionHandle`, `TransportCapabilities`.
- **`brick_key.rs`** — `BrickKey` (`transport:id`, one channel to one brick) and `Transport`.
- **`pending.rs`** — the exchange every byte link shares: message counters, the round-trip timer, stepping over stale replies, discarding what an abandoned exchange left.
- **`usb/`** — libusb through `rusb` (vendored libusb) at the brick's full 1024-byte frame, preferred; HID through `hidapi`, 64 bytes per packet, as the loud fallback. Discovery reads both enumerations and never opens a device a link holds.
- **`tcp/`** — the UDP beacon on port 3015 (bound only while scanning, with an outbound datagram to open host firewalls), a bounded untrusted beacon cache, and the TCP link with the unlock handshake.
- **`bt/`** — shared Bluetooth parts: `BtConnectionQueue` (every operation that pages the radio takes its turn) and the presence monitor.
- **`bt_windows/`** — Winsock `AF_BTH` RFCOMM on channel 1, non-blocking and driven by tokio; presence by uncached SDP; discovery from `bthprops` and a WinRT inquiry; pairing through WinRT `DeviceInformationCustomPairing` on a thread of its own; forget through `bthprops`.
- **`bt_linux/`** — RFCOMM and L2CAP through libc sockets; BlueZ over `zbus` behind a trait (fake BlueZ in tests); an agent of its own answering PIN 1234; presence as an L2CAP connect to PSM 1; the radio watch that restarts an adapter that stopped answering; the `bluetooth` group offer through `pkexec`.
- **`policy.rs`** — which providers a daemon may build from its channel and mode.
- **`recorder.rs`, `replay.rs`, `fixture.rs`, `scrub.rs`** — record a session at the provider trait with identifiers replaced by placeholders, and replay it strictly or matched ([testing](testing.md)).

## Talks To [coverage: high — 6 sources]

- **protocol** — the links frame and unframe packets (`ev3-protocol`).
- **runtime** — sessions call `connect`, `send_packet`, `recover`; discovery calls `discover`; the brick layer calls `pair`, `forget`, `check_presence`. The runtime's consent and activity ports reach the Linux provider through `bt_linux/access.rs`.
- **The OS** — libusb and hidapi, `ws2_32`, `bthprops` and WinRT (`windows`, `windows-sys` crates), BlueZ on the system bus, libc sockets.

## Data [coverage: medium — 3 sources]

`bt/queue.rs`: 15 s between connection openings, 30 s after a failure, backoff capped at 30 s, 45 s to wait for a turn; a brick gets 5 s after its own close before it is connected again (`RECONNECT_GAP_AFTER_CLOSE`), and a new daemon treats a busy brick within 5 s of its start as retryable. The rate guard lives in the runtime (`guard.rs`).

## Key Decisions [coverage: high — 5 sources]

- **Byte level on purpose** — the codec and message counter belong to the command layer, so the lowest layer does not own the command vocabulary.
- **libusb first, HID loudly** — HID's 64-byte ceiling is a defect in the brick's descriptor; a silent fallback would look working and transfer 40× slower.
- **Bluetooth in the daemon** — Winsock for data, WinRT for pairing, BlueZ over `zbus` on Linux; no helper process (native plan KTD5, KTD6). The serial-port (SPP) fallback was not ported.
- **Opening is serialised, holding is not** — several Bluetooth sessions can be held at once; only the radio's paging operations queue.
- **Record and replay at the provider trait** — everything above runs unchanged on a recording (native plan KTD7).

## Gotchas [coverage: medium — 3 sources]

- **TCP unlock** — the brick wants a handshake before it accepts commands; it authenticates nothing, so the beacon cache's bounds are security properties.
- **Linux USB** — the kernel's `usbhid` holds the interface; the link detaches it and clears the halt on both endpoints. The udev rule `native/linux/70-lego-ev3.rules` grants the user the device.
- **Windows USB reads** — libusb's HID backend counts the report id, reporting 1025 bytes for a 1024-byte frame.

## Sources

- [daemon/crates/transports/src/lib.rs](../../daemon/crates/transports/src/lib.rs)
- [daemon/crates/transports/src/provider.rs](../../daemon/crates/transports/src/provider.rs)
- [daemon/crates/transports/src/pending.rs](../../daemon/crates/transports/src/pending.rs)
- [daemon/crates/transports/src/usb/mod.rs](../../daemon/crates/transports/src/usb/mod.rs)
- [daemon/crates/transports/src/tcp/mod.rs](../../daemon/crates/transports/src/tcp/mod.rs)
- [daemon/crates/transports/src/bt/queue.rs](../../daemon/crates/transports/src/bt/queue.rs)
- [daemon/crates/transports/src/bt_windows/mod.rs](../../daemon/crates/transports/src/bt_windows/mod.rs)
- [daemon/crates/transports/src/bt_linux/mod.rs](../../daemon/crates/transports/src/bt_linux/mod.rs)
- [DESIGN.md](../../DESIGN.md) §4.1
