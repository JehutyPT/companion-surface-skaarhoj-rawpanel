import { afterEach, beforeEach } from 'vitest'
import type { LoggingSink } from '@companion-surface/base'

export interface LogLine {
	level: string
	message: string
}

/**
 * Capture what the plugin logs, per test: call once at the top of a spec. Installs a
 * `SURFACE_LOGGER` sink before each test and removes it after; the returned array holds the
 * current test's lines. It touches nothing else, so it composes with fake timers.
 */
export function captureLogs(): LogLine[] {
	const lines: LogLine[] = []
	beforeEach(() => {
		lines.length = 0
		const sink: LoggingSink = (_source, level, message) => lines.push({ level, message })
		globalThis.SURFACE_LOGGER = sink
	})
	afterEach(() => {
		globalThis.SURFACE_LOGGER = undefined
	})
	return lines
}

/** The messages logged at `level`. */
export function messagesAt(lines: LogLine[], level: string): string[] {
	return lines.filter((l) => l.level === level).map((l) => l.message)
}
