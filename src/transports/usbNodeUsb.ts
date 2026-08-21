import type { Device } from 'usb';

const LEGO_VENDOR_ID = 0x0694;

export interface LegoUsbDeviceInfo {
	vendorId: number;
	productId: number;
	serialNumber: string | null;
	manufacturer: string | null;
	product: string | null;
}

/** Options for {@link listLegoUsbDevices}. */
export interface ListLegoUsbDevicesOptions {
	/**
	 * Devices to enumerate without opening.
	 *
	 * Reading a string descriptor means opening the device, and discovery runs on a timer
	 * while a session may hold the same brick's interface claimed. Skipping by bus address
	 * needs no handle, so an in-use brick is never reopened underneath its own session.
	 */
	skip?: (location: { busNumber: number; deviceAddress: number }) => boolean;
}

/**
 * Enumerates LEGO USB devices via libusb, reading string descriptors directly
 * from the USB hardware — bypasses Windows USB descriptor cache.
 *
 * Returns an empty array if the `usb` package is unavailable or inaccessible.
 */
export async function listLegoUsbDevices(
	options?: ListLegoUsbDevicesOptions,
): Promise<LegoUsbDeviceInfo[]> {
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
		if (options?.skip?.({ busNumber: device.busNumber, deviceAddress: device.deviceAddress })) {
			// In use by a session. Reported so it still appears in the scan, but without
			// reopening the device its own transport is holding.
			results.push({
				vendorId: device.deviceDescriptor.idVendor,
				productId: device.deviceDescriptor.idProduct,
				serialNumber: null,
				manufacturer: null,
				product: null,
			});
			continue;
		}
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
