/**
 * Button presses to Companion key down/up. A four-way button (`HWC#n.<edge>=Down|Up`) is one key
 * (ADR 0003): key down on the first edge down, key up once every edge is up and has stayed up for the
 * release debounce, so a press that briefly lets go of every edge (near a four-way button's centre)
 * is one press, not two. Key down is never delayed. A plain button (no edge) is never debounced.
 */

export const DEFAULT_RELEASE_DEBOUNCE_MS = 30

/** A plain (edge-less) press uses this bit */
const PLAIN = 1

export class ButtonKeys {
	/**
	 * How long a four-way button's edges must all stay up before key up, in ms; 0 sends it at once.
	 * A change applies to the next release; a pending key up keeps its deadline.
	 */
	releaseDebounceMs = DEFAULT_RELEASE_DEBOUNCE_MS

	readonly #keyDown: (hwc: number) => void
	readonly #keyUp: (hwc: number) => void
	/** Pressed edges per HWC */
	readonly #held = new Map<number, number>()
	/** Four-way buttons whose edges are all up and whose key up waits out the debounce */
	readonly #pendingUp = new Map<number, ReturnType<typeof setTimeout>>()

	constructor(keyDown: (hwc: number) => void, keyUp: (hwc: number) => void) {
		this.#keyDown = keyDown
		this.#keyUp = keyUp
	}

	/** An edge (or a plain button, `edge` undefined) went down or up. */
	button(hwc: number, edge: number | undefined, down: boolean): void {
		const bit = edge ?? PLAIN
		const before = this.#held.get(hwc) ?? 0
		const after = down ? before | bit : before & ~bit
		this.#held.set(hwc, after)

		const pending = this.#pendingUp.get(hwc)
		if (pending !== undefined && after !== 0) {
			// Back down within the debounce: the same press continues
			clearTimeout(pending)
			this.#pendingUp.delete(hwc)
		} else if (before === 0 && after !== 0) {
			this.#keyDown(hwc)
		} else if (before !== 0 && after === 0) {
			if (edge === undefined || this.releaseDebounceMs <= 0) {
				this.#keyUp(hwc)
			} else {
				const timer = setTimeout(() => this.#firePendingUp(hwc), this.releaseDebounceMs)
				this.#pendingUp.set(hwc, timer)
			}
		}
	}

	/** Key up for every key still down or waiting on its debounce, now; nothing fires later. */
	releaseAll(): void {
		for (const [hwc, mask] of this.#held) {
			if (mask !== 0) this.#keyUp(hwc)
		}
		this.#held.clear()
		this.#flushPending()
	}

	/**
	 * For close: key up now for each key waiting on its debounce (its edges are up, so Companion is owed
	 * it), and forget keys still held. Nothing fires later.
	 */
	stop(): void {
		this.#held.clear()
		this.#flushPending()
	}

	#flushPending(): void {
		for (const [hwc, timer] of this.#pendingUp) {
			clearTimeout(timer)
			this.#keyUp(hwc)
		}
		this.#pendingUp.clear()
	}

	#firePendingUp(hwc: number): void {
		this.#pendingUp.delete(hwc)
		this.#keyUp(hwc)
	}
}
