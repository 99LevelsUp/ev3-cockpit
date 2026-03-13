/**
 * Options controlling a single transport send operation.
 *
 * @remarks
 * Every command sent through a {@link TransportAdapter} must include timeout
 * and cancellation controls. The optional `expectedMessageCounter` enables
 * reply matching when multiple commands are in flight.
 */
export interface TransportRequestOptions {
	/** Maximum time in milliseconds to wait for a reply before timing out. */
	timeoutMs: number;
	/** Abort signal for cooperative cancellation of the send operation. */
	signal: AbortSignal;
	/**
	 * Expected EV3 message counter in the reply packet.
	 *
	 * @remarks
	 * When set, the transport layer can verify that the reply matches
	 * the request by comparing message counter values.
	 */
	expectedMessageCounter?: number;
}

/**
 * Minimal async interface for communicating with an EV3 brick.
 *
 * @remarks
 * Implementations exist for USB HID, TCP, Bluetooth SPP, and mock transports.
 * Each adapter is single-use: after {@link close} is called, the instance
 * cannot be reopened. A new adapter must be created via the transport factory.
 *
 * @see {@link ../transport/usbHidAdapter | UsbHidAdapter}
 * @see {@link ../transport/tcpAdapter | TcpAdapter}
 * @see {@link ../transport/bluetoothSppAdapter | BluetoothSppAdapter}
 * @see {@link ../transport/mockTransportAdapter | MockTransportAdapter}
 */
export interface TransportAdapter {
	/** Opens the transport connection to the brick. */
	open(): Promise<void>;
	/** Closes the transport connection and releases resources. */
	close(): Promise<void>;
	/**
	 * Sends a command packet and waits for the reply.
	 *
	 * @param packet - Raw EV3 protocol packet bytes to send
	 * @param options - Timeout, cancellation, and reply matching options
	 * @returns The raw reply packet bytes from the brick
	 * @throws {@link TransportError} on communication failures
	 */
	send(packet: Uint8Array, options: TransportRequestOptions): Promise<Uint8Array>;
}
