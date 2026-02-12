import type { MockFaultConfig } from './mockTypes';
import type { MockTransportResponder } from '../transport/mockTransportAdapter';
import type { TransportRequestOptions } from '../transport/transportAdapter';

/**
 * Wraps a `MockTransportResponder` with fault injection capabilities.
 *
 * - `errorRate` → returns DIRECT_REPLY_ERROR / SYSTEM_REPLY_ERROR instead of success
 * - `latencyMs` + `jitterMs` → adds artificial delay
 * - `timeoutRate` → never responds (causes upstream timeout)
 */
export function wrapWithFaultInjector(
	inner: MockTransportResponder,
	config: MockFaultConfig
): MockTransportResponder {
	return async (packet: Uint8Array, options: TransportRequestOptions) => {
		// 1) Timeout fault — never respond
		if (config.timeoutRate > 0 && Math.random() < config.timeoutRate) {
			return new Promise<Uint8Array>((_resolve, reject) => {
				const onAbort = () => reject(new Error('Mock transport send aborted.'));
				if (options.signal.aborted) {
					reject(new Error('Mock transport send aborted before dispatch.'));
					return;
				}
				options.signal.addEventListener('abort', onAbort, { once: true });
			});
		}

		// 2) Latency fault
		if (config.latencyMs > 0 || config.jitterMs > 0) {
			const jitter = config.jitterMs > 0 ? (Math.random() * 2 - 1) * config.jitterMs : 0;
			const delay = Math.max(0, config.latencyMs + jitter);
			if (delay > 0) {
				await new Promise<void>(resolve => setTimeout(resolve, delay));
			}
		}

		// 3) Error fault — flip reply type to error variant
		if (config.errorRate > 0 && Math.random() < config.errorRate) {
			const result = inner(packet, options);
			const reply = result instanceof Promise ? await result : result;
			// Flip byte at position 4 (type byte) to error variant
			// DIRECT_REPLY (0x02) → DIRECT_REPLY_ERROR (0x04)
			// SYSTEM_REPLY (0x03) → SYSTEM_REPLY_ERROR (0x05)
			const errReply = reply.slice();
			if (errReply[4] === 0x02) { errReply[4] = 0x04; }
			else if (errReply[4] === 0x03) { errReply[4] = 0x05; }
			return errReply;
		}

		// 4) Normal — pass through
		return inner(packet, options);
	};
}
