/**
 * Per-brick FIFO command queue.
 *
 * Serializes commands to a single brick to ensure firmware safety.
 * Tracks queue depth for telemetry throttling in Phase 3.
 */

import { BrickCommand, BrickResponse, SendCommandOptions } from '../contracts/transport';
import { QueueUnavailableError } from '../errors/CockpitError';

/** A queued command with its resolve/reject callbacks. */
interface QueuedCommand {
	command: BrickCommand;
	options?: SendCommandOptions;
	resolve: (response: BrickResponse) => void;
	reject: (error: unknown) => void;
}

/** Function that executes a command against a connected brick. */
export type CommandExecutor = (
	command: BrickCommand,
	options?: SendCommandOptions,
) => Promise<BrickResponse>;

/**
 * FIFO command queue for a single brick.
 */
export class CommandQueue {
	private readonly queue: QueuedCommand[] = [];
	private processing = false;
	private executor?: CommandExecutor;
	private _disposed = false;

	/** Current number of pending commands. */
	get depth(): number {
		return this.queue.length;
	}

	/** Whether the queue is currently processing a command. */
	get busy(): boolean {
		return this.processing;
	}

	/** Set the executor that sends commands to the brick. */
	setExecutor(executor: CommandExecutor): void {
		this.executor = executor;
	}

	/** Enqueue a command. Returns a promise that resolves with the response. */
	send(command: BrickCommand, options?: SendCommandOptions): Promise<BrickResponse> {
		if (this._disposed) {
			return Promise.reject(new QueueUnavailableError('Command queue has been disposed.'));
		}
		if (!this.executor) {
			return Promise.reject(new QueueUnavailableError('Command queue has no executor.'));
		}

		return new Promise<BrickResponse>((resolve, reject) => {
			this.queue.push({ command, options, resolve, reject });
			void this.drain();
		});
	}

	/** Drain all pending commands, rejecting them with the given error. */
	drainWith(error: Error): void {
		const entries = this.queue.splice(0);
		for (const entry of entries) {
			entry.reject(error);
		}
	}

	/** Dispose the queue, rejecting all pending commands. */
	dispose(): void {
		this._disposed = true;
		this.drainWith(new QueueUnavailableError('Command queue disposed.'));
		this.executor = undefined;
	}

	// ── Internal ────────────────────────────────────────────────────

	private async drain(): Promise<void> {
		if (this.processing) {
			return;
		}
		this.processing = true;

		try {
			while (this.queue.length > 0 && !this._disposed) {
				const entry = this.queue.shift()!;
				try {
					const response = await this.executor!(entry.command, entry.options);
					entry.resolve(response);
				} catch (error) {
					entry.reject(error);
				}
			}
		} finally {
			this.processing = false;
		}
	}
}
