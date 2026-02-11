export class ExtensionError extends Error {
	readonly code: string;
	readonly cause?: unknown;

	constructor(code: string, message: string, cause?: unknown) {
		super(message);
		this.name = 'ExtensionError';
		this.code = code;
		this.cause = cause;
	}
}
