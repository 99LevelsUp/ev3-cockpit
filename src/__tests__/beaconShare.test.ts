/**
 * Two VS Code windows, two cockpits, one beacon port (found on HOSTC, 13.11.2026).
 *
 * Each window has its own extension host, so a second window runs a second cockpit. Its TCP beacon
 * listener could not bind UDP 3015 while the first held it, and logged "Discovery scan failed …
 * EADDRINUSE" every three seconds for as long as it stayed open. A brick's beacon is a broadcast,
 * which every socket bound to the port with SO_REUSEADDR receives, so the windows share the port
 * and both see TCP bricks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TcpTransportProvider } from '../transports/tcpTransportProvider';

/** A high port of its own, apart from beaconDiscovery.test.ts's. */
const PORT = 34115;
const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('TcpTransportProvider — a second window', () => {
	it('shares the beacon port with another cockpit instead of failing every scan', async () => {
		const first = new TcpTransportProvider({ discoveryPort: PORT });
		const second = new TcpTransportProvider({ discoveryPort: PORT });
		try {
			await first.discover();
			await second.discover();
			await settle(300);   // the binds have landed, or failed

			await second.discover();   // rejects with "beacon port … unavailable" when the bind failed
			await first.discover();
		} finally {
			first.dispose();
			second.dispose();
		}
	});
});
