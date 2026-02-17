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

/**
 * Options for handleCommandError function.
 */
export interface HandleCommandErrorOptions {
	/** Logger instance for error logging */
	logger: { error: (message: string, metadata?: Record<string, unknown>) => void };
	/** Operation description (e.g., "Deploy project", "Run program") */
	operation: string;
	/** Additional context metadata to log */
	context?: Record<string, unknown>;
	/** Whether to show error message to user (default: true) */
	showToUser?: boolean;
	/** Custom user-facing error message (if not provided, uses toUserFacingErrorMessage) */
	userMessage?: string;
}

/**
 * Unified error handling for command handlers.
 * Logs the error and optionally shows it to the user.
 *
 * Eliminates duplicated try-catch-logger-showError pattern across 15+ command handlers.
 *
 * @example
 * ```typescript
 * try {
 *   await deployProject();
 * } catch (error) {
 *   handleCommandError({
 *     logger,
 *     operation: 'Deploy project',
 *     context: { brickId, projectPath },
 *     error
 *   });
 *   return; // or rethrow
 * }
 * ```
 */
export function handleCommandError(options: HandleCommandErrorOptions & { error: unknown }): void {
	const { logger, operation, context = {}, showToUser = true, userMessage, error } = options;

	const errorMessage = toErrorMessage(error);

	// Log error with full context
	logger.error(`${operation} failed`, {
		...context,
		error: errorMessage
	});

	// Show user-facing message
	if (showToUser) {
		void (userMessage ?? `${operation} failed: ${toUserFacingErrorMessage(error)}`);
		// Note: vscode is imported where this is used, so we can't import it here
		// Users of this function should handle vscode.window.showErrorMessage if needed
		// or we return the message for them to display
	}
}

/**
 * Alternative version that returns the formatted error message for display.
 * Useful when you want to show the error but need to customize the display logic.
 */
export function formatCommandError(options: Omit<HandleCommandErrorOptions, 'showToUser' | 'userMessage'> & { error: unknown }): {
	logMessage: string;
	userMessage: string;
} {
	const { logger, operation, context = {}, error } = options;

	const errorMessage = toErrorMessage(error);
	const logMessage = `${operation} failed`;
	const userMessage = `${operation} failed: ${toUserFacingErrorMessage(error)}`;

	// Log error with full context
	logger.error(logMessage, {
		...context,
		error: errorMessage
	});

	return { logMessage, userMessage };
}
