/**
 * Shared polling helper for tests that wait on asynchronous state.
 *
 * Not a `.test.ts` file, so the unit runner (which globs `out/__tests__/*.test.js`)
 * does not try to execute it as a suite.
 */

/**
 * Polls until `predicate` holds. Throws once `timeoutMs` elapses, so a condition
 * that never becomes true fails the test with a clear message instead of hanging
 * the whole run.
 */
export async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error(`Condition not met within ${timeoutMs}ms.`);
		}
		await new Promise<void>((r) => setTimeout(r, 25));
	}
}
