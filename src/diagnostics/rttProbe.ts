import { performance } from 'node:perf_hooks';
import type { Logger } from './logger';
import type { Ev3CommandSendLike } from '../protocol/commandSendLike';
import { EV3_COMMAND, EV3_REPLY } from '../protocol/ev3Packet';

/**
 * Result of a single RTT (round-trip time) probe to an EV3 brick.
 */
export interface RttProbeResult {
	/** Measured round-trip time in milliseconds. */
	rttMs: number;
	/** Whether the probe received a valid reply. */
	success: boolean;
	/** Error message if the probe failed. */
	error?: string;
}

/**
 * Measures transport round-trip time by sending a lightweight GET_BRICKNAME
 * system command (opcode 0x9D) to the brick and timing the reply.
 *
 * @param commandClient - Command send interface for the target brick
 * @param options - Optional timeout configuration
 * @returns Probe result with timing and success/failure status
 */
export async function measureRtt(
	commandClient: Ev3CommandSendLike,
	options?: { timeoutMs?: number }
): Promise<RttProbeResult> {
	const timeoutMs = options?.timeoutMs ?? 3000;
	const startedAt = performance.now();

	try {
		// 0x9d = GET_BRICKNAME — a lightweight read-only system command
		const result = await commandClient.send({
			id: `rtt-probe-${Date.now().toString(36)}`,
			lane: 'normal',
			idempotent: true,
			timeoutMs,
			type: EV3_COMMAND.SYSTEM_COMMAND_REPLY,
			payload: new Uint8Array([0x9d])
		});

		const rttMs = Number((performance.now() - startedAt).toFixed(2));
		const isValidReply =
			result.reply.type === EV3_REPLY.SYSTEM_REPLY ||
			result.reply.type === EV3_REPLY.SYSTEM_REPLY_ERROR;

		return { rttMs, success: isValidReply };
	} catch (error) {
		const rttMs = Number((performance.now() - startedAt).toFixed(2));
		return {
			rttMs,
			success: false,
			error: error instanceof Error ? error.message : String(error)
		};
	}
}

/**
 * Runs multiple RTT probes and returns aggregated statistics.
 *
 * @param commandClient - Command send interface for the target brick
 * @param logger - Logger for emitting aggregated stats
 * @param options - Probe count and timeout configuration
 * @returns Aggregated statistics including min, max, avg, median, and success count
 */
export async function measureRttStats(
	commandClient: Ev3CommandSendLike,
	logger: Logger,
	options?: { probeCount?: number; timeoutMs?: number }
): Promise<{
	samples: RttProbeResult[];
	minMs: number;
	maxMs: number;
	avgMs: number;
	medianMs: number;
	successCount: number;
}> {
	const probeCount = Math.max(1, Math.min(options?.probeCount ?? 3, 10));
	const timeoutMs = options?.timeoutMs ?? 3000;
	const samples: RttProbeResult[] = [];

	for (let i = 0; i < probeCount; i += 1) {
		const result = await measureRtt(commandClient, { timeoutMs });
		samples.push(result);
	}

	const successfulRtts = samples.filter((s) => s.success).map((s) => s.rttMs).sort((a, b) => a - b);
	const successCount = successfulRtts.length;

	const minMs = successCount > 0 ? successfulRtts[0] : 0;
	const maxMs = successCount > 0 ? successfulRtts[successCount - 1] : 0;
	const avgMs = successCount > 0 ? Number((successfulRtts.reduce((a, b) => a + b, 0) / successCount).toFixed(2)) : 0;
	const medianMs =
		successCount > 0
			? successCount % 2 === 1
				? successfulRtts[Math.floor(successCount / 2)]
				: Number(((successfulRtts[successCount / 2 - 1] + successfulRtts[successCount / 2]) / 2).toFixed(2))
			: 0;

	logger.info('[perf] rtt-probe-stats', {
		probeCount,
		successCount,
		minMs,
		maxMs,
		avgMs,
		medianMs
	});

	return { samples, minMs, maxMs, avgMs, medianMs, successCount };
}
