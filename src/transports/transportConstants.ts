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
	/** HID report ID used for EV3 communication. */
	REPORT_ID: 0,
	/** Discovery scan interval (ms). */
	DISCOVERY_INTERVAL_MS: 1200,
	/** Expected command round-trip time (ms). */
	COMMAND_RTT_MS: 500,
	/** Maximum safe command rate (commands per second). */
	MAX_COMMANDS_PER_SEC: 10,
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
	/** Expected command round-trip time (ms). */
	COMMAND_RTT_MS: 1000,
	/** TCP keepalive interval (ms). */
	KEEPALIVE_MS: 3000,
	/** Discovery scan interval (ms). */
	DISCOVERY_INTERVAL_MS: 5000,
	/** ACK byte sent to EV3 after beacon received. */
	BEACON_ACK: 0x00,
} as const;

// ── Bluetooth ───────────────────────────────────────────────────────

export const BT = {
	/** LEGO OUI prefix for BT MAC address filtering. */
	LEGO_OUI: '001653',
	/** SPP (Serial Port Profile) UUID for EV3 RFCOMM. */
	SPP_UUID: '00001101-0000-1000-8000-00805f9b34fb',
	/** Discovery scan interval (ms) — BT discovery is slow. */
	DISCOVERY_INTERVAL_MS: 10000,
	/** Connection timeout (ms). */
	CONNECT_TIMEOUT_MS: 6000,
	/** Expected command round-trip time (ms). */
	COMMAND_RTT_MS: 2000,
	/** Mandatory cooldown between sequential RFCOMM connections (ms). */
	INTER_CONNECTION_COOLDOWN_MS: 15000,
	/** Recovery cooldown after RFCOMM error (ms, base value). */
	ERROR_RECOVERY_COOLDOWN_MS: 30000,
	/** WinRT .NET helper startup timeout (ms). */
	WINRT_STARTUP_TIMEOUT_MS: 8000,
	/** Default EV3 pairing PIN. */
	PAIRING_PIN: '1234',
} as const;

// ── Firmware safety ─────────────────────────────────────────────────

export const FIRMWARE_SAFETY = {
	/** Maximum commands per second per brick (across all transports). */
	MAX_COMMANDS_PER_SEC: 10,
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
	/** Maximum reconnect attempts before giving up. */
	MAX_RECONNECT_ATTEMPTS: 10,
} as const;
