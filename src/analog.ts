/**
 * Analog axes (joysticks, rockers, faders, T-bars) to Companion input transfer variables: the
 * panel's raw value, sent only on change past a deadband, at most once per interval per axis, with
 * a trailing send so the final value always arrives. Both are user settings (`AnalogTuning`).
 */
import type { AnalogAxis, AnalogMode } from './topology.js'

export interface AnalogTuning {
	/** Changes smaller than this (in panel units) are not sent; an intensity value this close to 0 counts as 0. 0 sends every change. */
	deadband: number
	/** At most one send per axis this often */
	intervalMs: number
}

/** The joystick jitters by about ±5 at rest; Companion's variable-trigger throttle is about 20 Hz. */
export const DEFAULT_ANALOG_TUNING: Readonly<AnalogTuning> = { deadband: 6, intervalMs: 50 }

interface Range {
	min: number
	max: number
}

/** Accepted values; Companion's number field `min`/`max` are only a UI hint. */
export const ANALOG_TUNING_RANGES: Readonly<Record<keyof AnalogTuning, Range>> = {
	deadband: { min: 0, max: 100 },
	intervalMs: { min: 10, max: 1000 },
}

/** The tuning from the surface config fields `analogDeadband` and `analogInterval`. */
export function parseAnalogTuning(config: Record<string, unknown>): AnalogTuning {
	return {
		deadband: parseWholeNumber(config.analogDeadband, DEFAULT_ANALOG_TUNING.deadband, ANALOG_TUNING_RANGES.deadband),
		intervalMs: parseWholeNumber(
			config.analogInterval,
			DEFAULT_ANALOG_TUNING.intervalMs,
			ANALOG_TUNING_RANGES.intervalMs,
		),
	}
}

/** A whole number clamped to the range; the default for anything missing or not a number. */
function parseWholeNumber(value: unknown, fallback: number, range: Range): number {
	if (typeof value === 'string' && value.trim() === '') return fallback
	if (typeof value !== 'number' && typeof value !== 'string') return fallback
	const n = Number(value)
	if (!Number.isFinite(n)) return fallback
	return Math.max(range.min, Math.min(range.max, Math.round(n)))
}

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
	#tuning: Readonly<AnalogTuning> = DEFAULT_ANALOG_TUNING
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

	/** New tuning, applied from the next value. A trailing send already queued keeps its time. */
	configure(tuning: Readonly<AnalogTuning>): void {
		this.#tuning = tuning
	}

	/**
	 * A value from the panel. An intensity axis within the deadband of 0 counts as 0, so an axis that
	 * comes to rest slightly off centre still reads 0. While Companion is locked only 0 goes out.
	 */
	input(hwc: number, raw: number): void {
		const state = this.#byHwc.get(hwc)
		if (!state || this.#stopped) return
		const mode = state.axis.mode
		const { deadband, intervalMs } = this.#tuning
		const value = mode === 'Speed' && Math.abs(raw) < deadband ? 0 : raw
		if (value !== 0 && this.#isLocked()) {
			state.pending = undefined
			return
		}

		const last = state.lastSent
		const changed =
			last === undefined || (value !== last && (bypassesDeadband(mode, value) || Math.abs(value - last) >= deadband))
		if (!changed) {
			// Back within the deadband of what Companion has: a queued value is now stale.
			state.pending = undefined
			return
		}
		if (!state.timer && performance.now() - state.lastSentAt >= intervalMs) {
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
			Math.max(0, state.lastSentAt + intervalMs - performance.now()),
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
