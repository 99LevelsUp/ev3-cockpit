import * as dgram from 'node:dgram';
import { TransportMode } from '../types/enums';
import type { Logger } from '../diagnostics/logger';
import type { PresenceChangeCallback, PresenceRecord, PresenceSource } from './presenceSource';

export interface TcpPresenceSourceOptions {
	discoveryPort: number;
	toSafeIdentifier: (value: string) => string;
}

interface ParsedTcpBeacon {
	port: number;
	serialNumber: string;
	protocol: string;
	name: string;
}

function parseTcpBeacon(message: string): ParsedTcpBeacon | undefined {
	const lines = message
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const map = new Map<string, string>();
	for (const line of lines) {
		const index = line.indexOf(':');
		if (index < 0) {
			continue;
		}
		const key = line.slice(0, index).trim().toLowerCase();
		const value = line.slice(index + 1).trim();
		map.set(key, value);
	}

	const portRaw = map.get('port') ?? '';
	const port = Number.parseInt(portRaw, 10);
	if (!Number.isFinite(port) || port <= 0 || port > 65535) {
		return undefined;
	}

	return {
		port,
		serialNumber: map.get('serial-number') ?? '',
		protocol: map.get('protocol') ?? 'WiFi',
		name: map.get('name') ?? ''
	};
}

export class TcpPresenceSource implements PresenceSource {
	public readonly transport = TransportMode.TCP;

	private readonly options: TcpPresenceSourceOptions;
	private readonly logger: Logger;
	private readonly present = new Map<string, PresenceRecord>();
	private readonly listeners: PresenceChangeCallback[] = [];
	private socket: dgram.Socket | undefined;
	private rebindTimer: ReturnType<typeof setTimeout> | undefined;
	private started = false;

	constructor(options: TcpPresenceSourceOptions, logger: Logger) {
		this.options = options;
		this.logger = logger;
	}

	public start(): void {
		if (this.started) {
			return;
		}
		this.started = true;
		this.bind();
	}

	public stop(): void {
		this.started = false;
		if (this.rebindTimer) {
			clearTimeout(this.rebindTimer);
			this.rebindTimer = undefined;
		}
		if (this.socket) {
			try {
				this.socket.removeAllListeners();
				this.socket.close();
			} catch {
				// ignore
			}
			this.socket = undefined;
		}
	}

	public getPresent(): ReadonlyMap<string, PresenceRecord> {
		return this.present;
	}

	public onChange(callback: PresenceChangeCallback): void {
		this.listeners.push(callback);
	}

	private bind(): void {
		if (!this.started) {
			return;
		}
		try {
			const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			this.socket = socket;

			socket.on('error', (err) => {
				this.logger.warn('TCP presence UDP socket error, rebinding in 5s', { error: String(err) });
				this.closeSocket();
				this.scheduleRebind();
			});

			socket.on('message', (msg, rinfo) => {
				this.handleBeacon(msg, rinfo);
			});

			socket.bind(this.options.discoveryPort, () => {
				this.logger.debug('TCP presence UDP socket bound', { port: this.options.discoveryPort });
			});
		} catch (err) {
			this.logger.warn('TCP presence bind failed, rebinding in 5s', { error: String(err) });
			this.scheduleRebind();
		}
	}

	private closeSocket(): void {
		if (this.socket) {
			try {
				this.socket.removeAllListeners();
				this.socket.close();
			} catch {
				// ignore
			}
			this.socket = undefined;
		}
	}

	private scheduleRebind(): void {
		if (!this.started || this.rebindTimer) {
			return;
		}
		this.rebindTimer = setTimeout(() => {
			this.rebindTimer = undefined;
			this.bind();
		}, 5000);
		this.rebindTimer.unref?.();
	}

	private handleBeacon(msg: Buffer, rinfo: dgram.RemoteInfo): void {
		const parsed = parseTcpBeacon(msg.toString('utf8'));
		if (!parsed) {
			return;
		}
		const endpoint = `${rinfo.address}:${parsed.port}`;
		const candidateId = `tcp-${this.options.toSafeIdentifier(endpoint)}`;
		const now = Date.now();

		const existing = this.present.get(candidateId);
		const namePart = parsed.name || '';
		const serialPart = parsed.serialNumber ? `SN ${parsed.serialNumber}` : '';
		const detail = [namePart, serialPart].filter((p) => p.length > 0).join(' | ') || endpoint;

		const record: PresenceRecord = {
			candidateId,
			transport: TransportMode.TCP,
			displayName: parsed.name || `EV3 TCP (${endpoint})`,
			detail,
			connectable: true,
			lastSeenMs: now,
			connectionParams: {
				mode: 'tcp',
				tcpHost: rinfo.address,
				tcpPort: parsed.port,
				tcpSerialNumber: parsed.serialNumber || undefined
			}
		};

		this.present.set(candidateId, record);

		if (!existing) {
			this.fireChange();
		}
	}

	private fireChange(): void {
		for (const listener of this.listeners) {
			try {
				listener(this.present);
			} catch {
				// swallow
			}
		}
	}
}
