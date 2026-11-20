/**
 * What this process may open: which bricks it may connect, which USB devices it may open even to
 * read a name, and whether it may page the Bluetooth radio (inquiry, presence checks, pairing).
 *
 * One process owns the hardware and lends single bricks, or all of it, to a development daemon;
 * the development daemon opens only what it borrowed (KTD17). Every place that opens a device asks
 * the gate first, before anything is opened.
 */

import { BrickKey, brickIdOf } from '../contracts';

export interface UsbLocation {
	readonly busNumber: number;
	readonly deviceAddress: number;
}

export interface DeviceGate {
	/** May this process open this channel of a brick? */
	mayOpen(brickKey: BrickKey): boolean;
	/** May it open the USB device at this bus address, even only to read its name? */
	mayOpenUsb(location: UsbLocation): boolean;
	/** May it page the Bluetooth radio: inquiry, presence checks, pairing? */
	mayUseRadio(): boolean;
}

/** Everything is this process's to open. */
export const OPEN_GATE: DeviceGate = {
	mayOpen: () => true,
	mayOpenUsb: () => true,
	mayUseRadio: () => true,
};

const usbKey = (location: UsbLocation): string => `${location.busNumber}:${location.deviceAddress}`;

/**
 * The gate a daemon keeps for its loans.
 *
 * - `owner`: it owns the hardware and must leave alone what it lent; with everything lent, it opens
 *   nothing and leaves the radio alone.
 * - `borrower`: it opens only what it borrowed, and the radio only once it borrowed everything.
 */
export class LoanGate implements DeviceGate {
	private readonly brickIds = new Set<string>();
	private readonly usb = new Set<string>();
	private all = false;

	constructor(private side: 'owner' | 'borrower') {}

	get role(): 'owner' | 'borrower' { return this.side; }

	/** Becomes the owner of the hardware, with nothing lent. */
	own(): void {
		this.side = 'owner';
		this.clear();
	}

	/** One brick lent (owner) or borrowed (borrower), with the USB devices it sits on. */
	add(brickId: string, usb: readonly UsbLocation[] = []): void {
		this.brickIds.add(brickId);
		for (const location of usb) { this.usb.add(usbKey(location)); }
	}

	remove(brickId: string, usb: readonly UsbLocation[] = []): void {
		this.brickIds.delete(brickId);
		for (const location of usb) { this.usb.delete(usbKey(location)); }
	}

	/** Everything lent (owner) or borrowed (borrower), or not any more. */
	setAll(all: boolean): void {
		this.all = all;
	}

	get everything(): boolean { return this.all; }

	clear(): void {
		this.brickIds.clear();
		this.usb.clear();
		this.all = false;
	}

	/** Becomes a borrower that has borrowed nothing yet. */
	borrow(): void {
		this.side = 'borrower';
		this.clear();
	}

	mayOpen(brickKey: BrickKey): boolean {
		return this.allowsBrick(brickIdOf(brickKey));
	}

	/** Whether this process may open any channel of the brick. */
	allowsBrick(brickId: string): boolean {
		const listed = this.brickIds.has(brickId);
		return this.side === 'owner' ? !this.all && !listed : this.all || listed;
	}

	mayOpenUsb(location: UsbLocation): boolean {
		const listed = this.usb.has(usbKey(location));
		return this.side === 'owner' ? !this.all && !listed : this.all || listed;
	}

	mayUseRadio(): boolean {
		return this.side === 'owner' ? !this.all : this.all;
	}
}
