import { BluetoothPortSelectionPlan } from './bluetoothPortSelection';

export type BluetoothFailurePhase = 'discovery' | 'open' | 'probe' | 'send' | 'session' | 'unknown';

export interface BluetoothFailureClassification {
	phase: BluetoothFailurePhase;
	windowsCode?: number;
	likelyTransient: boolean;
	likelyDynamicAvailability: boolean;
}

export interface BluetoothFailureSummary {
	total: number;
	byPhase: Record<BluetoothFailurePhase, number>;
	likelyTransientCount: number;
	likelyDynamicAvailabilityCount: number;
	windowsCodes: number[];
	primaryPhase: BluetoothFailurePhase;
}

function extractWindowsErrorCode(message: string): number | undefined {
	const match = /unknown error code\s+(\d+)/i.exec(message);
	if (!match) {
		return undefined;
	}
	const parsed = Number.parseInt(match[1], 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function classifyBluetoothFailurePhase(message: string): BluetoothFailurePhase {
	if (/could not resolve any serial com candidates|no com candidates|discovery/i.test(message)) {
		return 'discovery';
	}
	if (/probe|unexpected reply type.*probe|reply returned status/i.test(message)) {
		return 'probe';
	}
	if (/send aborted|in-flight send request|message counter|waiting for reply/i.test(message)) {
		return 'send';
	}
	if (/transport is not open|serial port closed|adapter is not open/i.test(message)) {
		return 'session';
	}
	if (/opening|access is denied|access denied|file not found|unknown error code|semaphore timeout/i.test(message)) {
		return 'open';
	}
	return 'unknown';
}

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

export function classifyBluetoothFailure(
	message: string,
	strategy: BluetoothPortSelectionPlan['name'] = 'ev3-priority'
): BluetoothFailureClassification {
	return {
		phase: classifyBluetoothFailurePhase(message),
		windowsCode: extractWindowsErrorCode(message),
		likelyTransient: isLikelyTransientBluetoothFailure(message, strategy),
		likelyDynamicAvailability: isLikelyDynamicBluetoothAvailabilityFailure(message)
	};
}

export function summarizeBluetoothFailures(messages: string[]): BluetoothFailureSummary {
	const byPhase: Record<BluetoothFailurePhase, number> = {
		discovery: 0,
		open: 0,
		probe: 0,
		send: 0,
		session: 0,
		unknown: 0
	};
	let likelyTransientCount = 0;
	let likelyDynamicAvailabilityCount = 0;
	const windowsCodes = new Set<number>();

	for (const message of messages) {
		const classification = classifyBluetoothFailure(message);
		byPhase[classification.phase] += 1;
		if (classification.likelyTransient) {
			likelyTransientCount += 1;
		}
		if (classification.likelyDynamicAvailability) {
			likelyDynamicAvailabilityCount += 1;
		}
		if (classification.windowsCode !== undefined) {
			windowsCodes.add(classification.windowsCode);
		}
	}

	const orderedPhases: BluetoothFailurePhase[] = ['open', 'probe', 'discovery', 'send', 'session', 'unknown'];
	const primaryPhase = orderedPhases.reduce<BluetoothFailurePhase>((best, current) => {
		if (byPhase[current] > byPhase[best]) {
			return current;
		}
		return best;
	}, 'unknown');

	return {
		total: messages.length,
		byPhase,
		likelyTransientCount,
		likelyDynamicAvailabilityCount,
		windowsCodes: [...windowsCodes].sort((a, b) => a - b),
		primaryPhase
	};
}
