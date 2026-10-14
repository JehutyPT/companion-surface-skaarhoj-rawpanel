/**
 * Analog axes (joysticks, rockers, faders, T-bars) to Companion input transfer variables: the
 * panel's value rescaled linearly between each axis's dead zone and saturation, sent only on change
 * past the dead zone, at most once per interval per axis, with a trailing send so the final value
 * always arrives. All are user settings (`AnalogTuning`).
 */
import type { AnalogAxis, AnalogMode } from './topology.js'

export interface AxisTuning {
	/**
	 * In panel units, measured from 0: a value this close to 0 reads 0. Also the change threshold:
	 * changes smaller than this are not sent. 0 sends every change.
	 */
	deadband: number
	/** In panel units, measured from 0: a value at or past this reads as full travel (500 or 1000). */
	saturation: number
}

export interface AnalogTuning {
	/** At most one send per axis this often */
	intervalMs: number
	/** By HWC; an axis missing here uses `defaultAxisTuning` */
	axes: Readonly<Record<number, AxisTuning>>
}

/** Full travel from 0: intensity (`Speed`) axes run -500..500, absolute (`Abs`) ones 0..1000. */
export function fullScale(mode: AnalogMode): number {
	return mode === 'Speed' ? 500 : 1000
}

/** The joystick jitters by about ±5 at rest; saturation at full travel is off. */
export function defaultAxisTuning(mode: AnalogMode): AxisTuning {
	return { deadband: 6, saturation: fullScale(mode) }
}

/** Companion's variable-trigger throttle is about 20 Hz. */
export const DEFAULT_ANALOG_INTERVAL_MS = 50

export interface Range {
	min: number
	max: number
}

/** Accepted values; Companion's number field `min`/`max` are only a UI hint. */
export const ANALOG_INTERVAL_RANGE: Readonly<Range> = { min: 10, max: 1000 }
export const DEADBAND_RANGE: Readonly<Range> = { min: 0, max: 100 }
/** Saturation starts at 100 so it can't be set to swallow most of the travel by mistake. */
export function saturationRange(mode: AnalogMode): Range {
	return { min: 100, max: fullScale(mode) }
}

/** Surface config field ids for an axis's tuning */
export const deadbandFieldId = (hwc: number): string => `analogDeadband_${hwc}`
export const saturationFieldId = (hwc: number): string => `analogSaturation_${hwc}`

/**
 * The tuning from the surface config fields: `analogInterval`, and per axis `analogDeadband_<hwc>`
 * and `analogSaturation_<hwc>`. An axis without its own dead zone takes the old single
 * `analogDeadband` setting, so it carries over. A saturation not above the dead zone is ignored.
 */
export function parseAnalogTuning(config: Record<string, unknown>, axes: readonly AnalogAxis[]): AnalogTuning {
	const byHwc: Record<number, AxisTuning> = {}
	for (const { hwc, mode } of axes) {
		const fallback = defaultAxisTuning(mode)
		const deadband = parseWholeNumber(
			config[deadbandFieldId(hwc)] ?? config.analogDeadband,
			fallback.deadband,
			DEADBAND_RANGE,
		)
		const saturation = parseWholeNumber(config[saturationFieldId(hwc)], fallback.saturation, saturationRange(mode))
		byHwc[hwc] = { deadband, saturation: saturation > deadband ? saturation : fallback.saturation }
	}
	return {
		intervalMs: parseWholeNumber(config.analogInterval, DEFAULT_ANALOG_INTERVAL_MS, ANALOG_INTERVAL_RANGE),
		axes: byHwc,
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

/**
 * Linear rescale, measured from 0: within the dead zone reads 0, at or past saturation reads full
 * travel, and in between scales linearly, continuous at both edges. A `Speed` axis keeps its sign.
 */
function rescale(mode: AnalogMode, raw: number, { deadband, saturation }: AxisTuning): number {
	const full = fullScale(mode)
	const magnitude = Math.abs(raw)
	if (magnitude <= deadband) return 0
	const scaled = magnitude >= saturation ? full : Math.round((full * (magnitude - deadband)) / (saturation - deadband))
	// Never -0
	return raw < 0 && scaled !== 0 ? -scaled : scaled
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
	#tuning: Readonly<AnalogTuning> = { intervalMs: DEFAULT_ANALOG_INTERVAL_MS, axes: {} }
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
	 * A value from the panel, rescaled by the axis's dead zone and saturation, so an axis that comes
	 * to rest slightly off centre reads 0 and one that stops a few steps short of its end reads full
	 * travel. While Companion is locked only 0 goes out.
	 */
	input(hwc: number, raw: number): void {
		const state = this.#byHwc.get(hwc)
		if (!state || this.#stopped) return
		const mode = state.axis.mode
		const { intervalMs } = this.#tuning
		const tuning = this.#tuning.axes[hwc] ?? defaultAxisTuning(mode)
		const value = rescale(mode, raw, tuning)
		// The axis's dead zone is also its change threshold (hysteresis), on the rescaled value:
		// smaller changes are not sent, except to 0 or full travel.
		const deadband = tuning.deadband
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
