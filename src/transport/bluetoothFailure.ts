import { BluetoothPortSelectionPlan } from './bluetoothPortSelection';

export function isLikelyTransientBluetoothFailure(
	message: string,
	strategy: BluetoothPortSelectionPlan['name']
): boolean {
	return (
		/unknown error code 121/i.test(message) ||
		/unknown error code 1256/i.test(message) ||
		/unknown error code 1167/i.test(message) ||
		/access is denied/i.test(message) ||
		/access denied/i.test(message) ||
		/the semaphore timeout period has expired/i.test(message) ||
		(strategy === 'ev3-priority' && /send aborted/i.test(message))
	);
}

export function isLikelyDynamicBluetoothAvailabilityFailure(message: string): boolean {
	return (
		/file not found/i.test(message) ||
		/could not resolve any serial com candidates/i.test(message) ||
		/unknown error code 121/i.test(message) ||
		/unknown error code 1256/i.test(message) ||
		/unknown error code 1167/i.test(message) ||
		/access denied/i.test(message) ||
		/the semaphore timeout period has expired/i.test(message) ||
		/send aborted/i.test(message) ||
		/transport is not open/i.test(message)
	);
}
