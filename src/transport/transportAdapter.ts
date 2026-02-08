export interface TransportRequestOptions {
	timeoutMs: number;
	signal: AbortSignal;
	expectedMessageCounter?: number;
}

export interface TransportAdapter {
	open(): Promise<void>;
	close(): Promise<void>;
	send(packet: Uint8Array, options: TransportRequestOptions): Promise<Uint8Array>;
}
