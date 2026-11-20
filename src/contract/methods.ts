/**
 * Every request a client sends the daemon, with its parameters and result.
 *
 * Names follow LSP's `area/action` form. A request that changes a brick takes the brick's write
 * lease for exactly its own length; work of several steps is one request, so no client ever holds
 * a lease between requests. Stop and emergency stop never wait for a lease.
 */

import type {
	AccessMode, BrickInfo, BrickRef, BrickStatus, ContractBrick, ContractChain, DaemonStatus, DeployFile,
	DeployResult, FileSize, FsEntry, LaunchSpec, ProgramState, RemoveReport, SettingValue, ShellResult,
	StorageUsage, TelemetryRequest, TelemetryRowInfo, TelemetryValue,
} from './models';

/** A brick named by the caller. A CLI connection may leave it out when exactly one brick is connected. */
interface OnBrick {
	readonly brick?: BrickRef;
}

/** A request a person confirmed: only honoured from VS Code and CLI connections. */
interface PersonConfirmed {
	readonly confirmedByPerson?: boolean;
}

export interface Methods {
	// --- daemon -----------------------------------------------------------
	'daemon/status': { params: Record<string, never>; result: DaemonStatus };
	/** Replace the daemon now; brick connections are cut and restored by the successor. */
	'daemon/restart': { params: PersonConfirmed & { readonly launch?: LaunchSpec }; result: { readonly accepted: boolean } };
	/** A newer client asks to replace the daemon once it is idle. */
	'daemon/registerReplacement': { params: { readonly launch: LaunchSpec }; result: { readonly accepted: boolean; readonly reason?: string } };
	/** A notification a client showed a person, for the daemon's log. */
	'log/notice': { params: { readonly level: 'info' | 'warning' | 'error'; readonly text: string }; result: null };

	// --- bricks -----------------------------------------------------------
	'bricks/list': { params: { readonly waitForDiscovery?: boolean }; result: readonly ContractBrick[] };
	/** Connect a brick for this client, pairing on the way; `hold` keeps it past this client (`ev3 connect`). */
	'bricks/connect': { params: OnBrick & { readonly hold?: boolean }; result: ContractBrick };
	/** Drop this client's hold; `forEveryone` signs the brick out whoever holds it. */
	'bricks/disconnect': { params: OnBrick & { readonly forEveryone?: boolean; readonly releaseHold?: boolean }; result: { readonly stillHeldBy: readonly string[] } };
	'bricks/info': { params: OnBrick; result: BrickInfo };
	'bricks/storage': { params: OnBrick; result: StorageUsage };
	/** Pair over Bluetooth; the person confirms on the brick. */
	'bricks/pair': { params: OnBrick; result: { readonly paired: boolean; readonly message?: string } };
	/** Unpair on this computer and on the brick; asks the person first. */
	'bricks/forget': { params: OnBrick & PersonConfirmed; result: { readonly forgotten: boolean; readonly report: readonly string[] } };
	/** Remove entries from the brick's list of paired devices; asks the person first. */
	'bricks/clearBluetoothList': { params: OnBrick & PersonConfirmed; result: { readonly removed: readonly string[]; readonly kept: readonly string[] } };
	/** Look for Bluetooth bricks now. */
	'bricks/inquiry': { params: Record<string, never>; result: null };

	// --- files ------------------------------------------------------------
	'files/list': { params: OnBrick & { readonly path: string }; result: readonly FsEntry[] };
	'files/exists': { params: OnBrick & { readonly path: string }; result: boolean };
	'files/size': { params: OnBrick & { readonly path: string }; result: FileSize };
	/**
	 * Read a file: to a local path the daemon writes, or into a transfer handle the client then
	 * drains with `transfer/read`.
	 */
	'files/read': { params: OnBrick & { readonly path: string; readonly toLocalPath?: string }; result: { readonly bytes: number; readonly handle?: string } };
	/** Write a file: from a local path, from a filled transfer handle, or from inline base64 content of at most 4 KiB. */
	'files/write': { params: OnBrick & { readonly path: string; readonly fromLocalPath?: string; readonly handle?: string; readonly content?: string }; result: { readonly bytes: number } };
	'files/makeDirectory': { params: OnBrick & { readonly path: string }; result: null };
	'files/remove': { params: OnBrick & { readonly path: string; readonly recursive?: boolean }; result: RemoveReport };
	/** Several paths, removed under one lease. */
	'files/removePaths': { params: OnBrick & { readonly paths: readonly string[]; readonly recursive?: boolean }; result: RemoveReport };
	'files/move': { params: OnBrick & { readonly from: string; readonly to: string }; result: null };

	// --- transfer handles (file content in chunks) -------------------------
	/** Open an upload buffer of `size` bytes. */
	'transfer/begin': { params: { readonly size: number }; result: { readonly handle: string; readonly chunkBytes: number } };
	/** Append base64 data to an upload buffer. */
	'transfer/write': { params: { readonly handle: string; readonly data: string }; result: null };
	/** Take the next chunk of a download; `done` with the last one. */
	'transfer/read': { params: { readonly handle: string }; result: { readonly data: string; readonly done: boolean } };
	'transfer/close': { params: { readonly handle: string }; result: null };

	// --- programs ---------------------------------------------------------
	/** Check nothing runs, upload the files, start the program: one lease, released at the verified start. */
	'programs/deployAndRun': { params: OnBrick & { readonly files: readonly DeployFile[]; readonly runPath: string }; result: DeployResult };
	'programs/run': { params: OnBrick & { readonly path: string; readonly replace?: boolean }; result: DeployResult };
	'programs/stop': { params: OnBrick; result: ProgramState };
	'programs/emergencyStop': { params: OnBrick; result: ProgramState };
	/** The program state now, or once it changes within `waitMs`. */
	'programs/status': { params: OnBrick & { readonly waitMs?: number }; result: ProgramState };
	/** Hear `programs/stateChanged` for a brick, across reconnects. */
	'programs/subscribe': { params: OnBrick; result: { readonly subscriptionId: string; readonly state: ProgramState } };

	// --- shell ------------------------------------------------------------
	'shell/run': { params: OnBrick & { readonly command: string }; result: ShellResult };

	// --- settings ---------------------------------------------------------
	'settings/list': { params: Record<string, never>; result: readonly SettingValue[] };
	'settings/set': { params: PersonConfirmed & { readonly key: string; readonly value: boolean | number | string }; result: SettingValue };
	'settings/accessMode': { params: Record<string, never>; result: AccessMode };

	// --- telemetry and the daisy chain -------------------------------------
	'telemetry/rows': { params: Record<string, never>; result: readonly TelemetryRowInfo[] };
	'telemetry/subscribe': { params: OnBrick & { readonly request: TelemetryRequest }; result: { readonly subscriptionId: string; readonly brickId: string; readonly grant: Readonly<Record<string, number | 'once'>>; readonly snapshot: readonly TelemetryValue[] } };
	/** The brick whose telemetry this client shows in the foreground. */
	'telemetry/foreground': { params: { readonly brick?: BrickRef | null }; result: null };
	'chain/get': { params: OnBrick; result: ContractChain };
	'chain/follow': { params: OnBrick; result: { readonly subscriptionId: string; readonly chain: ContractChain } };

	/** End any subscription by its id. */
	'subscriptions/cancel': { params: { readonly subscriptionId: string }; result: null };

	// --- brick loans between daemons --------------------------------------
	/** A development daemon borrows one brick; its holders are asked first. */
	'peer/borrowBrick': { params: { readonly brickId: string }; result: { readonly lent: boolean; readonly refusedBy?: string; readonly reason?: string } };
	/** A development daemon borrows the whole hardware. */
	'peer/borrowAll': { params: Record<string, never>; result: { readonly lent: boolean; readonly refusedBy?: string; readonly reason?: string } };
	/** The bricks this daemon holds, for a development daemon to show as blocked. */
	'peer/heldBricks': { params: Record<string, never>; result: readonly BrickStatus[] };
}

export type MethodName = keyof Methods;
export type ParamsOf<M extends MethodName> = Methods[M]['params'];
export type ResultOf<M extends MethodName> = Methods[M]['result'];

/** Requests that change a brick and therefore take its write lease. */
export const LEASED_METHODS: readonly MethodName[] = [
	'bricks/forget', 'bricks/clearBluetoothList',
	'files/write', 'files/makeDirectory', 'files/remove', 'files/removePaths', 'files/move',
	'programs/deployAndRun', 'programs/run', 'shell/run',
];

/** Requests no MCP server may send: they need a person at the CLI or in VS Code. */
export const PERSON_ONLY_METHODS: readonly MethodName[] = ['daemon/restart'];
