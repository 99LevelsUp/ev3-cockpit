import * as vscode from 'vscode';
import { Transport } from './enums';
import { BrickKey } from './brickKey';
import { DiscoveryItem, PortState } from './models';

/** Opaque handle returned by a successful connect(). */
export interface SessionHandle {
	readonly brickKey: BrickKey;
	readonly transport: Transport;
}

/** Declares optional capabilities of a transport provider. */
export interface TransportCapabilities {
	/** Provider can report signal strength info. */
	readonly supportsSignalInfo: boolean;
	/**
	 * Provider can remove OS-level evidence of a brick (unpair, drop a registry
	 * entry). Declared rather than inferred from `forget` being present, so the UI
	 * can decide whether to offer the action without probing for a method.
	 */
	readonly supportsForget: boolean;
	/**
	 * Provider can execute a composed telemetry frame.
	 *
	 * True for every transport that puts bytes on a wire, because a frame is bytecode and
	 * the brick's own VM runs it. False for a provider that simulates command *semantics*
	 * instead — the mock answers typed commands and has no interpreter, so a frame is the
	 * one command it cannot serve.
	 *
	 * Declared rather than inferred from `createCommandChannel` being present, for the same
	 * reason as `supportsForget`: telemetry has to decide whether to start on a session
	 * without first sending a frame to find out. The alternative is discovering it as a
	 * thrown error on every tick.
	 */
	readonly supportsTelemetryFrames: boolean;
}

/**
 * What a command channel does, stated here so the transport contract can name it
 * without importing the command layer — which sits above it.
 */
export interface CommandChannelLike {
	execute(command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse>;
}

/** Per-command overrides a caller may pass through a provider to the adapter. */
export interface SendCommandOptions {
	/**
	 * Round-trip budget in milliseconds; omit to get the transport's own value.
	 *
	 * Zero or less disables the timeout entirely, so the send waits indefinitely.
	 * That is a sentinel, not "do not wait" — spell an immediate give-up with an
	 * already-aborted `signal`.
	 */
	readonly timeoutMs?: number;
	/** Abort signal for cooperative cancellation. */
	readonly signal?: AbortSignal;
}

/** Result of a single discovery scan for one transport. */
export interface DiscoveryScanResult {
	readonly transport: Transport;
	readonly items: DiscoveryItem[];
}

// ── Command types ────────────────────────────────────────────────────

/** Typed command sent to a brick via {@link TransportProvider.send}. */
export type BrickCommand =
	| { readonly kind: 'battery' }
	| { readonly kind: 'ports' }
	| { readonly kind: 'buttons' }
	| { readonly kind: 'info' }
	/**
	 * A telemetry frame the assembler already built.
	 *
	 * The odd one out: every other command here names *what* to read and lets
	 * `buildCommand` decide the bytecode, but a telemetry frame is composed at run time from
	 * whichever rows come up on a tick, so its bytecode cannot be a function of its kind.
	 *
	 * It goes through this union rather than straight down to the transport so telemetry sits
	 * in the same per-brick queue as the heartbeat and the user's own commands. Sending it
	 * around the queue would let a tick race the heartbeat, which is the failure the
	 * one-frame-in-flight rule exists to prevent.
	 */
	| {
		readonly kind: 'telemetry:frame';
		/** Declared globals word followed by bytecode, from `buildTelemetryFrame`. */
		readonly payload: Uint8Array;
	}
	/**
	 * Rename the brick.
	 *
	 * The one command here that changes what the brick *is* rather than reading it. The
	 * firmware writes the name to `./settings/BrickName`, calls `sethostname`, and pushes it
	 * straight into the Bluetooth controller via `cBtSetName` — so the advertised BT name
	 * changes without a reboot (read from `c_com.c`, `case SET_BRICKNAME`).
	 *
	 * The firmware validates the string and rejects anything from `vmBRICKNAMESIZE` (120)
	 * bytes including the terminator, so 118 characters is the usable ceiling.
	 */
	| { readonly kind: 'brick:setName'; readonly name: string }
	/**
	 * Switch the brick's Bluetooth radio on or off.
	 *
	 * Takes the hardware selector the firmware expects (`HW_BT`) as well as the flag —
	 * `SET_ON_OFF` reads two `DATA8` parameters, not one.
	 *
	 * **Expect this to fail while the radio is busy, and retry rather than give up.**
	 * `BtSetOnOff` returns FAIL for exactly one reason: the HCI socket is mid-operation
	 * (`c_bt.c`). Asking for a state the brick is already in is *not* a failure — the
	 * firmware handles that and answers OK. Measured 04.09.2026: the command errored
	 * immediately after 30 s of Bluetooth scanning and succeeded first try a few seconds
	 * later, with nothing else changed.
	 */
	| { readonly kind: 'brick:setBluetooth'; readonly on: boolean }
	/** Make the brick discoverable, or stop it answering inquiries. Same two-parameter shape. */
	| { readonly kind: 'brick:setBluetoothVisible'; readonly visible: boolean }
	| { readonly kind: 'fs:list'; readonly path: string }
	| { readonly kind: 'fs:read'; readonly path: string }
	| { readonly kind: 'fs:write'; readonly path: string; readonly content: string }
	| { readonly kind: 'fs:exists'; readonly path: string }
	| { readonly kind: 'fs:delete'; readonly path: string }
	// Handle-level transfer steps. The FileTransferService sequences these; callers
	// wanting a whole file use the service, not these directly.
	| {
		readonly kind: 'fs:beginWrite';
		readonly path: string;
		/** Total size of the file being written, which the brick preallocates. */
		readonly totalBytes: number;
		/** First chunk, carried by BEGIN_DOWNLOAD itself. */
		readonly chunk: Uint8Array;
	}
	| { readonly kind: 'fs:continueWrite'; readonly handle: number; readonly chunk: Uint8Array }
	| { readonly kind: 'fs:beginRead'; readonly path: string; readonly wantBytes: number }
	| { readonly kind: 'fs:continueRead'; readonly handle: number; readonly wantBytes: number }
	| { readonly kind: 'fs:closeHandle'; readonly handle: number }
	| { readonly kind: 'fs:size'; readonly path: string }
	| { readonly kind: 'fs:freeSpace' }
	| { readonly kind: 'fs:makeDirectory'; readonly path: string }
	/** Copies rather than moves: the firmware's MOVE subcode leaves the source. */
	| { readonly kind: 'fs:copy'; readonly from: string; readonly to: string }
	/** Recursive delete. `fs:delete` refuses a populated directory; this does not. */
	| { readonly kind: 'fs:removeTree'; readonly path: string }
	/** Continues a listing the brick could not fit in one reply. */
	| {
		readonly kind: 'fs:listContinue';
		readonly handle: number;
		readonly wantBytes: number;
	};

// ── Response types ───────────────────────────────────────────────────

export interface BatteryResponse {
	readonly kind: 'battery';
	/** Charge level in percent (0-100). */
	readonly level: number;
	/** Battery voltage in volts, where the transport reports it. */
	readonly voltage?: number;
	/** Battery current draw in amps, where the transport reports it. */
	readonly currentAmps?: number;
}
export interface PortsResponse { readonly kind: 'ports'; readonly motorPorts: PortState[]; readonly sensorPorts: PortState[] }
export interface ButtonsResponse { readonly kind: 'buttons'; readonly state: Record<string, boolean> }
export interface InfoResponse {
	readonly kind: 'info';
	/** The brick's own user-visible name, as set on the brick itself. */
	readonly displayName: string;
	readonly firmwareVersion?: string;
	/** Linux kernel version string reported by the brick. */
	readonly osVersion?: string;
}
/** One entry in a directory listing. */
export interface FsEntry {
	readonly name: string;
	/**
	 * `unknown` when the line matched neither the directory nor the file shape — kept
	 * rather than dropped, so a firmware that formats differently is visible.
	 */
	readonly kind: 'file' | 'directory' | 'unknown';
	/** Byte size, which the brick includes for files only. */
	readonly bytes?: number;
	/** MD5 the brick computed, lowercase hex. Files only. */
	readonly md5?: string;
}

export interface FsListContinueResponse {
	readonly kind: 'fs:listContinue';
	readonly entries: FsEntry[];
	readonly complete: boolean;
	readonly handle?: number;
}

export interface FsListResponse {
	readonly kind: 'fs:list';
	readonly entries: FsEntry[];
	/** False when the brick has more of this listing to hand over. */
	readonly complete: boolean;
	/** Handle to continue the listing with, when it is not complete. */
	readonly handle?: number;
}
export interface FsReadResponse { readonly kind: 'fs:read'; readonly content: string }
export interface FsWriteResponse { readonly kind: 'fs:write' }

/**
 * Acknowledgement of a setting written to the brick.
 *
 * Carries nothing back. The firmware answers a bare status and rejects a bad value in
 * silence, so the only proof a rename or a radio toggle took effect is to observe the brick
 * afterwards — read the name back with `info`, or watch whether it still answers an inquiry.
 */
export interface BrickSettingResponse {
	readonly kind: 'brick:setName' | 'brick:setBluetooth' | 'brick:setBluetoothVisible';
}
export interface FsExistsResponse { readonly kind: 'fs:exists'; readonly exists: boolean }
export interface FsDeleteResponse { readonly kind: 'fs:delete'; readonly deleted: boolean }

/** Shared shape of every handle-level transfer reply. */
export interface FsTransferStep {
	/** Brick-assigned file handle. Invalid once `endOfFile` is true. */
	readonly handle: number;
	/**
	 * The brick reported END_OF_FILE for this step.
	 *
	 * On a write it means the declared size has been received; on a read, that this
	 * chunk is the last. Either way the firmware has already closed the handle.
	 */
	readonly endOfFile: boolean;
}

export interface FsBeginWriteResponse extends FsTransferStep { readonly kind: 'fs:beginWrite' }
export interface FsContinueWriteResponse extends FsTransferStep { readonly kind: 'fs:continueWrite' }
export interface FsBeginReadResponse extends FsTransferStep {
	readonly kind: 'fs:beginRead';
	/** Total file size the brick reports, so a caller can size its buffer. */
	readonly totalBytes: number;
	readonly chunk: Uint8Array;
}
export interface FsContinueReadResponse extends FsTransferStep {
	readonly kind: 'fs:continueRead';
	readonly chunk: Uint8Array;
}
export interface FsCloseHandleResponse { readonly kind: 'fs:closeHandle' }

export interface FsSizeResponse {
	readonly kind: 'fs:size';
	/**
	 * Kilobytes, rounded up, as the firmware computes them. For a directory, the sum
	 * over its tree.
	 *
	 * Not bytes: a 3-byte file reports 1. For an exact file size use a directory
	 * listing, whose entries carry a byte count.
	 */
	readonly kilobytes: number;
	/**
	 * Files the total covers.
	 *
	 * **Zero for a plain file.** The firmware counts entries only while walking a
	 * directory; handed a file it adds the size and never enters the loop.
	 */
	readonly files: number;
}
export interface FsFreeSpaceResponse {
	readonly kind: 'fs:freeSpace';
	/** Kilobytes, as the firmware reports them. */
	readonly totalKb: number;
	readonly freeKb: number;
}
export interface FsMakeDirectoryResponse {
	readonly kind: 'fs:makeDirectory';
	/** True when the directory exists afterwards, whether or not it existed before. */
	readonly exists: boolean;
}
export interface FsCopyResponse { readonly kind: 'fs:copy' }
export interface FsRemoveTreeResponse { readonly kind: 'fs:removeTree' }

/** Union of all possible brick responses. Narrow on `kind` to access typed fields. */
export type BrickResponse =
	| FsListContinueResponse
	| FsSizeResponse
	| FsFreeSpaceResponse
	| FsMakeDirectoryResponse
	| FsCopyResponse
	| FsRemoveTreeResponse
	| FsBeginWriteResponse
	| FsContinueWriteResponse
	| FsBeginReadResponse
	| FsContinueReadResponse
	| FsCloseHandleResponse
	| BatteryResponse
	| PortsResponse
	| ButtonsResponse
	| InfoResponse
	| FsListResponse
	| FsReadResponse
	| FsWriteResponse
	| BrickSettingResponse
	| FsExistsResponse
	| FsDeleteResponse
	| TelemetryFrameResponse;

/**
 * A telemetry frame's reply, handed back as bytes.
 *
 * Deliberately unparsed. Only the assembler knows where each row's result landed, and it
 * returns that layout with the frame — a parser that re-derives offsets is the bug plan
 * 3.1.4a caught, where four bytes were read from a slot the firmware filled one byte of.
 */
export interface TelemetryFrameResponse {
	readonly kind: 'telemetry:frame';
	readonly payload: Uint8Array;
}

// ── Provider interface ───────────────────────────────────────────────

/**
 * Unified contract that every transport channel (mock, usb, tcp, bt) must implement.
 *
 * All methods that touch hardware or I/O return Promises so that the runtime
 * can schedule them without blocking the extension host.
 *
 * `recover` and `forget` are optional — implement them only when the transport
 * supports these operations. Check for method presence (`provider.recover?.`) before calling.
 */
export interface TransportProvider extends vscode.Disposable {
	/** Which transport this provider handles. */
	readonly transport: Transport;

	/**
	 * How strongly traffic prefers this transport when a brick is reachable over several;
	 * higher wins.
	 *
	 * Declared here, by each transport, so nothing above the providers names one: a new
	 * transport sets its own priority and routing picks it up unchanged. USB 30, Bluetooth 20,
	 * TCP 10, mock 0 — the owner's order, USB → BT → TCP (step-1 plan, D2).
	 */
	readonly priority: number;

	/** Declared capabilities of this provider. */
	readonly capabilities: TransportCapabilities;

	/** Run one discovery scan and return the currently visible bricks. */
	discover(): Promise<DiscoveryScanResult>;

	/** Establish a connection to the brick. */
	connect(brickKey: BrickKey): Promise<SessionHandle>;

	/** Terminate the connection to the brick. */
	disconnect(brickKey: BrickKey): Promise<void>;

	/**
	 * Sends one packet to a connected brick and returns the reply packet.
	 *
	 * Byte level on purpose: a transport carries frames and knows nothing about what a
	 * command means. Typing lives in the command layer above, which owns the codec and
	 * the message counter.
	 *
	 * `options` reaches the adapter, so a caller can set a round-trip budget or pass an
	 * abort signal. Omitting it uses the transport's default.
	 */
	sendPacket(
		brickKey: BrickKey,
		packet: Uint8Array,
		options?: SendCommandOptions & { expectedMessageCounter?: number },
	): Promise<Uint8Array>;

	/**
	 * Supplies a command channel instead of letting one be built over `sendPacket`.
	 *
	 * Only the mock implements this. A mock brick simulates command semantics, not USB
	 * framing, so asking it to decode real packets back into commands would be work in
	 * service of nothing. Real transports leave this undefined and the caller wraps
	 * `sendPacket` in a `PacketCommandChannel`.
	 */
	createCommandChannel?(brickKey: BrickKey): CommandChannelLike;

	/**
	 * Largest packet the live link to this brick carries, in bytes.
	 *
	 * Present only where the answer is not simply the firmware's own 1024-byte buffer.
	 * USB implements it because the same brick carries 1024 bytes over libusb and 64 over
	 * HID, and both transfer chunking and whether a two-path command fits at all follow
	 * from which backend the connection landed on. `undefined` means the firmware default.
	 */
	maxPacketBytes?(brickKey: BrickKey): number | undefined;

	/**
	 * Attempt to re-establish a lost connection.
	 * Present only on providers that support connection recovery.
	 */
	recover?(brickKey: BrickKey): Promise<SessionHandle>;

	/**
	 * Remove OS-level evidence for a brick (e.g. BT unpairing).
	 * Present only on providers that support the forget operation.
	 */
	forget?(brickKey: BrickKey): Promise<void>;
}
