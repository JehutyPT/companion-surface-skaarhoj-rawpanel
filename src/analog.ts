/**
 * Analog axes (joysticks, rockers, faders, T-bars) to Companion input transfer variables: the
 * panel's value rescaled linearly between each axis's dead zone and saturation, sent only on change
 * past the dead zone, at most once per interval per axis, with a trailing send so the final value
 * always arrives. Also what each axis mode means to the user: its range text, its default tuning and
 * its transfer variable declaration. The tuning (`AnalogTuning`) is read from the surface settings in
 * settings.ts; the defaults here are the sender's own fallback and the settings' defaults.
 */
import type { SurfaceInputVariable } from '@companion-surface/base'
import type { AnalogAxis, AnalogMode } from './topology.js'

export interface AxisTuning {
	/** A disabled axis sends nothing; its input events are ignored. */
	enabled: boolean
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

/** The panel's range for an axis mode, as shown to the user: `-500 to 500` or `0 to 1000`. */
export function rangeText(mode: AnalogMode): string {
	const full = fullScale(mode)
	return mode === 'Speed' ? `-${full} to ${full}` : `0 to ${full}`
}

/** The Companion input transfer variable for an axis. */
export function axisTransferVariable(axis: AnalogAxis): SurfaceInputVariable {
	const range = axis.mode === 'Speed' ? `${rangeText(axis.mode)}, 0 at rest` : rangeText(axis.mode)
	return {
		id: axis.variableId,
		type: 'input',
		name: axis.name,
		description: `Value ${range}, scaled linearly by this axis's dead zone and saturation settings. The plugin can't create or preselect a variable here: create a custom variable once (suggested name: ${axis.suggestedVariable}, with "persist value" off) and pick it.`,
	}
}

/** The joystick jitters by about ±5 at rest; saturation at full travel is off. */
export function defaultAxisTuning(mode: AnalogMode): AxisTuning {
	return { enabled: true, deadband: 6, saturation: fullScale(mode) }
}

/** Companion's variable-trigger throttle is about 20 Hz. */
export const DEFAULT_ANALOG_INTERVAL_MS = 50

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
	/** Before `start()`: the latest raw value from the panel, sent at `start()` */
	beforeStart: number | undefined
}

/**
 * Values that always go out when they differ from the last one sent, past the deadband: the rest
 * position (0) and the ends of travel. The return to centre must never be swallowed.
 */
function bypassesDeadband(mode: AnalogMode, value: number): boolean {
	return value === 0 || Math.abs(value) >= fullScale(mode)
}

export class AnalogSender {
	readonly #byHwc = new Map<number, AxisState>()
	readonly #send: (variableId: string, value: number) => void
	readonly #isLocked: () => boolean
	#tuning: Readonly<AnalogTuning> = { intervalMs: DEFAULT_ANALOG_INTERVAL_MS, axes: {} }
	#started = false
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
				beforeStart: undefined,
			})
		}
	}

	/**
	 * New tuning, applied from the next value. A trailing send already queued keeps its time. An axis
	 * that is now disabled drops its queued value and is put at rest, as `rest()` does, so Companion
	 * isn't left holding it mid-travel.
	 */
	configure(tuning: Readonly<AnalogTuning>): void {
		this.#tuning = tuning
		if (this.#stopped) return
		for (const state of this.#byHwc.values()) {
			// 0 only where Companion is known to hold another value; otherwise nothing
			if (!this.#isEnabled(state)) this.#putAtRest(state, false)
		}
	}

	/**
	 * A value from the panel, rescaled by the axis's dead zone and saturation, so an axis that comes
	 * to rest slightly off centre reads 0 and one that stops a few steps short of its end reads full
	 * travel. While Companion is locked only 0 goes out.
	 */
	input(hwc: number, raw: number): void {
		const state = this.#byHwc.get(hwc)
		if (!state || this.#stopped || !this.#isEnabled(state)) return
		if (!this.#started) {
			// Companion drops values sent before it registers the surface: keep the latest for start()
			state.beforeStart = raw
			return
		}
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
	 * Companion has registered the surface (`ready()`): from now on values are sent. Each enabled axis
	 * sends its current value: the latest the panel reported before now, or, for an intensity axis
	 * that reported none (or none Companion may have while locked), its rest value 0.
	 */
	start(): void {
		if (this.#started || this.#stopped) return
		this.#started = true
		for (const state of this.#byHwc.values()) {
			const reported = state.beforeStart
			state.beforeStart = undefined
			if (!this.#isEnabled(state)) continue
			if (reported !== undefined) this.input(state.axis.hwc, reported)
			if (state.lastSent === undefined) this.#putAtRest(state, true)
		}
	}

	/**
	 * Put every enabled intensity axis (joystick, rocker) at rest: drop queued values and send 0 where
	 * Companion has anything else. Absolute axes (faders) keep their value. Disabled axes were put at
	 * rest when they were disabled and send nothing more. Before `start()`, nothing is sent: an
	 * intensity axis forgets the value it reported, so it sends 0 at `start()`.
	 */
	rest(): void {
		if (this.#stopped) return
		if (!this.#started) {
			for (const state of this.#byHwc.values()) if (state.axis.mode === 'Speed') state.beforeStart = undefined
			return
		}
		for (const state of this.#byHwc.values()) {
			if (this.#isEnabled(state)) this.#putAtRest(state, true)
		}
	}

	stop(): void {
		this.#stopped = true
		for (const state of this.#byHwc.values()) this.#cancel(state)
	}

	#isEnabled(state: AxisState): boolean {
		return this.#tuning.axes[state.axis.hwc]?.enabled ?? true
	}

	/**
	 * Drop the axis's queued value and, for an intensity axis, send 0 unless Companion already has it.
	 * `ifNeverSent`: also send 0 when nothing was sent yet (Companion's value is unknown).
	 */
	#putAtRest(state: AxisState, ifNeverSent: boolean): void {
		this.#cancel(state)
		if (state.axis.mode !== 'Speed' || state.lastSent === 0) return
		if (state.lastSent !== undefined || ifNeverSent) this.#emit(state, 0)
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
