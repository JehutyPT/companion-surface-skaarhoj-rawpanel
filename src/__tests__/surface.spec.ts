import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { validateSurfaceLayout, type LoggingSink, type SurfaceInstance } from '@companion-surface/base'
import { Harness } from './helpers/harness.js'
import { sleep, waitFor } from './helpers/fake-panel.js'
import type { FakeSurfaceContext } from './helpers/fake-context.js'
import { ptzExtremeLayoutHwcs, ptzExtremeTopology, smallTopology } from './fixtures/topologies.js'

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

const signal = new AbortController().signal

/** Connect to a fake panel with `topology`, open the surface and wait for its initial push. */
async function openSurface(topology: unknown) {
	harness = new Harness({ topology })
	await harness.start()
	await harness.connect()
	const opened = await harness.open(await harness.waitForAnnouncements())
	const panel = harness.panel
	await waitFor(() => panel.commands.length > 0)
	await sleep(30)
	return { ...opened, panel: harness.panel }
}

/** Render a layout as rows of right-aligned HWC numbers, `.` for an empty cell. */
function asciiGrid(controls: Record<string, { row: number; column: number }>): string {
	const cells = Object.entries(controls).map(([id, c]) => ({ hwc: id.replace('hwc/', ''), ...c }))
	const rows = Math.max(...cells.map((c) => c.row)) + 1
	const columns = Math.max(...cells.map((c) => c.column)) + 1
	const grid = Array.from({ length: rows }, () => Array<string>(columns).fill('.'))
	for (const c of cells) grid[c.row][c.column] = c.hwc
	return grid.map((r) => r.map((cell) => cell.padStart(3)).join('')).join('\n')
}

/** Draw, then wait for the queue to flush and return what reached the panel. */
async function drawAndCollect(surface: SurfaceInstance, ...draws: Parameters<SurfaceInstance['draw']>[1][]) {
	harness!.panel.clearReceived()
	for (const props of draws) await surface.draw(signal, props)
	await sleep(40)
	return harness!.panel.commands
}

describe('layout from topology', () => {
	test('the PTZ Extreme layout is valid and has every button and encoder, but no analog control or placeholder', async () => {
		const { result } = await openSurface(ptzExtremeTopology)
		const layout = result.registerProps.surfaceLayout

		validateSurfaceLayout(layout)
		expect(Object.keys(layout.controls).sort()).toEqual(ptzExtremeLayoutHwcs.map((n) => `hwc/${n}`).sort())
		// Analog controls are transfer variables instead (analog.spec.ts)
		expect(result.registerProps.transferVariables?.map((v) => v.id)).toEqual(['hwc_58', 'hwc_60', 'hwc_61', 'hwc_62'])
	})

	test('style presets follow what each control can show: LED colour, display text, both or neither', async () => {
		const { result } = await openSurface(ptzExtremeTopology)
		const layout = result.registerProps.surfaceLayout
		const preset = (id: number) => layout.stylePresets[layout.controls[`hwc/${id}`].stylePreset ?? 'default']

		// Four-way buttons and Knob A-H have an RGB LED and a display
		expect(preset(1)).toEqual({ colors: 'hex', text: true })
		expect(preset(54)).toEqual({ colors: 'hex', text: true })
		expect(preset(46)).toEqual({ colors: 'hex', text: true })
		// Iris, Focus and the joystick top button have neither
		expect(preset(57)).toEqual({})
		expect(preset(59)).toEqual({})
		expect(preset(63)).toEqual({})
	})

	test('an LED-only control uses the default preset, a display-only control gets text without colour', async () => {
		const { result } = await openSurface({
			HWc: [
				{ id: 1, x: 100, y: 100, txt: 'LED', type: 1 },
				{ id: 2, x: 300, y: 100, txt: 'Display', type: 2 },
			],
			typeIndex: {
				'1': { w: 100, h: 100, in: 'b', out: 'rgb' },
				'2': { w: 100, h: 100, in: 'b', disp: { w: 64, h: 32, subidx: 0 } },
			},
		})
		const layout = result.registerProps.surfaceLayout

		expect(layout.stylePresets.default).toEqual({ colors: 'hex' })
		expect(layout.controls['hwc/1'].stylePreset).toBeUndefined()
		expect(layout.stylePresets[layout.controls['hwc/2'].stylePreset!]).toEqual({ text: true })
	})

	test('controls with neither an LED nor a display get no commands, on connect or on draw', async () => {
		const { result, panel } = await openSurface(ptzExtremeTopology)

		expect(panel.commands.filter((l) => /^HWCc?#(57|59|63)=/.test(l))).toEqual([])
		const sent = await drawAndCollect(result.surface, {
			controlId: 'hwc/57',
			color: '#ff0000',
			text: 'Iris',
			pressed: true,
		})
		expect(sent).toEqual([])
	})

	test('rows and columns mirror physical positions, merging nearby coordinates', async () => {
		const { result } = await openSurface(smallTopology)
		const controls = result.registerProps.surfaceLayout.controls
		const grid = Object.fromEntries(Object.entries(controls).map(([id, c]) => [id, [c.row, c.column]]))

		expect(grid).toEqual({
			'hwc/1': [0, 0],
			'hwc/2': [0, 1],
			'hwc/3': [0, 2],
			'hwc/10': [0, 3],
			'hwc/4': [1, 0],
			'hwc/5': [1, 1],
			'hwc/6': [1, 2],
		})
	})

	test('the real PTZ Extreme topology maps to a grid that mirrors the panel', async () => {
		const { result } = await openSurface(ptzExtremeTopology)

		// Top row: A10-A12, Knob A-H, joystick top button. The knobs sit on a wider pitch than the
		// buttons, but as a run of one type they take consecutive columns. Iris (57) sits alone
		// between the A and X rows and joins the nearer X row (162 vs 177 in y); Focus (59, round,
		// no h) is close enough to share the Cam row.
		expect(asciiGrid(result.registerProps.surfaceLayout.controls)).toEqual(
			[
				' 54 55 56 46 47 48 49 50 51 52 53  .  .  .  .  . 63',
				'  .  .  .  .  . 37 38 39 40 41 42 43 44 45  .  .  .',
				'  .  .  .  . 57 13 14 15 16 17 18 19 20 21 22 23 24',
				'  .  .  . 59  .  1  2  3  4  5  6  7  8  9 10 11 12',
			].join('\n'),
		)
	})

	/** A SYNTHESISED topology of 100x100 controls: `[id, x, y, type]`, type 1 a button, 2 an encoder. */
	function gridTopology(controls: [number, number, number, number][]) {
		return {
			HWc: controls.map(([id, x, y, type]) => ({ id, x, y, txt: `C${id}`, type })),
			typeIndex: {
				'1': { w: 100, h: 100, in: 'b', out: 'rgb' },
				'2': { w: 100, h: 100, in: 'pb', out: 'rgb' },
			},
		}
	}

	test('a control alone in its row joins the nearest row, at its own column', async () => {
		const { result } = await openSurface(
			gridTopology([
				[1, 100, 100, 1],
				[2, 300, 100, 1],
				[3, 500, 100, 1],
				[4, 100, 450, 1],
				[5, 300, 450, 1],
				[6, 500, 450, 1],
				// 200 below the top row, 150 above the bottom row
				[7, 700, 300, 2],
			]),
		)

		expect(asciiGrid(result.registerProps.surfaceLayout.controls)).toEqual(['  1  2  3  .', '  4  5  6  7'].join('\n'))
	})

	test('a control joining a row on an occupied cell takes the nearest free column, left or right', async () => {
		const { result } = await openSurface(
			gridTopology([
				[1, 100, 100, 1],
				[2, 1100, 100, 2],
				[5, 300, 450, 1],
				[6, 500, 450, 1],
				[8, 700, 450, 1],
				[9, 900, 450, 1],
				// Column 2 is taken in the bottom row; column 0 (two away) is nearer than column 5 (three away)
				[7, 500, 300, 2],
			]),
		)

		expect(asciiGrid(result.registerProps.surfaceLayout.controls)).toEqual(
			['  1  .  .  .  .  2', '  7  5  6  8  9  .'].join('\n'),
		)
	})

	test('controls alone in their rows stay apart when no row has more than one control', async () => {
		const { result } = await openSurface(
			gridTopology([
				[1, 100, 100, 1],
				[2, 100, 300, 1],
				[3, 100, 500, 1],
			]),
		)

		expect(asciiGrid(result.registerProps.surfaceLayout.controls)).toEqual(['  1', '  2', '  3'].join('\n'))
	})

	test('a run of controls of one type takes consecutive columns, even on a wider pitch', async () => {
		const { result } = await openSurface(
			gridTopology([
				[1, 100, 100, 1],
				[2, 300, 100, 1],
				[3, 500, 100, 1],
				[11, 100, 300, 2],
				[12, 400, 300, 2],
				[13, 700, 300, 2],
			]),
		)

		// Columns from x are 100, 300, 400, 500, 700: the encoders at 0, 2 and 4 close up to 0, 1, 2,
		// and the buttons at 0, 1 and 3 to 0, 1, 2
		expect(asciiGrid(result.registerProps.surfaceLayout.controls)).toEqual(['  1  2  3', ' 11 12 13'].join('\n'))
	})

	test('only neighbours of the same type close up: a control of another type keeps its column and splits the run', async () => {
		const { result } = await openSurface(
			gridTopology([
				[1, 100, 100, 1],
				[2, 400, 100, 1],
				[3, 700, 100, 2],
				[4, 1000, 100, 1],
				[11, 250, 300, 1],
				[12, 550, 300, 1],
				[13, 850, 300, 1],
			]),
		)

		// Columns from x: 100, 250, 400, 550, 700, 850, 1000
		expect(asciiGrid(result.registerProps.surfaceLayout.controls)).toEqual(
			['  1  2  .  .  3  .  4', '  . 11 12 13  .  .  .'].join('\n'),
		)
	})

	test('controls with only a width are treated as round: their height is their width', async () => {
		const { result } = await openSurface({
			HWc: [
				{ id: 1, x: 100, y: 1000, txt: 'Button', type: 1 },
				{ id: 2, x: 300, y: 1000, txt: 'Button', type: 1 },
				{ id: 3, x: 500, y: 930, txt: 'Big knob', type: 2 },
				{ id: 4, x: 700, y: 1070, txt: 'Small knob', type: 3 },
				// A second small knob, so the small knobs' row is not merged as a lone control
				{ id: 5, x: 900, y: 1070, txt: 'Small knob', type: 3 },
			],
			typeIndex: {
				'1': { w: 150, h: 100, in: 'b', out: 'rgb' },
				'2': { w: 240, in: 'pb' },
				'3': { w: 100, in: 'pb' },
			},
		})

		// The big knob is 70 above the buttons, within half its 240 width: same row. The small knob
		// is 70 below, beyond half its 100 width: a row of its own.
		expect(asciiGrid(result.registerProps.surfaceLayout.controls)).toEqual(
			['  1  2  3  .  .', '  .  .  .  4  5'].join('\n'),
		)
	})

	test('a control on an occupied cell moves right to the next free column', async () => {
		const { result } = await openSurface({
			HWc: [
				{ id: 1, x: 100, y: 100, txt: 'A', type: 1 },
				{ id: 2, x: 100, y: 100, txt: 'B', type: 1 },
				{ id: 3, x: 100, y: 100, txt: 'C', type: 1 },
				{ id: 4, x: 300, y: 100, txt: 'D', type: 1 },
			],
			typeIndex: { '1': { w: 100, h: 100, in: 'b', out: 'rgb' } },
		})
		const c = result.registerProps.surfaceLayout.controls

		expect([c['hwc/1'], c['hwc/2'], c['hwc/3'], c['hwc/4']]).toEqual([
			{ row: 0, column: 0 },
			{ row: 0, column: 1 },
			{ row: 0, column: 2 },
			{ row: 0, column: 3 },
		])
	})

	test('a per-control typeOverride is applied over its type', async () => {
		const { result } = await openSurface({
			HWc: [
				{ id: 1, x: 100, y: 100, txt: 'Plain', type: 1 },
				{ id: 2, x: 300, y: 100, txt: 'Display', type: 1, typeOverride: { disp: { w: 64, h: 32, subidx: 0 } } },
				{ id: 3, x: 500, y: 100, txt: 'Now a fader', type: 1, typeOverride: { in: 'av' } },
			],
			typeIndex: { '1': { w: 100, h: 100, in: 'b', out: 'rgb' } },
		})
		const c = result.registerProps.surfaceLayout.controls

		expect(c['hwc/1'].stylePreset).toBeUndefined()
		expect(c['hwc/2'].stylePreset).toBeDefined()
		expect(c['hwc/3']).toBeUndefined()
	})

	test('a control with an unknown input type is skipped and logged once', async () => {
		const { result } = await openSurface(smallTopology)
		harness!.panel.dropClients()
		await waitFor(() => harness!.panel.connectionCount === 2 && harness!.panel.commands.length > 0)

		expect(result.registerProps.surfaceLayout.controls['hwc/12']).toBeUndefined()
		const warnings = logs.filter((l) => l.level === 'warn' && l.message.includes('HWC 12'))
		expect(warnings).toHaveLength(1)
		expect(warnings[0].message).toContain("'zz'")
	})
})

describe('drawing', () => {
	test('opening the surface turns every control off and clears every display', async () => {
		const { panel } = await openSurface(smallTopology)

		expect(panel.commands.sort()).toEqual(
			[
				'HWC#1=0',
				'HWC#2=0',
				'HWC#3=0',
				'HWC#4=0',
				'HWC#5=0',
				'HWC#6=0',
				'HWCt#6=||||||',
				'HWC#10=0',
				'HWCt#10=||||||',
			].sort(),
		)
	})

	test('a colour lights the LED in the nearest of the 64 panel colours', async () => {
		const { result } = await openSurface(smallTopology)

		const sent = await drawAndCollect(result.surface, { controlId: 'hwc/1', color: '#ff8000', pressed: false })

		// r=3, g=2, b=0: 192 + (3<<4 | 2<<2 | 0) = 248
		expect(sent).toEqual(['HWCc#1=248', 'HWC#1=4'])
	})

	test('black turns the LED off', async () => {
		const { result } = await openSurface(smallTopology)
		await drawAndCollect(result.surface, { controlId: 'hwc/1', color: '#00ff00', pressed: false })

		const sent = await drawAndCollect(result.surface, { controlId: 'hwc/1', color: '#000000', pressed: false })

		expect(sent).toEqual(['HWC#1=0'])
	})

	test('pressed shows a lit button dimmed and an unlit button white', async () => {
		const { result } = await openSurface(smallTopology)

		const sent = await drawAndCollect(
			result.surface,
			{ controlId: 'hwc/1', color: '#ff0000', pressed: true },
			{ controlId: 'hwc/2', color: '#000000', pressed: true },
		)

		expect(sent).toEqual(['HWCc#1=240', 'HWC#1=5', 'HWCc#2=130', 'HWC#2=4'])
	})

	test('one line of text is shown as one big line', async () => {
		const { result } = await openSurface(smallTopology)

		const sent = await drawAndCollect(result.surface, { controlId: 'hwc/10', text: 'CAM 1', pressed: false })

		expect(sent).toEqual(['HWCt#10=1|10||CAM 1'])
	})

	test('two lines of text are shown as two lines; further lines are dropped', async () => {
		const { result } = await openSurface(smallTopology)

		const sent = await drawAndCollect(result.surface, {
			controlId: 'hwc/10',
			text: 'Line one\nLine two\nLine three',
			pressed: false,
		})

		expect(sent).toEqual(['HWCt#10=1|11|||1|Line one|Line two'])
	})

	test('escaped line breaks and tabs in text are read the way Companion renders them', async () => {
		const { result } = await openSurface(smallTopology)

		const drawText = async (text: string) =>
			drawAndCollect(result.surface, { controlId: 'hwc/10', text, pressed: false })

		expect(await drawText('Line one\\nLine two')).toEqual(['HWCt#10=1|11|||1|Line one|Line two'])
		expect(await drawText('Up\\rDown')).toEqual(['HWCt#10=1|11|||1|Up|Down'])
		expect(await drawText('CAM\\t1')).toEqual(['HWCt#10=1|10||CAM 1'])
		expect(await drawText('Real\r\nbreak')).toEqual(['HWCt#10=1|11|||1|Real|break'])
	})

	test('text is cleaned of pipes and non-ASCII, and long text is cut to fit the panel', async () => {
		const { result } = await openSurface(smallTopology)

		const sent = await drawAndCollect(
			result.surface,
			{ controlId: 'hwc/6', text: 'Câm | 1 ✓', pressed: false },
			{ controlId: 'hwc/10', text: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz', pressed: false },
		)

		expect(sent[0]).toBe('HWCt#6=1|10||Cm  1')
		expect(sent[1]).toBe('HWCt#10=1|11|||1|ABCDEFGHIJKLMNOPQRSTUVWX|abcdefghijklmnopqrstu')
		expect(sent[1].length).toBe(63)
	})

	test('text is ignored on a control without a display', async () => {
		const { result } = await openSurface(smallTopology)

		const sent = await drawAndCollect(result.surface, { controlId: 'hwc/1', text: 'Hello', pressed: false })

		expect(sent).toEqual([])
	})

	test('blank turns lit controls off and clears displays that show text', async () => {
		const { result } = await openSurface(smallTopology)
		await drawAndCollect(
			result.surface,
			{ controlId: 'hwc/1', color: '#ff0000', pressed: false },
			{ controlId: 'hwc/10', color: '#0000ff', text: 'Hi', pressed: false },
		)
		harness!.panel.clearReceived()

		await result.surface.blank()
		await sleep(40)

		expect(harness!.panel.commands.sort()).toEqual(['HWC#1=0', 'HWC#10=0', 'HWCt#10=||||||'].sort())
	})

	test('waking from sleep re-sends every control', async () => {
		const { result, panel } = await openSurface(smallTopology)
		await drawAndCollect(result.surface, { controlId: 'hwc/1', color: '#ff0000', pressed: false })
		panel.clearReceived()

		panel.send('_isSleeping=1', '_isSleeping=0')
		await sleep(40)

		expect(panel.commands).toContain('HWCc#1=240')
		expect(panel.commands).toContain('HWC#1=4')
		expect(panel.commands).toContain('HWC#2=0')
		expect(panel.commands).toContain('HWCt#10=||||||')
	})
})

describe('input', () => {
	async function openWithInput(topology: unknown = smallTopology) {
		const opened = await openSurface(topology)
		const send = async (...lines: string[]) => {
			opened.panel.send(...lines)
			await sleep(30)
		}
		return { ...opened, send }
	}

	const keyCalls = (context: FakeSurfaceContext) => context.calls.filter((c) => c[0] !== 'disconnect')

	test('a button press and release become key down and key up', async () => {
		const { context, send } = await openWithInput()

		await send('HWC#1=Down', 'HWC#1=Up')

		expect(keyCalls(context)).toEqual([
			['keyDown', 'hwc/1'],
			['keyUp', 'hwc/1'],
		])
	})

	test('a four-way button is one key: down on the first edge, up when the last edge lifts', async () => {
		const { context, send } = await openWithInput()

		await send('HWC#6.1=Down', 'HWC#6.8=Down', 'HWC#6.1=Up')
		expect(keyCalls(context)).toEqual([['keyDown', 'hwc/6']])

		await send('HWC#6.8=Up')
		expect(keyCalls(context)).toEqual([
			['keyDown', 'hwc/6'],
			['keyUp', 'hwc/6'],
		])
	})

	test('a release with no press (lost while the panel woke) is ignored', async () => {
		const { context, send } = await openWithInput()

		await send('HWC#6.2=Up', 'HWC#1=Up')

		expect(keyCalls(context)).toEqual([])
	})

	test('encoder turns rotate by the signed step count', async () => {
		const { context, send } = await openWithInput()

		await send('HWC#10=Enc:1', 'HWC#10=Enc:-3')

		expect(keyCalls(context)).toEqual([
			['rotate', 'hwc/10', 1],
			['rotate', 'hwc/10', -3],
		])
	})

	test('an encoder push is a key press, in both the Press and the Down/Up form', async () => {
		const { context, send } = await openWithInput()

		await send('HWC#10=Press', 'HWC#10=Down', 'HWC#10=Up')

		expect(keyCalls(context)).toEqual([
			['keyDownUp', 'hwc/10'],
			['keyDown', 'hwc/10'],
			['keyUp', 'hwc/10'],
		])
	})

	test('while locked, keys still reach Companion but rotation is ignored', async () => {
		const { context, send } = await openWithInput()
		context.locked = true

		await send('HWC#10=Enc:1', 'HWC#1=Down', 'HWC#1=Up')

		expect(keyCalls(context)).toEqual([
			['keyDown', 'hwc/1'],
			['keyUp', 'hwc/1'],
		])
	})

	test('unknown controls and unknown lines are ignored; analog controls only set their variable', async () => {
		const { context, send } = await openWithInput()

		await send('HWC#11=Abs:500', 'HWC#12=Down', 'HWC#99=Down', 'nack', 'map=1:1', 'HWC#1=Sideways')

		expect(context.calls).toEqual([['variable', 'hwc_11', 500]])
	})

	test('keys held when the link drops are released', async () => {
		const { context, send, panel } = await openWithInput()
		await send('HWC#1=Down', 'HWC#6.4=Down')

		panel.dropClients()
		await waitFor(() => context.calls.length >= 4, 2000, 'key ups')

		expect(context.calls.slice(2).sort()).toEqual([
			['keyUp', 'hwc/1'],
			['keyUp', 'hwc/6'],
		])
	})

	test('input before the surface is initialised is not sent to Companion', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect()
		const info = await harness.waitForAnnouncements()
		const { FakeSurfaceContext } = await import('./helpers/fake-context.js')
		const context = new FakeSurfaceContext()
		const result = await harness.plugin.openSurface(info.surfaceId, info.pluginInfo, context)

		harness.panel.send('HWC#1=Down')
		await sleep(30)
		expect(context.calls).toEqual([])
		await result.surface.close()
	})
})

describe('closing', () => {
	test('close can be called twice', async () => {
		const { result } = await openSurface(smallTopology)

		await result.surface.close()
		await result.surface.close()
	})
})
