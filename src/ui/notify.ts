/**
 * Notifications that are also written to the log (owner, U10 hardware session, 09.11.2026).
 *
 * The person at the bench watches the brick's display, not the screen, and a user reporting a
 * problem rarely copies a toast. The log has to say what the person was told, word for word.
 */

/** The log levels a notification is written at. */
export interface NotifyLog {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

/** The part of `vscode.window` that shows notifications. */
export interface NotifyWindow {
	showInformationMessage(message: string, ...items: string[]): PromiseLike<string | undefined>;
	showWarningMessage(message: string): PromiseLike<string | undefined>;
	showErrorMessage(message: string): PromiseLike<string | undefined>;
}

/** Shows a notification and logs it at the matching level, prefixed "Shown:". */
export interface Notifier {
	info(message: string, ...items: string[]): PromiseLike<string | undefined>;
	warn(message: string): PromiseLike<string | undefined>;
	error(message: string): PromiseLike<string | undefined>;
	/** Logs the title of a progress notification the caller shows itself. */
	progressShown(title: string): void;
}

export function createNotifier(log: NotifyLog, window: NotifyWindow): Notifier {
	return {
		info: (message, ...items) => {
			log.info(`Shown: ${message}`);
			return window.showInformationMessage(message, ...items);
		},
		warn: (message) => {
			log.warn(`Shown: ${message}`);
			return window.showWarningMessage(message);
		},
		error: (message) => {
			log.error(`Shown: ${message}`);
			return window.showErrorMessage(message);
		},
		progressShown: (title) => { log.info(`Shown: ${title}`); },
	};
}
