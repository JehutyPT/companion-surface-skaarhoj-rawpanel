/** Poll until `predicate` is true, or fail after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000, message = 'condition'): Promise<void> {
	const start = Date.now()
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${message}`)
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

/**
 * Wait until `count` has not changed for `quietMs`, or fail after `timeoutMs`. Never returns sooner
 * than `quietMs`, and waits longer while things keep arriving, so a slow machine only makes it slower.
 */
export async function waitForQuiet(
	count: () => number,
	quietMs: number,
	timeoutMs = 2000,
	message = 'quiet',
): Promise<void> {
	const start = Date.now()
	let last = count()
	let changedAt = start
	while (Date.now() - changedAt < quietMs) {
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${message}`)
		await new Promise((resolve) => setTimeout(resolve, 5))
		const now = count()
		if (now !== last) {
			last = now
			changedAt = Date.now()
		}
	}
}

export async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}
