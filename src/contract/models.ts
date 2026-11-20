/**
 * The plain data that crosses between the daemon and its clients. Everything here is JSON: no
 * class instances, promises or functions.
 */

/**
 * Who a connection is. The daemon trusts a person's confirmation only from `vscode` and `cli`, the
 * cockpit's own. An add-on is `addon` in every environment (its VS Code extension and its `ev3 <name>`
 * command alike), its MCP server `mcp`. The name a client gives is what other clients read in
 * `brick_busy`, so it says where the client runs: "EVƎ C (VS Code)", "ev3 c run (terminal)".
 */
export const CLIENT_KINDS = ['vscode', 'cli', 'mcp', 'addon', 'peer'] as const;
export type ClientKind = (typeof CLIENT_KINDS)[number];

/** VS Code and the `ev3` command have a person at them; the daemon honours their confirmations. */
export function isPersonClient(kind: ClientKind): boolean {
	return kind === 'vscode' || kind === 'cli';
}

/** A brick by its id or by its name. Names need not be unique; an ambiguous one is refused. */
export type BrickRef = string;

/** One way a brick is reachable, and how it is doing. */
export interface ContractChannel {
	readonly transport: 'usb' | 'bt' | 'tcp' | 'mock';
	readonly state: 'available' | 'connected' | 'lost';
}

/** Why a brick stays connected: who holds it. */
export interface BrickHolder {
	/** A connected client, the hold `ev3 connect` leaves, or the long-lived clients together for remembered bricks. */
	readonly kind: 'client' | 'hold' | 'remembered';
	/** The client's name for `client`; absent otherwise. */
	readonly client?: string;
}

/** One brick as every client sees it. */
export interface ContractBrick {
	readonly brickId: string;
	readonly name: string;
	/** The brick itself reported the name, rather than a cache or a fallback. */
	readonly nameConfirmed: boolean;
	readonly connected: boolean;
	/** Paired with this computer over Bluetooth. */
	readonly paired: boolean;
	readonly channels: readonly ContractChannel[];
	readonly holders: readonly BrickHolder[];
	/** Reconnecting after a daemon restart; operations wait for it. */
	readonly reconnecting?: boolean;
	/** Lent to a development daemon, or held by another daemon: this daemon does not touch it. */
	readonly blocked?: { readonly by: string; readonly holder?: string };
}

export interface BrickInfo {
	readonly brickId: string;
	readonly name: string;
	readonly firmwareVersion?: string;
	readonly osVersion?: string;
}

export interface FsEntry {
	readonly name: string;
	readonly kind: 'file' | 'directory' | 'unknown';
	readonly bytes?: number;
	/** Lowercase hex, files only. */
	readonly md5?: string;
}

export interface FileSize {
	/** Kilobytes, rounded up, as the firmware reports them. */
	readonly kilobytes: number;
	/** Files the total covers; zero for a plain file. */
	readonly files: number;
}

export interface StorageUsage {
	readonly totalKb: number;
	readonly freeKb: number;
}

/** What a recursive removal could not delete. */
export interface RemoveReport {
	readonly leftBehind: readonly string[];
}

/** One file of a deployment: from a local path the daemon reads, or small inline content. */
export interface DeployFile {
	/** Absolute path on the brick. */
	readonly remotePath: string;
	readonly localPath?: string;
	/** Base64, at most 4 KiB once decoded. */
	readonly content?: string;
	/** Skip the upload when the brick already holds a file with the same MD5. */
	readonly skipIfSameMd5?: boolean;
}

/**
 * How a start ended.
 *
 * - `started`: the brick reported the program running.
 * - `not_seen_running`: the start was confirmed but the program was not seen running; it may have
 *   ended at once.
 * - `uncertain`: the reply to the start was lost. Do not start again; read the program's state first.
 */
export type StartOutcome = 'started' | 'not_seen_running' | 'uncertain';

export interface DeployResult {
	readonly brickId: string;
	readonly outcome: StartOutcome;
	/**
	 * This start's number on the brick: the daemon counts every start it is asked for per brick, a
	 * refused one included, so numbers may skip. A state with a lower `runSeq` is about an earlier run;
	 * with `replace`, the old program's end may still arrive under the new number.
	 */
	readonly runSeq: number;
	/** Files that were uploaded, and those skipped because the brick held the same content. */
	readonly uploaded: readonly string[];
	readonly skipped: readonly string[];
}

export interface ProgramState {
	readonly brickId: string;
	readonly running: boolean;
	/** The number of the last start the daemon sent to this brick (0 before any); see `DeployResult.runSeq`. */
	readonly runSeq: number;
	/** The client that stopped it, when a stop ended it. */
	readonly stoppedBy?: string;
}

export interface ShellResult {
	readonly brickId: string;
	readonly status: number;
}

/** A telemetry row a client can subscribe to. */
export interface TelemetryRowInfo {
	readonly id: string;
	readonly tier: string;
	readonly unit?: string;
	readonly port?: string;
	readonly layer?: number;
}

export interface TelemetryRequest {
	readonly rows: readonly string[];
	readonly intervalMs: number;
	/** Sensor port modes, by port: `{ '1': 2 }`. */
	readonly modes?: Readonly<Record<string, number>>;
}

export interface TelemetryValue {
	readonly rowId: string;
	readonly value: number | string | boolean | null;
	readonly unit?: string;
	readonly mode?: number;
	readonly sampledAt: number;
	readonly effectiveIntervalMs?: number | 'once';
	readonly stale: boolean;
}

export interface TelemetryUpdate {
	readonly subscriptionId: string;
	readonly brickId: string;
	/** A fresh snapshot follows every subscribe and every reconnect to a new daemon. */
	readonly kind: 'snapshot' | 'change' | 'ended';
	readonly values: readonly TelemetryValue[];
	readonly removed: readonly string[];
}

export interface ChainMember {
	readonly layer: number;
	readonly capabilities: {
		readonly sensors: boolean;
		readonly motorTypes: boolean;
		readonly motorReadout: boolean;
		readonly files: boolean;
		readonly programs: boolean;
		readonly name: boolean;
	};
}

export interface ContractChain {
	readonly brickId: string;
	readonly read: boolean;
	readonly stale: boolean;
	readonly members: readonly ChainMember[];
}

export type AccessMode = 'safe' | 'full';

/** One setting the daemon holds, with its rules. */
export interface SettingSpec {
	readonly key: string;
	readonly type: 'boolean' | 'number' | 'string';
	readonly default: boolean | number | string;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly enum?: readonly string[];
	readonly description: string;
	/** Changing it needs a person's confirmation; MCP and add-ons cannot change it. */
	readonly dangerous: boolean;
}

export interface SettingValue {
	readonly spec: SettingSpec;
	readonly value: boolean | number | string;
}

/** Holders and leases of one brick, for `ev3 daemon status`. */
export interface BrickStatus {
	readonly brickId: string;
	readonly name: string;
	readonly holders: readonly BrickHolder[];
	/** The client holding the write lease, if any. */
	readonly leaseHolder?: string;
	/** Held across a daemon restart and not connected again yet. */
	readonly reconnecting?: boolean;
}

export interface DaemonStatus {
	readonly version: string;
	readonly contractVersion: number;
	readonly pid: number;
	readonly channel: string;
	readonly startedAt: number;
	readonly runtime: { readonly node: string; readonly electron?: string };
	readonly clients: readonly { readonly name: string; readonly kind: ClientKind }[];
	readonly bricks: readonly BrickStatus[];
	readonly logPath: string;
	/** All hardware is lent to a development daemon. */
	readonly lent?: boolean;
}

/** How to start a daemon: what a newer client hands over for a replacement. */
export interface LaunchSpec {
	/** The executable that runs the daemon: VS Code's or the system Node. */
	readonly runtime: string;
	/** The daemon's script. */
	readonly entry: string;
	/** Where its native helpers and modules live. */
	readonly installRoot: string;
	/** Set when `runtime` is VS Code's executable run as Node. */
	readonly electronRunAsNode?: boolean;
	readonly version: string;
}

/** What a question from the daemon is about. */
export type QuestionKind = 'sweep' | 'forget' | 'clearBluetoothList' | 'bluetoothAccess' | 'brickLoan';

/** A question the daemon puts to a client for a person to answer. */
export interface Question {
	readonly questionId: string;
	readonly kind: QuestionKind;
	readonly brickId?: string;
	/** What the person is asked, ready to show. */
	readonly text: string;
	/** Detail lines, for example the Bluetooth entries a clearing would remove. */
	readonly details?: readonly string[];
	/** For clearing a Bluetooth list: this computer's Bluetooth name, and whether it is among the entries. */
	readonly thisComputer?: string;
	readonly includesThisComputer?: boolean;
	/** After this many milliseconds the question counts as unanswered. */
	readonly timeoutMs: number;
}

/** `keep` leaves things as they are: what a client without a person always answers. */
export type QuestionAnswer = 'yes' | 'no' | 'keep';

export interface PairingEvent {
	readonly brickId: string;
	readonly phase: string;
	readonly message?: string;
}

export interface PairingDone {
	readonly brickId: string;
	readonly paired: boolean;
	readonly message?: string;
}
