/**
 * Replays what a real SK_PTZEXTREMEV2 sent (fixtures/ptz-extreme-capture-*.log, captured
 * 2026-10-14) through the fake panel and checks what reaches Companion.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { Harness } from './helpers/harness.js'
import { waitFor, waitForQuiet } from './helpers/timing.js'
import type { ContextCall } from './helpers/fake-context.js'
import { ptzExtremeTopology } from './fixtures/topologies.js'
import { captureLogs } from './helpers/logs.js'

let harness: Harness | undefined
const logs = captureLogs()

afterEach(async () => {
	await harness?.stop()
	harness = undefined
})

/** The lines the panel sent after its `list` reply: input events and `map=` lines. */
function captured(name: string): string[] {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'latin1')
		.split('\n')
		.filter((l) => l !== '' && !l.startsWith('#'))
		.map((l) => l.split('\t')[1])
		.filter((l) => !l.startsWith('_'))
}

const keyCalls = (calls: ContextCall[]) => calls.filter((c) => c[0] !== 'variable')

/** The last value sent to Companion for each analog variable. */
function lastVariables(calls: ContextCall[]): Record<string, unknown> {
	return Object.fromEntries(calls.filter((c) => c[0] === 'variable').map((c) => [c[1], c[2]]))
}

/** The last `Speed` value in `lines` for each HWC, as variable ids. */
function lastSpeeds(lines: string[]): Record<string, number> {
	const result: Record<string, number> = {}
	for (const line of lines) {
		const m = /^HWC#(\d+)=Speed:(-?\d+)$/.exec(line)
		if (m) result[`hwc_${m[1]}`] = Number(m[2])
	}
	return result
}

/**
 * Open the surface, send `lines` from the panel, and wait until Companion has every expected key
 * call and each analog variable's expected last value, then until no call arrives for three send
 * intervals. Nothing more can arrive after that: keys go to Companion as each line arrives, so all
 * lines have been read once the last key call is in, and an axis sends only on change, at most once
 * per send interval, so once a value has been pending for three intervals none is left to send.
 */
async function replay(lines: string[], lastValues: Record<string, unknown>): Promise<ContextCall[]> {
	harness = new Harness({ topology: ptzExtremeTopology })
	const { context, result } = await harness.connectAndOpen()
	// The capture arrives in one burst, without its real timing, so presses of one four-way button
	// would fall within the release debounce and merge. The debounce is tested in button-keys.spec.ts.
	await result.surface.updateConfig!({ fourWayReleaseDebounce: 0 })

	harness.panel.send(...lines)
	const keys = expectedCalls(lines).length
	await waitFor(
		() =>
			keyCalls(context.calls).length >= keys &&
			Object.entries(lastValues).every(([id, value]) => lastVariables(context.calls)[id] === value),
		4000,
		'the replay to reach Companion',
	)
	await waitForQuiet(() => context.calls.length, 150, 2000, 'the replay to finish')
	return context.calls
}

/**
 * The expected Companion call for each event line, by the slice 1 rules: an edge or plain
 * Down/Up is a key down/up (no capture has two edges of one button held at once), `Enc` is a
 * signed rotate, `Press` a key press. Analog `Speed` sets a variable (checked separately: the replay
 * arrives in one burst, so it is coalesced).
 */
function expectedCalls(lines: string[]): ContextCall[] {
	const calls: ContextCall[] = []
	for (const line of lines) {
		const m = /^HWC#(\d+)(?:\.\d+)?=(Down|Up|Press|Enc|Speed)(?::(-?\d+))?$/.exec(line)
		if (!m) continue
		const id = `hwc/${m[1]}`
		if (m[2] === 'Down') calls.push(['keyDown', id])
		else if (m[2] === 'Up') calls.push(['keyUp', id])
		else if (m[2] === 'Press') calls.push(['keyDownUp', id])
		else if (m[2] === 'Enc') calls.push(['rotate', id, Number(m[3])])
	}
	return calls
}

const count = (calls: ContextCall[], kind: ContextCall[0], id: string) =>
	calls.filter((c) => c[0] === kind && c[1] === id).length

describe('replaying real panel sessions', () => {
	test('buttons, four-way edges, encoder turns and pushes, zoom rocker', async () => {
		const lines = captured('ptz-extreme-capture-buttons.log')

		const lastValues = { hwc_60: 0, hwc_61: 0, hwc_62: 0, ...lastSpeeds(lines) }

		const calls = await replay(lines, lastValues)

		expect(keyCalls(calls)).toEqual(expectedCalls(lines))
		// The zoom rocker's last value reaches Companion (this capture ends mid-push, at -500)
		expect(lastVariables(calls)).toEqual(lastValues)
		expect(lastVariables(calls).hwc_58).toBe(-500)
		// Spot checks against the capture, independent of the mapping above
		expect(count(calls, 'rotate', 'hwc/59')).toBe(93)
		expect(count(calls, 'rotate', 'hwc/57')).toBe(27)
		expect(count(calls, 'rotate', 'hwc/46')).toBe(21)
		expect(count(calls, 'keyDownUp', 'hwc/46')).toBe(1)
		expect(count(calls, 'keyDownUp', 'hwc/57')).toBe(2)
		expect(count(calls, 'keyDown', 'hwc/13')).toBe(5)
		expect(count(calls, 'keyUp', 'hwc/13')).toBe(5)
		// Every line was understood: none logged as unknown
		expect(logs.filter((l) => l.message.startsWith('Ignoring line'))).toEqual([])
	}, 10_000)

	test('joystick: each axis ends on its last value, coalesced; the top button and A10-A12 are keys', async () => {
		const lines = captured('ptz-extreme-capture-joystick.log')
		expect(lines.filter((l) => /^HWC#6[012]=Speed:/.test(l))).toHaveLength(168)

		const lastValues = { hwc_58: 0, hwc_60: 0, hwc_61: 0, hwc_62: 0 }

		const calls = await replay(lines, lastValues)

		expect(keyCalls(calls)).toEqual(expectedCalls(lines))
		// HWC 62 ends at -3, within the deadband of the 0 it started at, so Companion keeps 0
		expect(lastSpeeds(lines)).toEqual({ hwc_60: 0, hwc_61: 0, hwc_62: -3 })
		expect(lastVariables(calls)).toEqual(lastValues)
		// 168 axis events in one burst: coalesced to a few sends per axis
		expect(calls.filter((c) => c[0] === 'variable').length).toBeLessThan(20)
		expect(keyCalls(calls).slice(0, 2)).toEqual([
			['keyDown', 'hwc/63'],
			['keyUp', 'hwc/63'],
		])
		expect(count(calls, 'keyDown', 'hwc/63')).toBe(2)
		expect(count(calls, 'keyUp', 'hwc/63')).toBe(2)
		expect(logs.filter((l) => l.message.startsWith('Ignoring line'))).toEqual([])
	}, 10_000)
})
