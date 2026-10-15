/**
 * The custom control map: a remote connection setting that moves listed controls to a chosen
 * row and column, leaving the rest where the topology puts them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { validateSurfaceLayout, type LoggingSink } from '@companion-surface/base'
import { Harness } from './helpers/harness.js'
import { sleep } from './helpers/fake-panel.js'
import { smallTopology } from './fixtures/topologies.js'
import { cellsOf, layoutOf } from './helpers/layout.js'
import { formatControlMap, parseControlMap } from '../control-map.js'
import { createRawPanelPlugin } from '../main.js'

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

const warnings = () => logs.filter((l) => l.level === 'warn').map((l) => l.message)

/** Lay out smallTopology with `controlMap`; returns the layout as `hwc: [row, column]` and its notes. */
function layoutWithMap(controlMap: string) {
	const layout = layoutOf(smallTopology, parseControlMap(controlMap).map)
	return { grid: cellsOf(layout), notes: layout.mapNotes }
}

/** Connect with `controlMap`, open the surface and return its layout as `hwc: [row, column]`. */
async function openWithMap(controlMap: string) {
	harness = new Harness({ topology: smallTopology })
	await harness.start()
	await harness.connect('conn1', { controlMap })
	const { result } = await harness.open(await harness.waitForAnnouncements())
	const layout = result.registerProps.surfaceLayout
	validateSurfaceLayout(layout)
	return Object.fromEntries(
		Object.entries(layout.controls).map(([id, c]) => [Number(id.replace('hwc/', '')), [c.row, c.column]]),
	)
}

/** smallTopology's automatic layout: B1 B2 B3 Enc on row 0, B4 B5 FW on row 1. */
const AUTOMATIC = { 1: [0, 0], 2: [0, 1], 3: [0, 2], 10: [0, 3], 4: [1, 0], 5: [1, 1], 6: [1, 2] }

describe('parsing the control map', () => {
	test('reads hwc=row/column entries', () => {
		const { map, warnings } = parseControlMap('37=1/5, 38=1/6')
		expect([...map]).toEqual([
			[37, { row: 1, column: 5 }],
			[38, { row: 1, column: 6 }],
		])
		expect(warnings).toEqual([])
	})

	test('accepts commas, semicolons and newlines as separators, and tolerates whitespace', () => {
		const { map, warnings } = parseControlMap(' 1 = 0 / 2 ;2=3/4\n3= 5/ 6 ,, ;\n')
		expect([...map]).toEqual([
			[1, { row: 0, column: 2 }],
			[2, { row: 3, column: 4 }],
			[3, { row: 5, column: 6 }],
		])
		expect(warnings).toEqual([])
	})

	test('an empty or blank map has no entries', () => {
		expect(parseControlMap('').map.size).toBe(0)
		expect(parseControlMap('  \n ').map.size).toBe(0)
		expect(parseControlMap(undefined).map.size).toBe(0)
	})

	test('skips malformed entries with a warning each, and keeps the rest', () => {
		const { map, warnings } = parseControlMap('1=0/1, x=1/2, 2=1, 3=-1/0, 4=1.5/2, 0=1/1, 5=2/3, 6=1/2/3')
		expect([...map]).toEqual([
			[1, { row: 0, column: 1 }],
			[5, { row: 2, column: 3 }],
		])
		expect(warnings).toHaveLength(6)
		expect(warnings[0]).toContain('x=1/2')
	})

	test('a control listed twice keeps its first entry, with a warning', () => {
		const { map, warnings } = parseControlMap('1=0/1, 1=2/2')
		expect([...map]).toEqual([[1, { row: 0, column: 1 }]])
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toMatch(/HWC 1/)
	})

	test('formats a map the same whatever the whitespace and separators, keeping entry order', () => {
		const a = formatControlMap(parseControlMap('38=1/6, 37=1/5').map)
		const b = formatControlMap(parseControlMap(' 38 = 1/6 ;\n37=1/5').map)
		expect(a).toBe('38=1/6,37=1/5')
		expect(b).toBe(a)
		expect(formatControlMap(parseControlMap('').map)).toBe('')
	})
})

describe('applying the control map', () => {
	test('the plugin offers the map as a remote connection setting, empty by default', () => {
		const field = createRawPanelPlugin().remote!.configFields.find((f) => f.id === 'controlMap')
		expect(field).toMatchObject({ type: 'textinput', default: '' })
	})

	test('an empty map leaves the automatic layout unchanged', () => {
		expect(layoutWithMap('')).toEqual({ grid: AUTOMATIC, notes: [] })
	})

	test('listed controls move to their row and column; the rest keep their automatic position', () => {
		expect(layoutWithMap('10=2/0, 6=1/5').grid).toEqual({ ...AUTOMATIC, 10: [2, 0], 6: [1, 5] })
	})

	test('an automatic control on a mapped cell moves right, pushing the controls after it along', () => {
		// B5 takes B1's cell: B1, B2, B3 and Enc each move one column right
		const { grid, notes } = layoutWithMap('5=0/0')
		expect(grid).toEqual({ ...AUTOMATIC, 5: [0, 0], 1: [0, 1], 2: [0, 2], 3: [0, 3], 10: [0, 4] })
		expect(notes.some((w) => /HWC 1/.test(w) && /0\/1/.test(w))).toBe(true)
	})

	test('a gap stops the push: controls past a free cell stay put', () => {
		// B2 leaves row 0; B5 takes B1's cell, so B1 moves into B2's old cell and B3 and Enc stay
		expect(layoutWithMap('5=0/0, 2=2/0').grid).toEqual({ ...AUTOMATIC, 5: [0, 0], 2: [2, 0], 1: [0, 1] })
	})

	test('two entries for one cell: the first wins, the later one is ignored with a warning', () => {
		const { grid, notes } = layoutWithMap('1=3/3, 2=3/3')
		expect(grid).toEqual({ ...AUTOMATIC, 1: [3, 3] })
		expect(notes.some((w) => /HWC 2/.test(w))).toBe(true)
	})

	test('entries for analog, input-less, unknown or absent controls are ignored with a warning', () => {
		// 11 is a fader (a transfer variable), 12 an unknown type, 20 a label, 99 not on the panel
		const { grid, notes } = layoutWithMap('11=3/0, 12=3/1, 20=3/2, 99=3/3')
		expect(grid).toEqual(AUTOMATIC)
		for (const hwc of [11, 12, 20, 99]) expect(notes.some((w) => w.includes(`HWC ${hwc}`))).toBe(true)
	})

	test('control positions from the connection settings shape the surface, and what they moved or ignored is logged as a warning', async () => {
		expect(await openWithMap('5=0/0, 99=3/3')).toEqual({
			...AUTOMATIC,
			5: [0, 0],
			1: [0, 1],
			2: [0, 2],
			3: [0, 3],
			10: [0, 4],
		})
		expect(warnings().some((w) => /HWC 1/.test(w) && /0\/1/.test(w))).toBe(true)
		expect(warnings().some((w) => w.includes('HWC 99'))).toBe(true)
	})
})

describe('changing the control map', () => {
	test('saving a new map replaces the surface with the new layout', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect('conn1')
		const first = await harness.waitForAnnouncements()
		const { result, context } = await harness.open(first)
		context.onDisconnect = () => void result.surface.close()

		await harness.connect('conn1', { controlMap: '10=2/0' })

		expect(context.calls.some((c) => c[0] === 'disconnect')).toBe(true)
		const second = await harness.waitForAnnouncements(2)
		expect(second.surfaceId).toBe(first.surfaceId)
		expect(second.deviceHandle).not.toBe(first.deviceHandle)
		const reopened = await harness.open(second)
		expect(reopened.result.registerProps.surfaceLayout.controls['hwc/10']).toMatchObject({ row: 2, column: 0 })
	})

	test('re-saving the same map with different whitespace or separators does not reconnect', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect('conn1', { controlMap: '10=2/0, 6=1/5' })
		await harness.waitForAnnouncements()

		await harness.connect('conn1', { controlMap: ' 10 = 2/0 ;6=1/5 ' })
		await sleep(50)

		expect(harness.panel.connectionCount).toBe(1)
		expect(harness.announced).toHaveLength(1)
	})
})
