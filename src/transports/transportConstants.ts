/**
 * Transport timing constants derived from empirical lab measurements.
 *
 * These values govern discovery intervals, command timeouts, rate limits,
 * and safety cooldowns. They are tuned for real EV3 brick behavior and
 * should not be changed without lab validation.
 */

// ── USB ─────────────────────────────────────────────────────────────

export const USB = {
	/** LEGO EV3 USB Vendor ID. */
	VENDOR_ID: 0x0694,
	/** LEGO EV3 USB Product ID. */
	PRODUCT_ID: 0x0005,
	/** EV3 recovery mode Product ID. */
	RECOVERY_PRODUCT_ID: 0x0006,
	/** HID report size in bytes (1 byte report ID + 1024 payload). */
	REPORT_SIZE: 1025,
	/**
	 * Largest EV3 packet a HID write actually delivers, in bytes.
	 *
	 * Measured, not declared: `node-hid`'s `write()` returns 65 whatever report length
	 * it is handed, so one report id plus 64 payload bytes reach the brick and anything
	 * beyond is dropped by the OS.
	 *
	 * The same 64 bytes bound replies. A verified round trip diverges at file byte 52
	 * whatever chunk size is used, and 52 is exactly this frame less BEGIN_UPLOAD's
	 * 12-byte reply header — so the limit is symmetric, not write-only.
	 *
	 * **The cause is the brick's own descriptor, not node-hid.** Its HID report descriptor
	 * declares `Report Count 0` for both reports, so Windows derives no usable report
	 * length — while the interrupt endpoints underneath advertise `wMaxPacketSize` 1024.
	 * Nothing above HID can lift this, which is why {@link UsbLibusbAdapter} exists and is
	 * the preferred backend: over libusb the same brick carries the full 1024 bytes and
	 * moves bulk data about forty times faster.
	 *
	 * This figure therefore applies to the HID fallback only. Ask the live session for
	 * `maxPacketBytes` rather than reading it here — a USB link's frame depends on which
	 * backend the connection landed on.
	 */
	MAX_WRITE_PACKET_BYTES: 64,
	/** HID report ID used for EV3 communication. */
	REPORT_ID: 0,
	/** Discovery scan interval (ms). */
	DISCOVERY_INTERVAL_MS: 1200,
	/**
	 * Measured worst-case command round trip (ms).
	 *
	 * 9 ms observed over 40 exchanges on firmware V1.10E, including the `ports`
	 * command's 16 sub-operations. The previous value of 500 was ~50x pessimistic and
	 * was never read by any code.
	 */
	COMMAND_RTT_MS: 10,
	/**
	 * Round-trip budget before a send is abandoned (ms).
	 *
	 * Roughly 100x the measured round trip: this detects a dead link, it is not a
	 * performance target, so it stays far above normal jitter.
	 */
	SEND_TIMEOUT_MS: 1000,
	/**
	 * Sustained command rate measured over 600 back-to-back commands.
	 *
	 * Not a safety ceiling — an observed capability. No error and no latency drift
	 * at this rate, so the limit is the round trip, not the firmware.
	 */
	MAX_COMMANDS_PER_SEC: 176,
} as const;

// ── TCP ─────────────────────────────────────────────────────────────

export const TCP = {
	/** Standard EV3 TCP port. */
	PORT: 5555,
	/** UDP beacon discovery port. */
	BEACON_PORT: 3015,
	/** Timeout waiting for UDP beacon response (ms). */
	BEACON_TIMEOUT_MS: 4000,
	/** Timeout for VMTP1.0 unlock handshake (ms). */
	UNLOCK_TIMEOUT_MS: 2000,
	/**
	 * Measured worst-case command round trip (ms).
	 *
	 * 58 ms observed over 40 exchanges against a brick on Wi-Fi, averaging 33 ms.
	 * Samples alternate between roughly 15 ms and 50 ms, which looks like delayed
	 * ACK on the brick side; `setNoDelay` is already on at this end. The previous
	 * value of 1000 was ~17x pessimistic and read by no code.
	 */
	COMMAND_RTT_MS: 60,
	/**
	 * Sustained command rate measured over 600 back-to-back commands: 61.7/s at a
	 * 16 ms median, no drift and no errors.
	 */
	MAX_COMMANDS_PER_SEC: 62,
	/** Round-trip budget before a send is abandoned (ms), ~17x the measured value. */
	SEND_TIMEOUT_MS: 1000,
	/**
	 * How often to send a datagram that keeps the inbound beacon path open (ms).
	 *
	 * A host firewall that filters unsolicited inbound UDP drops the brick's beacon
	 * outright, and Windows does that by default: the brick broadcasts every 5 s and
	 * nothing arrives. Sending outbound first puts the socket into the firewall's
	 * stateful table, after which the beacons come through. Kept under the firewall's
	 * UDP mapping lifetime, which is short.
	 */
	BEACON_PRIME_INTERVAL_MS: 4000,
	/**
	 * Most beacons held at once.
	 *
	 * Anything on the subnet can announce, so without a cap one datagram per invented
	 * serial grows the map and fills the brick list with attacker-chosen strings.
	 */
	BEACON_CACHE_MAX: 64,
	/** Longest accepted brick name in a beacon; the brick's own field holds 16. */
	BEACON_NAME_MAX: 32,
	/** TCP keepalive interval (ms). */
	KEEPALIVE_MS: 3000,
	/** Discovery scan interval (ms). */
	DISCOVERY_INTERVAL_MS: 5000,
	/** ACK byte sent to EV3 after beacon received. */
	BEACON_ACK: 0x00,
	/** How long a received beacon remains fresh (ms). */
	BEACON_FRESH_MS: 15_000,
} as const;

// ── Bluetooth ───────────────────────────────────────────────────────

export const BT = {
	/** LEGO OUI prefix for BT MAC address filtering. */
	LEGO_OUI: '001653',
	/** SPP (Serial Port Profile) UUID for EV3 RFCOMM. */
	SPP_UUID: '00001101-0000-1000-8000-00805f9b34fb',
	/** Discovery scan interval (ms) — BT discovery is slow. */
	DISCOVERY_INTERVAL_MS: 10000,
	/**
	 * RFCOMM connection timeout (ms).
	 *
	 * A measured open took 4851 ms, so the previous 6000 left only a 1.2x margin and
	 * would have failed a normal connect under any extra latency.
	 */
	CONNECT_TIMEOUT_MS: 15000,
	/**
	 * Measured worst-case command round trip (ms).
	 *
	 * 121 ms observed over 30 exchanges via SPP on firmware V1.10E, averaging 55-70 ms.
	 * The previous value of 2000 was ~16x pessimistic and read by no code.
	 */
	COMMAND_RTT_MS: 130,
	/**
	 * Sustained command rate measured over 600 back-to-back commands: 10.7/s at a
	 * 102 ms median, no drift.
	 *
	 * The one transport where the old global 10 cmd/s figure was about right, and by
	 * coincidence: SPP's round trip lands there on its own. Note the link is also
	 * bandwidth-bound at 115200 baud (~11 KB/s), so a chunked transfer over BT is
	 * limited by payload size as much as by command count.
	 */
	MAX_COMMANDS_PER_SEC: 11,
	/**
	 * Round-trip budget before a send is abandoned (ms). Roughly 16x the measured
	 * round trip — more headroom than the other transports get, because RFCOMM is
	 * the least predictable of the three.
	 */
	SEND_TIMEOUT_MS: 2000,
	/** Mandatory cooldown between sequential RFCOMM connections (ms). */
	INTER_CONNECTION_COOLDOWN_MS: 15000,
	/** Recovery cooldown after RFCOMM error (ms, base value). */
	ERROR_RECOVERY_COOLDOWN_MS: 30000,
	/**
	 * How long a queued connect waits for a slot before it fails with a stated reason
	 * (DESIGN §3.3) instead of queuing indefinitely.
	 *
	 * Comfortably above the 30 s cooldown ceiling (`ERROR_RECOVERY_COOLDOWN_MS`, which
	 * `BtConnectionQueue`'s backoff never exceeds), so this only fires when another open or
	 * pairing holds the slot for longer — a pairing waiting for a person at the brick can —
	 * never for an ordinary cooldown.
	 */
	QUEUE_ACQUIRE_TIMEOUT_MS: 45000,
	/** Default EV3 pairing PIN. */
	PAIRING_PIN: '1234',
} as const;

// ── Firmware safety ─────────────────────────────────────────────────

export const FIRMWARE_SAFETY = {
	/**
	 * Backstop command rate per brick, transport-agnostic.
	 *
	 * This was 10 for every transport, on no recorded basis. Measured sustained rates
	 * are USB 176, TCP 62, BT 11 commands per second — so the old figure was 17x
	 * pessimistic on USB, 6x on TCP, and roughly right on BT only because BT's round
	 * trip happens to land there. None of the three showed an error or any latency
	 * drift at its own ceiling.
	 *
	 * Commands are strictly serial — each adapter holds one in-flight exchange — so a
	 * transport cannot exceed 1/RTT however hard a caller pushes. That makes each
	 * transport self-limiting and this value a guard against a pathological caller
	 * (a retry storm, a runaway loop), not a meter on normal traffic. Prefer the
	 * per-transport `MAX_COMMANDS_PER_SEC` when the transport is known.
	 */
	MAX_COMMANDS_PER_SEC: 200,
	/** Minimum heartbeat interval (ms) — below this risks firmware stress. */
	MIN_HEARTBEAT_INTERVAL_MS: 3000,
	/** Cooldown between transport mode switches (ms). */
	TRANSPORT_SWITCH_COOLDOWN_MS: 2000,
	/** Number of consecutive failures before marking brick as degraded. */
	DEGRADATION_THRESHOLD: 3,
	/** Reconnect backoff base interval (ms). */
	RECONNECT_BASE_MS: 1000,
	/** Reconnect backoff maximum interval (ms). */
	RECONNECT_MAX_MS: 30000,
	/** Reconnect backoff multiplier. */
	RECONNECT_MULTIPLIER: 2,
	/**
	 * Maximum reconnect attempts before giving up.
	 *
	 * `Infinity`: a session the user signed in to keeps trying for as long as the sign-in
	 * stands. Signing out is the only thing that ends it, which is the whole distinction —
	 * unplugging a cable is the world's doing, signing out is the user's.
	 *
	 * It used to be 10, which with the backoff below spanned about three minutes. A brick
	 * unplugged for longer than that was never picked up again, even while discovery kept
	 * seeing it: the session had reached Disconnected and nothing wakes a session in that
	 * state. Measured on a brick — it came back 35 seconds after the session had given up,
	 * and nothing happened.
	 *
	 * Retrying forever costs nothing here: the delay caps at RECONNECT_MAX_MS, and discovery
	 * makes the attempt immediate whenever it can see the brick, so the slow tail only runs
	 * for transports that cannot be discovered.
	 */
	MAX_RECONNECT_ATTEMPTS: Number.POSITIVE_INFINITY,
} as const;
