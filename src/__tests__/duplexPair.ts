/** Two connected in-memory streams: what one side writes, the other reads. */

import { Duplex, PassThrough } from 'node:stream';

export function duplexPair(): [Duplex, Duplex] {
	const aToB = new PassThrough();
	const bToA = new PassThrough();
	const end = (write: PassThrough): Duplex => new Duplex({
		read() { /* pushed below */ },
		write(chunk, _enc, done) { write.write(chunk); done(); },
		final(done) { write.end(); done(); },
		destroy(_err, done) { write.end(); done(null); },
	});
	const a = end(aToB);
	const b = end(bToA);
	bToA.on('data', (chunk) => a.push(chunk));
	aToB.on('data', (chunk) => b.push(chunk));
	bToA.on('end', () => a.push(null));
	aToB.on('end', () => b.push(null));
	return [a, b];
}
