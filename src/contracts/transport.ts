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
	| { readonly kind: 'fs:delete'; readonly path: string };

// ── Response types ───────────────────────────────────────────────────

export interface BatteryResponse { readonly kind: 'battery'; readonly level: number; readonly voltage?: number }
export interface PortsResponse { readonly kind: 'ports'; readonly motorPorts: PortState[]; readonly sensorPorts: PortState[] }
export interface ButtonsResponse { readonly kind: 'buttons'; readonly state: Record<string, boolean> }
export interface InfoResponse { readonly kind: 'info'; readonly displayName: string; readonly firmwareVersion?: string }
export interface FsListResponse { readonly kind: 'fs:list'; readonly entries: string[] }
export interface FsReadResponse { readonly kind: 'fs:read'; readonly content: string }
export interface FsWriteResponse { readonly kind: 'fs:write' }
export interface FsExistsResponse { readonly kind: 'fs:exists'; readonly exists: boolean }
export interface FsDeleteResponse { readonly kind: 'fs:delete'; readonly deleted: boolean }

/** Union of all possible brick responses. Narrow on `kind` to access typed fields. */
export type BrickResponse =
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

	/** Send a typed command to a connected brick and receive a typed response. */
	send(brickKey: BrickKey, command: BrickCommand): Promise<BrickResponse>;

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
