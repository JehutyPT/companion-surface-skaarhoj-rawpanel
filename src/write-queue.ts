/**
 * The connection's paced, coalescing write queue: one pending line per key, a line equal to the
 * last one sent for its key is dropped, bursts flush on the leading edge then at most one per
 * interval, and `BSY` holds writes until `RDY`, a panel `ping` or a timeout. Knows nothing of the
 * socket: it hands each burst to `send`. It does not know whether the panel is online either: the
 * owner writes only while online and calls `reset()` when the connection closes.
 */
import type { ModuleLogger } from '@companion-surface/base'

export interface WriteQueueTimings {
	/** Time between write bursts */
	writeIntervalMs: number
	/** Most lines sent per burst */
	writeBurst: number
	/** Resume writing this long after `BSY` if neither `RDY` nor a panel `ping` has arrived */
	busyTimeoutMs: number
}

export class WriteQueue {
	readonly #send: (lines: string[]) => void
	readonly #timings: WriteQueueTimings
	readonly #logger: ModuleLogger

	#writeTimer: NodeJS.Timeout | undefined
	#busyTimer: NodeJS.Timeout | undefined
	#busy = false
	/** When the last burst went out (monotonic `performance.now()`); `-Infinity` until the first one since the last reset. */
	#lastFlushAt = -Infinity
	readonly #pending = new Map<string, string>()
	readonly #lastSent = new Map<string, string>()

	constructor(send: (lines: string[]) => void, timings: WriteQueueTimings, logger: ModuleLogger) {
		this.#send = send
		this.#timings = timings
		this.#logger = logger
	}

	/**
	 * Queue a line. `key` identifies what the line sets (e.g. `HWCc#12`): a newer line for the same
	 * key replaces a queued one, and a line equal to the last one sent for that key is dropped.
	 */
	write(key: string, line: string): void {
		if (this.#lastSent.get(key) === line) {
			this.#pending.delete(key)
			return
		}
		// Re-insert so the queue keeps the order the commands were last written in (colour before state).
		this.#pending.delete(key)
		this.#pending.set(key, line)
		this.#scheduleFlush()
	}

	/**
	 * Hold or resume writes. A hold ends on `setBusy(false)` (`RDY` or a panel `ping`), or after
	 * `busyTimeoutMs`, so the queue cannot freeze if the panel sends neither.
	 */
	setBusy(busy: boolean): void {
		clearTimeout(this.#busyTimer)
		this.#busyTimer = undefined
		this.#busy = busy
		if (busy) {
			this.#busyTimer = setTimeout(() => {
				this.#logger.debug(`Still busy after ${this.#timings.busyTimeoutMs} ms with no RDY; resuming writes`)
				this.setBusy(false)
			}, this.#timings.busyTimeoutMs)
		} else {
			this.#scheduleFlush()
		}
	}

	/** Drop the line still pending for `key`, if any. A line already sent stays sent. */
	discard(key: string): void {
		this.#pending.delete(key)
	}

	/** Forget what was sent, so the next writes go out even if unchanged (the panel blanked itself). */
	resetDiffs(): void {
		this.#lastSent.clear()
	}

	/** Back to a fresh, idle queue: nothing pending or sent, not busy, no timers. For a new or closed connection. */
	reset(): void {
		clearTimeout(this.#writeTimer)
		this.#writeTimer = undefined
		clearTimeout(this.#busyTimer)
		this.#busyTimer = undefined
		this.#busy = false
		this.#pending.clear()
		this.#lastSent.clear()
		this.#lastFlushAt = -Infinity
	}

	/**
	 * Leading edge: if no burst went out within the last `writeIntervalMs`, flush on the next timer
	 * turn (so writes made in the same tick, such as colour then state, share one burst). Otherwise
	 * wait out the rest of the interval: at most one burst per `writeIntervalMs`.
	 */
	#scheduleFlush(): void {
		if (this.#writeTimer || this.#pending.size === 0 || this.#busy) return
		const delay = Math.max(0, this.#lastFlushAt + this.#timings.writeIntervalMs - performance.now())
		this.#writeTimer = setTimeout(() => {
			this.#writeTimer = undefined
			this.#flush()
		}, delay)
	}

	#flush(): void {
		if (this.#busy) return
		const lines: string[] = []
		for (const [key, line] of this.#pending) {
			if (lines.length >= this.#timings.writeBurst) break
			this.#pending.delete(key)
			this.#lastSent.set(key, line)
			lines.push(line)
		}
		if (lines.length) {
			this.#lastFlushAt = performance.now()
			this.#send(lines)
		}
		this.#scheduleFlush()
	}
}
