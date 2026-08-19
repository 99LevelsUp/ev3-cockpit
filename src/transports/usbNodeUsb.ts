import type { Device } from 'usb';

const LEGO_VENDOR_ID = 0x0694;

export interface LegoUsbDeviceInfo {
	vendorId: number;
	productId: number;
	serialNumber: string | null;
	manufacturer: string | null;
	product: string | null;
}

/**
 * Enumerates LEGO USB devices via libusb, reading string descriptors directly
 * from the USB hardware — bypasses Windows USB descriptor cache.
 *
 * Returns an empty array if the `usb` package is unavailable or inaccessible.
 */
export async function listLegoUsbDevices(): Promise<LegoUsbDeviceInfo[]> {
	let getDeviceList: () => Device[];
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const usbModule = require('usb') as { getDeviceList: () => Device[] };
		getDeviceList = usbModule.getDeviceList;
	} catch {
		return [];
	}

	const devices = getDeviceList().filter(
		d => d.deviceDescriptor.idVendor === LEGO_VENDOR_ID
	);

	const results: LegoUsbDeviceInfo[] = [];
	for (const device of devices) {
		let serialNumber: string | null = null;
		let manufacturer: string | null = null;
		let product: string | null = null;
		try {
			device.open();
			try {
				const desc = device.deviceDescriptor;
				serialNumber = await getStringDescriptor(device, desc.iSerialNumber);
				manufacturer = await getStringDescriptor(device, desc.iManufacturer);
				product      = await getStringDescriptor(device, desc.iProduct);
			} finally {
				try { device.close(); } catch { /* ignore close errors */ }
			}
		} catch { /* device inaccessible — report it without string descriptors */ }
		results.push({
			vendorId:  device.deviceDescriptor.idVendor,
			productId: device.deviceDescriptor.idProduct,
			serialNumber,
			manufacturer,
			product,
		});
	}
	return results;
}

function getStringDescriptor(device: Device, index: number): Promise<string | null> {
	if (!index) return Promise.resolve(null);
	return new Promise(resolve => {
		device.getStringDescriptor(index, (err, value) => resolve(err ? null : (value ?? null)));
	});
}
