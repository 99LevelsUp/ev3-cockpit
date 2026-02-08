import { TransportAdapter, TransportRequestOptions } from './transportAdapter';

export type MockTransportResponder = (
	packet: Uint8Array,
	options: TransportRequestOptions
) => Promise<Uint8Array> | Uint8Array;

export class MockTransportAdapter implements TransportAdapter {
	public readonly sentPackets: Uint8Array[] = [];

	private opened = false;
	private readonly responder: MockTransportResponder;

	public constructor(responder?: MockTransportResponder) {
		this.responder = responder ?? ((packet) => packet);
	}

	public async open(): Promise<void> {
		this.opened = true;
	}

	public async close(): Promise<void> {
		this.opened = false;
	}

	public async send(packet: Uint8Array, options: TransportRequestOptions): Promise<Uint8Array> {
		if (!this.opened) {
			throw new Error('Mock transport is not open.');
		}

		if (options.signal.aborted) {
			throw new Error('Mock transport send aborted before dispatch.');
		}

		const packetCopy = packet.slice();
		this.sentPackets.push(packetCopy);

		return new Promise<Uint8Array>((resolve, reject) => {
			const onAbort = () => {
				cleanup();
				reject(new Error('Mock transport send aborted.'));
			};

			const cleanup = () => options.signal.removeEventListener('abort', onAbort);
			options.signal.addEventListener('abort', onAbort, { once: true });

			Promise.resolve(this.responder(packetCopy, options))
				.then((reply) => {
					cleanup();
					resolve(reply);
				})
				.catch((error: unknown) => {
					cleanup();
					reject(error);
				});
		});
	}
}

