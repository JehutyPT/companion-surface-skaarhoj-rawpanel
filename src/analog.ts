/**
 * Analog axes (joysticks, rockers, faders, T-bars) to Companion input transfer variables: the
 * panel's raw value, sent only on change past a small deadband, at most once per interval per
 * axis, with a trailing send so the final value always arrives.
 */
import type { AnalogAxis, AnalogMode } from './topology.js'

/** Changes smaller than this (in panel units) are not sent. The joystick jitters by about ±5 at rest. */
export const ANALOG_DEADBAND = 6
/** At most one send per axis this often: Companion's variable-trigger throttle is about 20 Hz. */
export const ANALOG_INTERVAL_MS = 50

interface AxisState {
	axis: AnalogAxis
	lastSent: number | undefined
	lastSentAt: number
	pending: number | undefined
	timer: NodeJS.Timeout | undefined
}

/**
 * Values that always go out when they differ from the last one sent, past the deadband: the rest
 * position (0) and the ends of travel. The return to centre must never be swallowed.
 */
function bypassesDeadband(mode: AnalogMode, value: number): boolean {
	return mode === 'Speed' ? value === 0 || Math.abs(value) >= 500 : value <= 0 || value >= 1000
}

export class AnalogSender {
	readonly #byHwc = new Map<number, AxisState>()
	readonly #send: (variableId: string, value: number) => void
	readonly #isLocked: () => boolean
	#stopped = false

	constructor(axes: AnalogAxis[], send: (variableId: string, value: number) => void, isLocked: () => boolean) {
		this.#send = send
		this.#isLocked = isLocked
		for (const axis of axes) {
			this.#byHwc.set(axis.hwc, {
				axis,
				lastSent: undefined,
				lastSentAt: -Infinity,
				pending: undefined,
				timer: undefined,
			})
		}
	}

	/**
	 * A value from the panel. An intensity axis within the deadband of 0 counts as 0, so an axis that
	 * comes to rest slightly off centre still reads 0. While Companion is locked only 0 goes out.
	 */
	input(hwc: number, raw: number): void {
		const state = this.#byHwc.get(hwc)
		if (!state || this.#stopped) return
		const mode = state.axis.mode
		const value = mode === 'Speed' && Math.abs(raw) < ANALOG_DEADBAND ? 0 : raw
		if (value !== 0 && this.#isLocked()) {
			state.pending = undefined
			return
		}

		const last = state.lastSent
		const changed =
			last === undefined ||
			(value !== last && (bypassesDeadband(mode, value) || Math.abs(value - last) >= ANALOG_DEADBAND))
		if (!changed) {
			// Back within the deadband of what Companion has: a queued value is now stale.
			state.pending = undefined
			return
		}
		if (!state.timer && performance.now() - state.lastSentAt >= ANALOG_INTERVAL_MS) {
			this.#emit(state, value)
			return
		}
		state.pending = value
		state.timer ??= setTimeout(
			() => {
				state.timer = undefined
				const pending = state.pending
				state.pending = undefined
				if (pending === undefined || this.#stopped) return
				if (pending !== 0 && this.#isLocked()) return
				this.#emit(state, pending)
			},
			Math.max(0, state.lastSentAt + ANALOG_INTERVAL_MS - performance.now()),
		)
	}

	/**
	 * Put every intensity axis (joystick, rocker) at rest: drop queued values and send 0 where
	 * Companion has anything else. Absolute axes (faders) keep their value.
	 */
	rest(): void {
		if (this.#stopped) return
		for (const state of this.#byHwc.values()) {
			this.#cancel(state)
			if (state.axis.mode === 'Speed' && state.lastSent !== 0) this.#emit(state, 0)
		}
	}

	stop(): void {
		this.#stopped = true
		for (const state of this.#byHwc.values()) this.#cancel(state)
	}

	#cancel(state: AxisState): void {
		clearTimeout(state.timer)
		state.timer = undefined
		state.pending = undefined
	}

	#emit(state: AxisState, value: number): void {
		state.lastSent = value
		state.lastSentAt = performance.now()
		this.#send(state.axis.variableId, value)
	}
}
