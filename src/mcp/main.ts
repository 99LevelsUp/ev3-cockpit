/**
 * The cockpit's MCP server over stdio: `node out/mcp/main.js` from the compiled sources, or the
 * bundled `mcp.js` with `daemon.js` beside it.
 *
 * Standard output carries MCP messages only; anything else goes to standard error. The server
 * connects to the daemon on the first tool that needs a brick, starting this installation's daemon
 * when none runs, and lets go of it when the MCP client closes standard input.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { CockpitClient } from '../client';
import { thisInstallLaunch } from '../client/locate';
import type { LaunchSpec } from '../contract/models';
import { CockpitMcp, MCP_CLIENT_NAME } from './tools';

/** This installation's daemon, found from the folder this server runs from. */
export function installation(here: string): { readonly launch: LaunchSpec; readonly version: string } {
	const bundled = fs.existsSync(path.join(here, 'daemon.js'));
	const installRoot = bundled ? path.resolve(here, '..') : path.resolve(here, '..', '..');
	let version = '0.0.0';
	try {
		version = (JSON.parse(fs.readFileSync(path.join(installRoot, 'package.json'), 'utf8')) as { version?: string }).version ?? version;
	} catch { /* an installation without its package.json still runs; the version notice then says so */ }
	const launch = thisInstallLaunch(installRoot, version);
	return { version, launch: { ...launch, entry: bundled ? path.join(here, 'daemon.js') : path.resolve(here, '..', 'daemon', 'main.js') } };
}

function main(): void {
	const { launch, version } = installation(__dirname);
	const cockpit = new CockpitMcp({
		version,
		connect: () => CockpitClient.connect({ name: MCP_CLIENT_NAME, kind: 'mcp', version, launch }),
	});
	const served = serveStdio(() => cockpit.createServer(), {
		onerror: (error) => process.stderr.write(`ev3-cockpit MCP: ${error.message}\n`),
	});
	process.stdin.once('end', () => {
		cockpit.dispose();
		void served.close();
	});
}

if (require.main === module) {
	main();
}
