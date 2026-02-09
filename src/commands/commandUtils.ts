/**
 * Extracts a human-readable message from an unknown error value.
 */
export function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
