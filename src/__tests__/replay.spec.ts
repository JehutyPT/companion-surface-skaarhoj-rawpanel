/**
 * Replays what a real SK_PTZEXTREMEV2 sent (fixtures/ptz-extreme-capture-*.log, captured
 * 2026-10-14) through the fake panel and checks what reaches Companion.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { LoggingSink } from '@companion-surface/base'
import { Harness } from './helpers/harness.js'
import { sleep, waitFor } from './helpers/fake-panel.js'
import type { ContextCall } from './helpers/fake-context.js'
import { ptzExtremeTopology } from './fixtures/topologies.js'

let harness: Harness | undefined
let logs: { level: string; message: string }[] = []

beforeEach(() => {
	logs = []
	const sink: LoggingSink = (_source, level, message) => logs.push({ level, message })
	globalThis.SURFACE_LOGGER = sink
})

afterEach(async () => {
	await harness?.stop()
	harness = undefined
	globalThis.SURFACE_LOGGER = undefined
})

/** The lines the panel sent after its `list` reply: input events and `map=` lines. */
function captured(name: string): string[] {
	return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'latin1')
		.split('\n')
		.filter((l) => l !== '' && !l.startsWith('#'))
		.map((l) => l.split('\t')[1])
		.filter((l) => !l.startsWith('_'))
}

async function replay(lines: string[]): Promise<ContextCall[]> {
	harness = new Harness({ topology: ptzExtremeTopology })
	await harness.start()
	await harness.connect()
	const { context } = await harness.open(await harness.waitForAnnouncements())
	await waitFor(() => harness!.panel.commands.length > 0)

	harness.panel.send(...lines)
	await sleep(100)
	return context.calls
}

/**
 * The expected Companion call for each event line, by the slice 1 rules: an edge or plain
 * Down/Up is a key down/up (no capture has two edges of one button held at once), `Enc` is a
 * signed rotate, `Press` a key press, and analog `Speed` is not a Companion call yet.
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

		const calls = await replay(lines)

		expect(calls).toEqual(expectedCalls(lines))
		// Spot checks against the capture, independent of the mapping above
		expect(count(calls, 'rotate', 'hwc/59')).toBe(93)
		expect(count(calls, 'rotate', 'hwc/57')).toBe(27)
		expect(count(calls, 'rotate', 'hwc/46')).toBe(21)
		expect(count(calls, 'keyDownUp', 'hwc/46')).toBe(1)
		expect(count(calls, 'keyDownUp', 'hwc/57')).toBe(2)
		expect(count(calls, 'keyDown', 'hwc/13')).toBe(5)
		expect(count(calls, 'keyUp', 'hwc/13')).toBe(5)
		expect(calls.some((c) => c[1] === 'hwc/58')).toBe(false)
		// Every line was understood: none logged as unknown
		expect(logs.filter((l) => l.message.startsWith('Ignoring line'))).toEqual([])
	})

	test('joystick: axes are ignored, the top button and the A10-A12 four-way buttons are keys', async () => {
		const lines = captured('ptz-extreme-capture-joystick.log')
		expect(lines.filter((l) => /^HWC#6[012]=Speed:/.test(l))).toHaveLength(168)

		const calls = await replay(lines)

		expect(calls).toEqual(expectedCalls(lines))
		expect(calls.slice(0, 2)).toEqual([
			['keyDown', 'hwc/63'],
			['keyUp', 'hwc/63'],
		])
		expect(count(calls, 'keyDown', 'hwc/63')).toBe(2)
		expect(count(calls, 'keyUp', 'hwc/63')).toBe(2)
		expect(calls.some((c) => ['hwc/60', 'hwc/61', 'hwc/62'].includes(c[1] as string))).toBe(false)
		expect(logs.filter((l) => l.message.startsWith('Ignoring line'))).toEqual([])
	})
})
