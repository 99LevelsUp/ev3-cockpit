import { ExtensionError } from '../errors/ExtensionError';

/**
 * Extracts a human-readable message from an unknown error value.
 */
export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Formátuje chybu pro zobrazení uživateli — bez stack trace a interních detailů.
 */
export function toUserFacingErrorMessage(error: unknown): string {
	if (error instanceof ExtensionError) {
		return `[${error.code}] ${error.message}`;
	}
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'string') {
		return error;
	}
	return 'An unexpected error occurred';
}

/**
 * Wraps an async brick operation with onBrickOperation lifecycle calls.
 *
 * Reports "{label} started" before the operation, "{label} completed" on success,
 * and "{label} failed" on failure. Returns the result or rethrows the error.
 */
export async function withBrickOperation<T>(
	brickId: string,
	label: string,
	onBrickOperation: (brickId: string, operation: string) => void,
	fn: () => Promise<T>
): Promise<T> {
	onBrickOperation(brickId, `${label} started`);
	try {
		const result = await fn();
		onBrickOperation(brickId, `${label} completed`);
		return result;
	} catch (error) {
		onBrickOperation(brickId, `${label} failed`);
		throw error;
	}
}
