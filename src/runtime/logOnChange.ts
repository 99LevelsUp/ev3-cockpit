/**
 * Wraps a log call so a message repeated on every scan is written once, and again only when it
 * changes.
 *
 * For conditions a periodic job meets every time it runs: the Bluetooth device cache is
 * Windows-only, discovery asks it every scan, and on Linux the log got the same warning every
 * three seconds (found on HOSTC, 11.11.2026). A change of message is news and is logged.
 */
export function logOnChange(log: (message: string) => void): (message: string) => void {
	let last: string | undefined;
	return (message) => {
		if (message === last) { return; }
		last = message;
		log(message);
	};
}
