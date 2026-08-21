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
	| { readonly kind: 'fs:closeHandle'; readonly handle: number };

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
export interface FsListResponse { readonly kind: 'fs:list'; readonly entries: string[] }
export interface FsReadResponse { readonly kind: 'fs:read'; readonly content: string }
export interface FsWriteResponse { readonly kind: 'fs:write' }
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

/** Union of all possible brick responses. Narrow on `kind` to access typed fields. */
export type BrickResponse =
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
	| FsExistsResponse
	| FsDeleteResponse;

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
