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

/**
 * The same, kept apart per key: `act` runs for a key's value only when it differs from the last
 * value seen for that key. For a state each brick or channel reports on its own, where one key's
 * news must not hide another's.
 */
export function onChangePerKey<K, V>(act: (key: K, value: V) => void): (key: K, value: V) => void {
	const last = new Map<K, V>();
	return (key, value) => {
		if (last.has(key) && last.get(key) === value) { return; }
		last.set(key, value);
		act(key, value);
	};
}
