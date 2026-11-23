/**
 * Reconnect after a pulled USB cable, through the native daemon's surface, recorded. Needs a
 * person at the brick; every step is one instruction, announced with a beep.
 *
 *   node scripts/cable-pull-probe.mts --daemon <ev3-cockpitd> --brick <NAME> --out <dir>
 *        [--state-root <dir>]
 *
 * Starts the daemon on a private test channel in record mode over USB alone (`--mode record
 * --record-dir <out>/usb-cable-pull-<brick> --transports usb`; see scripts/hardware-scenario.mts,
 * whose client and daemon handling it uses, and which must lie beside it). Then:
 *
 *   1. the brick is found and connected, and its battery voltage subscribed every 500 ms, so
 *      there is traffic on the link when the cable goes;
 *   2. three beeps: PULL the USB cable out of the brick. The probe waits up to 60 s for the
 *      daemon to report the brick's USB channel gone;
 *   3. one long beep: PLUG the cable back in. The probe waits up to 60 s for `bricks/reconnected`:
 *      the client never let go of the brick, so the daemon connects it again by itself;
 *   4. `bricks/info` answers again and telemetry carries on; the subscription is cancelled, the
 *      brick disconnected and the daemon ended with `daemon/exit`.
 *
 * It prints how long the daemon took to notice the loss and to bring the brick back. The recording
 * is a fixture candidate only after the identifier search every recording goes through.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
	connectClient, startDaemon, endDaemon, findBrick, say, brief, wait, beep,
} from './hardware-scenario.mts';
import type { CallError, Exit, ScenarioContext } from './hardware-scenario.mts';
import type { Notifications } from '../src/contract/generated/index.ts';

/** How often the battery is read while the cable goes and comes back. */
const TRAFFIC_MS = 500;
/** How long each instruction waits for what it asks for. */
const STEP_MS = 60_000;

interface Args {
	daemon?: string;
	brick?: string;
	out?: string;
	'state-root'?: string;
}

function parse(argv: readonly string[]): Args {
	const args: Args = {};
	for (let i = 0; i < argv.length; i++) {
		if (['--daemon', '--brick', '--out', '--state-root'].includes(argv[i])) { args[argv[i].slice(2) as keyof Args] = argv[++i]; } else { throw new Error(`unexpected argument ${argv[i]}`); }
	}
	return args;
}

/** CCC's USB channel state in a brick list, or undefined when it is not listed on USB. */
function usbState(bricks: Notifications['bricks/changed']['bricks'] | undefined, name: string): string | undefined {
	const brick = (bricks ?? []).find((b) => b.name.toLowerCase() === name.toLowerCase());
	return brick?.channels?.find((ch) => ch.transport === 'usb')?.state;
}

async function main(): Promise<number> {
	const args = parse(process.argv.slice(2));
	if (!args.daemon || !args.brick || !args.out) {
		process.stderr.write('usage: node scripts/cable-pull-probe.mts --daemon <ev3-cockpitd> --brick <NAME> --out <dir> [--state-root <dir>]\n');
		return 64;
	}
	const name = `usb-cable-pull-${args.brick.toLowerCase()}`;
	const stateParent = args['state-root'] ?? path.join(os.homedir(), 'ev3rec', 'state');
	fs.mkdirSync(stateParent, { recursive: true, mode: 0o700 });
	const stateRoot = fs.mkdtempSync(path.join(stateParent, 'run-'));
	const daemon = await startDaemon(path.resolve(args.daemon), stateRoot,
		['--mode', 'record', '--record-dir', path.resolve(args.out, name), '--transports', 'usb']);
	const { client } = await connectClient(daemon);
	const c: ScenarioContext = {
		daemon, client, brick: args.brick, transport: 'usb', results: {},
		async call(method, params) {
			const result = await client.call(method, params);
			say(`${method} ${brief(params)} -> ${brief(result)}`);
			return result;
		},
	};
	let failure: Error | undefined;
	try {
		await findBrick(c);
		await c.call('bricks/connect', { brick: c.brick });
		const updates: number[] = [];
		client.on((m) => { if (m.method === 'telemetry/update') { updates.push(Date.now()); } });
		const subscription = await c.call('telemetry/subscribe', {
			brick: c.brick, request: { rows: ['system.battery.voltage'], intervalMs: TRAFFIC_MS },
		});
		await wait(5000);

		beep(); beep(); beep();
		say('>>> PULL the USB cable out of the brick now.');
		const pulledAt = Date.now();
		const gone = await client.until((m) => m.method === 'bricks/changed'
			&& usbState(m.params?.bricks, c.brick) !== 'connected', STEP_MS);
		if (!gone || gone.method !== 'bricks/changed') { throw new Error('the daemon did not report the USB channel gone within 60 s; was the cable pulled?'); }
		c.results.lossReportedMs = Date.now() - pulledAt;
		say(`USB channel ${usbState(gone.params.bricks, c.brick) ?? 'no longer listed'} after ${c.results.lossReportedMs as number} ms`);
		await wait(5000);

		beep();
		say('>>> PLUG the USB cable back into the brick now.');
		const pluggedAt = Date.now();
		const back = await client.until((m) => m.method === 'bricks/reconnected', STEP_MS);
		if (!back) { throw new Error('the brick was not connected again within 60 s of the instruction'); }
		c.results.backMs = Date.now() - pluggedAt;
		say(`connected again ${c.results.backMs} ms after the instruction`);

		const before = updates.length;
		await c.call('bricks/info', { brick: c.brick });
		await wait(3000);
		c.results.telemetryAfter = updates.length - before;
		say(`telemetry updates in the 3 s after the reconnect: ${c.results.telemetryAfter}`);
		await c.call('subscriptions/cancel', { subscriptionId: subscription.subscriptionId });
		await c.call('bricks/disconnect', { brick: c.brick });
	} catch (error) {
		failure = error as Error;
	}
	const outcome: Exit & { error?: undefined } | { error: Error } = await endDaemon(daemon, client).catch((error: unknown) => ({ error: error as CallError }));
	client.close();
	say(`results: ${brief(c.results)}`);
	if (failure) { say(`FAILED: ${failure.message}`); }
	if (outcome.error) { say(`FAILED to end the daemon: ${outcome.error.message}`); return 1; }
	say(`daemon exited with ${outcome.code ?? outcome.signal}${daemon.stderr().trim() ? `: ${daemon.stderr().trim()}` : ''}`);
	return failure || outcome.code !== 0 ? 1 : 0;
}

main().then((code) => process.exit(code), (error: unknown) => {
	process.stderr.write(`${(error as Error | undefined)?.stack ?? String(error)}\n`);
	process.exit(1);
});
