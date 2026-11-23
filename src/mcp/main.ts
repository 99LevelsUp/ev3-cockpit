/**
 * The cockpit's MCP server over stdio: `node out/mcp/main.js` from the compiled sources, or the
 * bundled `mcp.js` with the daemon binary and its manifest beside it.
 *
 * Standard output carries MCP messages only; anything else goes to standard error. The server
 * connects to the daemon on the first tool that needs a brick, starting this installation's daemon
 * when none runs, under the name its MCP client gave, and lets go of it when the MCP client closes
 * standard input. It never asks the daemon to exit.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { nativeStateRoot } from '../client/locate';
import { CockpitClient } from '../client/nativeClient';
import { installation } from '../cli/installation';
import { CockpitMcp } from './tools';

function main(): void {
	const install = installation(__dirname);
	const channel = install.channel(process.env);
	const cockpit = new CockpitMcp({
		version: install.version,
		connect: (clientName, onNotice) => CockpitClient.connect({
			name: clientName,
			kind: 'mcp',
			version: install.version,
			buildKind: install.buildKind,
			daemon: install.daemon(),
			...(channel ? { channel, stateRoot: nativeStateRoot({ env: process.env }) } : {}),
		}, onNotice),
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
