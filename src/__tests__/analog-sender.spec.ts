/**
 * The analog rules, driven through `AnalogSender` under fake timers: rescaling between dead zone and
 * saturation, the change threshold, coalescing, lock, rest, stop and enabling/disabling an axis.
 * The wiring between the surface and the sender (ready, link drop, lock, close, live settings) is
 * covered end to end in analog.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
	AnalogSender,
	DEFAULT_ANALOG_INTERVAL_MS,
	defaultAxisTuning,
	type AnalogTuning,
	type AxisTuning,
} from '../analog.js'
import type { AnalogAxis } from '../topology.js'

const speedAxis = (hwc: number): AnalogAxis => ({
	hwc,
	variableId: `hwc_${hwc}`,
	name: `Axis ${hwc}`,
	suggestedVariable: `skaarhoj_hwc_${hwc}`,
	mode: 'Speed',
})
const fader: AnalogAxis = {
	hwc: 5,
	variableId: 'hwc_5',
	name: 'Fader',
	suggestedVariable: 'skaarhoj_fader',
	mode: 'Abs',
}
/** Past the default send interval, so the next value is not held back */
const PAST_INTERVAL_MS = DEFAULT_ANALOG_INTERVAL_MS + 20

/** The PTZ Extreme's axes: zoom rocker and the joystick's three axes */
const ptzAxes = [speedAxis(58), speedAxis(60), speedAxis(61), speedAxis(62)]

/** Tuning with the defaults for every axis not given; a given axis overrides only what it names. */
function tuning(axes: Record<number, Partial<AxisTuning>> = {}, intervalMs = DEFAULT_ANALOG_INTERVAL_MS): AnalogTuning {
	const byHwc: Record<number, AxisTuning> = {}
	for (const [hwc, override] of Object.entries(axes)) {
		const axis = [...ptzAxes, fader].find((a) => a.hwc === Number(hwc))!
		byHwc[Number(hwc)] = { ...defaultAxisTuning(axis.mode), ...override }
	}
	return { intervalMs, axes: byHwc }
}

/**
 * A sender with a recording send callback and a lock switch. `ready` (the default) starts it, which
 * puts the axes at rest, as the surface does on `ready()`, lets the send interval pass, then clears
 * what was sent.
 */
function setup(options: { axes?: AnalogAxis[]; tuning?: AnalogTuning; ready?: boolean } = {}) {
	const sent: [string, number][] = []
	let locked = false
	const sender = new AnalogSender(
		options.axes ?? ptzAxes,
		(id, value) => sent.push([id, value]),
		() => locked,
	)
	if (options.tuning) sender.configure(options.tuning)
	if (options.ready ?? true) {
		sender.start()
		vi.advanceTimersByTime(PAST_INTERVAL_MS)
		sent.length = 0
	}
	return {
		sender,
		sent,
		lock: (value: boolean) => {
			locked = value
		},
	}
}

/** Each value on the axis, spaced past the send interval so none is held back. */
function inputSpaced(sender: AnalogSender, hwc: number, values: number[]) {
	for (const value of values) {
		sender.input(hwc, value)
		vi.advanceTimersByTime(PAST_INTERVAL_MS)
	}
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe('rescaling between dead zone and saturation', () => {
	test('a move sends its value at once; with the default dead zone the ends stay at ±500', () => {
		const { sender, sent } = setup()

		sender.input(60, -487)
		sender.input(58, 500)

		expect(sent).toEqual([
			['hwc_60', -487],
			['hwc_58', 500],
		])
	})

	test('absolute (fader) values run 0 to 1000', () => {
		const { sender, sent } = setup({ axes: [fader] })

		sender.input(5, 1000)

		expect(sent).toEqual([['hwc_5', 1000]])
	})

	test('an intensity axis resting a few units off centre reads 0', () => {
		const { sender, sent } = setup()

		inputSpaced(sender, 62, [-20, -3])

		// -20 scaled past the dead zone: 500 * 14 / 494 = 14.2
		expect(sent).toEqual([
			['hwc_62', -14],
			['hwc_62', 0],
		])
	})

	test('an axis that stops short of full travel reaches ±500 once its saturation is set just below its end', () => {
		const { sender, sent } = setup({ tuning: tuning({ 60: { saturation: 495 } }) })

		inputSpaced(sender, 60, [-496, 496])

		expect(sent).toEqual([
			['hwc_60', -500],
			['hwc_60', 500],
		])
	})

	test('between dead zone and saturation the value scales linearly to the full range', () => {
		const { sender, sent } = setup({ tuning: tuning({ 60: { deadband: 6, saturation: 495 } }) })

		inputSpaced(sender, 60, [250, -125])

		// 500 * (250 - 6) / (495 - 6) = 249.49 -> 249; 500 * (125 - 6) / 489 = 121.68 -> -122
		expect(sent).toEqual([
			['hwc_60', 249],
			['hwc_60', -122],
		])
	})

	test('the scale is continuous at both edges: no jump past the dead zone or before saturation', () => {
		// 500 / (120 - 20) = 5 per panel step
		const { sender, sent } = setup({ tuning: tuning({ 61: { deadband: 20, saturation: 120 } }) })

		inputSpaced(sender, 61, [-60, -21, -20, 119, 120])

		expect(sent).toEqual([
			['hwc_61', -200],
			['hwc_61', -5],
			['hwc_61', 0],
			['hwc_61', 495],
			['hwc_61', 500],
		])
	})

	test('two axes with different settings are tuned independently', () => {
		const { sender, sent } = setup({
			tuning: tuning({ 60: { deadband: 0, saturation: 500 }, 61: { deadband: 50, saturation: 250 } }),
		})

		sender.input(60, 40)
		sender.input(61, 40)
		vi.advanceTimersByTime(PAST_INTERVAL_MS)
		sender.input(60, 250)
		sender.input(61, 250)
		vi.advanceTimersByTime(PAST_INTERVAL_MS)

		expect(sent).toEqual([
			['hwc_60', 40],
			['hwc_60', 250],
			['hwc_61', 500],
		])
	})

	test('a fader scales from its dead zone above 0 to its saturation', () => {
		const { sender, sent } = setup({ axes: [fader], tuning: tuning({ 5: { deadband: 10, saturation: 990 } }) })

		inputSpaced(sender, 5, [500, 995, 8])

		// 1000 * (500 - 10) / 980 = 500
		expect(sent).toEqual([
			['hwc_5', 500],
			['hwc_5', 1000],
			['hwc_5', 0],
		])
	})
})

describe('change threshold', () => {
	test('changes within the dead zone are not sent, but the return to centre always is', () => {
		const { sender, sent } = setup()

		inputSpaced(sender, 60, [3, 40, 42, 0])

		// Scaled past the default dead zone of 6: 40 -> 34, 42 -> 36 (within 6 of 34)
		expect(sent).toEqual([
			['hwc_60', 34],
			['hwc_60', 0],
		])
	})

	test('on a fader the dead zone is a change threshold across the whole travel; only 0 and 1000 bypass it', () => {
		const { sender, sent } = setup({ axes: [fader] })

		inputSpaced(sender, 5, [700, 703, 997, 1000])

		// Scaled by 1000 / 994: 700 -> 698, 703 -> 701 (within 6 of 698), 997 -> 997
		expect(sent).toEqual([
			['hwc_5', 698],
			['hwc_5', 997],
			['hwc_5', 1000],
		])
	})

	test('a dead zone of 0 sends every change, including a few units off centre', () => {
		const { sender, sent } = setup({ tuning: tuning({ 60: { deadband: 0 } }) })

		inputSpaced(sender, 60, [3, 4])

		expect(sent).toEqual([
			['hwc_60', 3],
			['hwc_60', 4],
		])
	})

	test('a larger dead zone swallows bigger changes, but the ends of travel and centre still get through', () => {
		const { sender, sent } = setup({ tuning: tuning({ 60: { deadband: 50 } }) })

		// Scaled by 500 / 450: 40 -> 0, 100 -> 56, 140 -> 100 (within 50 of 56), 480 -> 478
		inputSpaced(sender, 60, [40, 100, 140, 480, 500, 30])

		expect(sent).toEqual([
			['hwc_60', 56],
			['hwc_60', 478],
			['hwc_60', 500],
			['hwc_60', 0],
		])
	})
})

describe('coalescing', () => {
	test('a fast burst is coalesced per axis to one send per 50 ms, always ending on the final value', () => {
		const { sender, sent } = setup()

		for (let v = 10; v <= 400; v += 10) sender.input(61, v)
		sender.input(61, 0)
		sender.input(62, -200)

		// 20 scaled past the default dead zone: 500 * 14 / 494 = 14.2 (10 -> 4 is within 6 of 0).
		// -200: 500 * 194 / 494 = 196.4. Another axis is not held back by the first one's coalescing.
		expect(sent).toEqual([
			['hwc_61', 14],
			['hwc_62', -196],
		])

		vi.advanceTimersByTime(49)
		expect(sent).toHaveLength(2)

		// The trailing send carries only the latest value
		vi.advanceTimersByTime(1)
		expect(sent).toEqual([
			['hwc_61', 14],
			['hwc_62', -196],
			['hwc_61', 0],
		])

		vi.advanceTimersByTime(200)
		expect(sent).toHaveLength(3)
	})

	test('a longer send interval coalesces a burst more, still ending on the final value', () => {
		const { sender, sent } = setup({ tuning: tuning({ 61: { deadband: 0 } }, 300) })
		vi.advanceTimersByTime(300)

		sender.input(61, 100)
		vi.advanceTimersByTime(100)
		sender.input(61, 200)
		vi.advanceTimersByTime(100)
		sender.input(61, 250)
		vi.advanceTimersByTime(99)
		expect(sent).toEqual([['hwc_61', 100]])

		// 300 ms after the first send
		vi.advanceTimersByTime(1)
		expect(sent).toEqual([
			['hwc_61', 100],
			['hwc_61', 250],
		])
	})

	test('a value back within the change threshold of the last one sent drops the queued value', () => {
		const { sender, sent } = setup({ tuning: tuning({ 60: { deadband: 0 } }) })

		sender.input(60, 100)
		sender.input(60, 200)
		sender.input(60, 100)
		vi.advanceTimersByTime(200)

		expect(sent).toEqual([['hwc_60', 100]])
	})
})

describe('live retuning', () => {
	test('new tuning applies from the next value', () => {
		const { sender, sent } = setup()
		sender.input(60, 2)
		expect(sent).toEqual([])

		sender.configure(tuning({ 60: { deadband: 0, saturation: 400 } }, 10))
		sender.input(60, 2)
		vi.advanceTimersByTime(30)
		sender.input(60, 450)
		vi.advanceTimersByTime(30)

		// 500 * 2 / 400 = 2.5 -> 3; 450 is past saturation
		expect(sent).toEqual([
			['hwc_60', 3],
			['hwc_60', 500],
		])
	})

	test('a shorter send interval lets values through sooner', () => {
		const { sender, sent } = setup({ tuning: tuning({ 60: { deadband: 0 } }) })
		sender.input(60, 100)

		sender.configure(tuning({ 60: { deadband: 0 } }, 10))
		vi.advanceTimersByTime(10)
		sender.input(60, 200)

		expect(sent).toEqual([
			['hwc_60', 100],
			['hwc_60', 200],
		])
	})
})

describe('lock', () => {
	test('a value queued just before Companion locks is not sent', () => {
		const { sender, sent, lock } = setup()

		sender.input(60, 100)
		sender.input(60, 200)
		expect(sent).toEqual([['hwc_60', 95]])
		lock(true)
		vi.advanceTimersByTime(PAST_INTERVAL_MS)

		expect(sent).toEqual([['hwc_60', 95]])
	})

	test('while locked, moves are ignored but the return to centre is still sent', () => {
		const { sender, sent, lock } = setup()
		inputSpaced(sender, 60, [-300])
		sent.length = 0
		lock(true)

		inputSpaced(sender, 61, [200])
		inputSpaced(sender, 60, [0])

		expect(sent).toEqual([['hwc_60', 0]])
	})
})

describe('rest', () => {
	test('intensity axes start at rest: each sends 0, in HWC order; a fader has no rest position', () => {
		const { sender, sent } = setup({ axes: [fader, ...ptzAxes], ready: false })

		sender.start()

		expect(sent).toEqual([
			['hwc_58', 0],
			['hwc_60', 0],
			['hwc_61', 0],
			['hwc_62', 0],
		])
	})

	test('deflected intensity axes return to 0; axes already at 0 and faders keep their value', () => {
		const { sender, sent } = setup({ axes: [fader, ...ptzAxes] })
		sender.input(60, -300)
		sender.input(58, 250)
		sender.input(5, 700)
		vi.advanceTimersByTime(PAST_INTERVAL_MS)
		sent.length = 0

		sender.rest()

		expect(sent).toEqual([
			['hwc_58', 0],
			['hwc_60', 0],
		])
	})

	test('a queued value is dropped when the axis is put at rest', () => {
		const { sender, sent } = setup({ tuning: tuning({ 60: { deadband: 0 } }) })
		sender.input(60, 100)
		sender.input(60, 200)

		sender.rest()
		vi.advanceTimersByTime(200)

		expect(sent).toEqual([
			['hwc_60', 100],
			['hwc_60', 0],
		])
	})
})

describe('start', () => {
	test('nothing is sent before start; at start each axis sends its latest value, an intensity axis with none 0', () => {
		const { sender, sent } = setup({ axes: [fader, speedAxis(58), speedAxis(60), speedAxis(61)], ready: false })
		sender.input(5, 300)
		sender.input(5, 700)
		sender.input(58, 2)
		sender.input(60, -300)
		vi.advanceTimersByTime(PAST_INTERVAL_MS)
		expect(sent).toEqual([])

		sender.start()

		// Scaled past the default dead zone: 1000 * 694 / 994 = 698.2 and -500 * 294 / 494 = -297.6
		expect(sent).toEqual([
			['hwc_5', 698],
			['hwc_58', 0],
			['hwc_60', -298],
			['hwc_61', 0],
		])
	})

	test('a rest before start puts intensity axes at 0 for start; a fader keeps its latest value', () => {
		const { sender, sent } = setup({ axes: [fader, speedAxis(60)], ready: false })
		sender.input(5, 700)
		sender.input(60, -300)

		sender.rest()
		expect(sent).toEqual([])
		sender.start()

		expect(sent).toEqual([
			['hwc_5', 698],
			['hwc_60', 0],
		])
	})
})

describe('stop', () => {
	test('nothing is sent after stop: not a queued value, a new input or a rest', () => {
		const { sender, sent } = setup()
		sender.input(60, 100)
		sender.input(60, 200)
		sender.rest()
		sender.stop()
		sent.length = 0

		vi.advanceTimersByTime(80)
		sender.input(60, 300)
		sender.rest()
		sender.configure(tuning({ 60: { enabled: false } }))
		vi.advanceTimersByTime(80)

		expect(sent).toEqual([])
		expect(vi.getTimerCount()).toBe(0)
	})
})

describe('enabling and disabling an axis', () => {
	test('a disabled axis sends nothing; the other axes are unaffected', () => {
		const { sender, sent } = setup({ tuning: tuning({ 60: { enabled: false } }) })

		sender.input(60, 300)
		sender.input(61, 300)
		vi.advanceTimersByTime(PAST_INTERVAL_MS)
		sender.input(60, 0)
		vi.advanceTimersByTime(PAST_INTERVAL_MS)

		// 300 scaled past the default dead zone: 500 * 294 / 494 = 297.6
		expect(sent).toEqual([['hwc_61', 298]])
	})

	test('disabling a deflected axis drops its queued value and puts it at rest once', () => {
		const { sender, sent } = setup({ tuning: tuning({ 60: { deadband: 0 } }) })

		sender.input(60, 100)
		sender.input(60, 200)
		expect(sent).toEqual([['hwc_60', 100]])
		sender.configure(tuning({ 60: { deadband: 0, enabled: false } }))
		sender.configure(tuning({ 60: { deadband: 0, enabled: false } }))
		vi.advanceTimersByTime(PAST_INTERVAL_MS)

		expect(sent).toEqual([
			['hwc_60', 100],
			['hwc_60', 0],
		])
	})

	test('a disabled axis already at rest sends nothing, and a later rest sends it nothing either', () => {
		const { sender, sent } = setup()
		sender.configure(tuning({ 62: { enabled: false } }))
		expect(sent).toEqual([])
		inputSpaced(sender, 60, [-300])
		sent.length = 0

		sender.rest()

		expect(sent).toEqual([['hwc_60', 0]])
	})

	test('a disabled axis is not put at rest at start, when nothing was sent yet', () => {
		const { sender, sent } = setup({ ready: false, tuning: tuning({ 58: { enabled: false }, 61: { enabled: false } }) })

		sender.start()

		expect(sent.map(([id]) => id)).toEqual(['hwc_60', 'hwc_62'])
	})

	test('a disabled fader keeps the value Companion has', () => {
		const { sender, sent } = setup({ axes: [fader] })
		inputSpaced(sender, 5, [1000])

		sender.configure(tuning({ 5: { enabled: false } }))
		inputSpaced(sender, 5, [300])

		expect(sent).toEqual([['hwc_5', 1000]])
	})

	test('enabling an axis again sends its next value', () => {
		const { sender, sent } = setup({ tuning: tuning({ 60: { enabled: false } }) })
		inputSpaced(sender, 60, [300])

		sender.configure(tuning({ 60: { enabled: true } }))
		inputSpaced(sender, 60, [-500])

		expect(sent).toEqual([['hwc_60', -500]])
	})

	test('with every axis disabled the sender does no work: nothing is sent, nothing is queued and no timer is started', () => {
		const { sender, sent } = setup({
			axes: [speedAxis(60), speedAxis(61)],
			tuning: tuning({ 60: { enabled: false }, 61: { enabled: false } }),
		})

		for (let v = -500; v <= 500; v += 10) {
			sender.input(60, v)
			sender.input(61, -v)
		}
		sender.rest()

		expect(sent).toEqual([])
		expect(vi.getTimerCount()).toBe(0)
	})
})
