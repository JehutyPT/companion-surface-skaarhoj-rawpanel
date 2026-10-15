/**
 * The layout rules, tested through `parseTopology` and `buildLayout` directly: positions from
 * physical coordinates, row joining, runs of one type, control kinds from the topology `in` type
 * and analog axes kept out of the layout. surface.spec.ts checks the layout reaches Companion.
 */
import { describe, expect, test } from 'vitest'
import { parseTopology } from '../topology.js'
import { asciiGrid, cellsOf, layoutOf } from './helpers/layout.js'
import { ptzExtremeLayoutHwcs, ptzExtremeTopology, smallTopology } from './fixtures/topologies.js'

describe('parsing the topology', () => {
	test('classifies each control by its topology in type', () => {
		const kinds = Object.fromEntries(
			parseTopology(JSON.stringify(smallTopology)).controls.map((c) => [c.hwc, [c.kind, c.input]]),
		)

		expect(kinds).toEqual({
			1: ['button', 'b'],
			2: ['button', 'b'],
			3: ['button', 'b'],
			4: ['button', 'b'],
			5: ['button', 'b'],
			6: ['button', 'b4'],
			10: ['encoder-push', 'pb'],
			11: ['analog', 'av'],
			12: ['unknown', 'zz'],
			20: ['none', ''],
			21: ['none', ''],
		})
	})

	test('a per-control typeOverride is applied over its type, and makes it a type of its own', () => {
		const { controls } = parseTopology(
			JSON.stringify({
				HWc: [
					{ id: 1, x: 100, y: 100, txt: 'Plain', type: 1 },
					{ id: 2, x: 300, y: 100, txt: 'Fader', type: 1, typeOverride: { in: 'av' } },
				],
				typeIndex: { '1': { w: 100, h: 100, in: 'b', out: 'rgb' } },
			}),
		)

		expect(controls.map((c) => c.kind)).toEqual(['button', 'analog'])
		expect(controls[1].output).toBe('rgb')
		expect(controls[0].typeKey).not.toBe(controls[1].typeKey)
	})

	test.each([
		['is not JSON', '{"HWc": [ not json', /not valid JSON/],
		['has no HWc list', '{"typeIndex": {}}', /no HWc list/],
		['has an empty HWc list', JSON.stringify({ HWc: [], typeIndex: {} }), /no buttons or encoders/],
		[
			'has only analog, unknown and input-less controls',
			JSON.stringify({
				HWc: [
					{ id: 1, x: 100, y: 100, txt: 'Fader', type: 1 },
					{ id: 2, x: 300, y: 100, txt: 'Mystery', type: 2 },
					{ id: 3, x: 500, y: 100, txt: 'Label', type: 3 },
					{ id: 4, x: 700, y: 100, txt: 'Disabled', type: 0 },
				],
				typeIndex: { '1': { w: 100, h: 600, in: 'av' }, '2': { w: 100, in: 'zz' }, '3': { w: 400, h: 60 } },
			}),
			/no buttons or encoders/,
		],
	])('a topology that %s is rejected', (_name, json, error) => {
		expect(() => parseTopology(json)).toThrow(error)
	})
})

describe('layout from topology', () => {
	test('the PTZ Extreme layout is valid and has every button and encoder, but no analog control or placeholder', () => {
		const layout = layoutOf(ptzExtremeTopology)

		expect(Object.keys(layout.surfaceLayout.controls).sort()).toEqual(
			ptzExtremeLayoutHwcs.map((n) => `hwc/${n}`).sort(),
		)
		// Analog controls are axes instead, sent as transfer variables (analog.spec.ts)
		expect(layout.axes.map((a) => a.variableId)).toEqual(['hwc_58', 'hwc_60', 'hwc_61', 'hwc_62'])
	})

	test('analog controls are axes, not layout controls; unknown and input-less controls are skipped', () => {
		const layout = layoutOf(smallTopology)
		const controls = layout.surfaceLayout.controls

		for (const hwc of [11, 12, 20, 21]) expect(controls[`hwc/${hwc}`]).toBeUndefined()
		expect(layout.axes).toEqual([
			{
				hwc: 11,
				variableId: 'hwc_11',
				name: 'Fader (HWC 11)',
				suggestedVariable: 'skaarhoj_fader',
				mode: 'Abs',
			},
		])
	})

	test('style presets follow what each control can show: LED colour, display text, both or neither', () => {
		const layout = layoutOf(ptzExtremeTopology).surfaceLayout
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

	test('an LED-only control uses the default preset, a display-only control gets text without colour', () => {
		const layout = layoutOf({
			HWc: [
				{ id: 1, x: 100, y: 100, txt: 'LED', type: 1 },
				{ id: 2, x: 300, y: 100, txt: 'Display', type: 2 },
			],
			typeIndex: {
				'1': { w: 100, h: 100, in: 'b', out: 'rgb' },
				'2': { w: 100, h: 100, in: 'b', disp: { w: 64, h: 32, subidx: 0 } },
			},
		}).surfaceLayout

		expect(layout.stylePresets.default).toEqual({ colors: 'hex' })
		expect(layout.controls['hwc/1'].stylePreset).toBeUndefined()
		expect(layout.stylePresets[layout.controls['hwc/2'].stylePreset!]).toEqual({ text: true })
	})

	test('rows and columns mirror physical positions, merging nearby coordinates', () => {
		expect(cellsOf(layoutOf(smallTopology))).toEqual({
			1: [0, 0],
			2: [0, 1],
			3: [0, 2],
			10: [0, 3],
			4: [1, 0],
			5: [1, 1],
			6: [1, 2],
		})
	})

	test('the real PTZ Extreme topology maps to a grid that mirrors the panel', () => {
		// Top row: A10-A12, Knob A-H, joystick top button. The knobs sit on a wider pitch than the
		// buttons, but as a run of one type they take consecutive columns. Iris (57) sits alone
		// between the A and X rows and joins the nearer X row (162 vs 177 in y); Focus (59, round,
		// no h) is close enough to share the Cam row.
		expect(asciiGrid(layoutOf(ptzExtremeTopology).surfaceLayout.controls)).toEqual(
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

	const gridOf = (topology: unknown) => asciiGrid(layoutOf(topology).surfaceLayout.controls)

	test('a control alone in its row joins the nearest row, at its own column', () => {
		const grid = gridOf(
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

		expect(grid).toEqual(['  1  2  3  .', '  4  5  6  7'].join('\n'))
	})

	test('a control joining a row on an occupied cell takes the nearest free column, left or right', () => {
		const grid = gridOf(
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

		expect(grid).toEqual(['  1  .  .  .  .  2', '  7  5  6  8  9  .'].join('\n'))
	})

	test('controls alone in their rows stay apart when no row has more than one control', () => {
		const grid = gridOf(
			gridTopology([
				[1, 100, 100, 1],
				[2, 100, 300, 1],
				[3, 100, 500, 1],
			]),
		)

		expect(grid).toEqual(['  1', '  2', '  3'].join('\n'))
	})

	test('a run of controls of one type takes consecutive columns, even on a wider pitch', () => {
		const grid = gridOf(
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
		expect(grid).toEqual(['  1  2  3', ' 11 12 13'].join('\n'))
	})

	test('only neighbours of the same type close up: a control of another type keeps its column and splits the run', () => {
		const grid = gridOf(
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
		expect(grid).toEqual(['  1  2  .  .  3  .  4', '  . 11 12 13  .  .  .'].join('\n'))
	})

	test('controls with only a width are treated as round: their height is their width', () => {
		const grid = gridOf({
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
		expect(grid).toEqual(['  1  2  3  .  .', '  .  .  .  4  5'].join('\n'))
	})

	test('a control on an occupied cell moves right to the next free column', () => {
		const c = layoutOf({
			HWc: [
				{ id: 1, x: 100, y: 100, txt: 'A', type: 1 },
				{ id: 2, x: 100, y: 100, txt: 'B', type: 1 },
				{ id: 3, x: 100, y: 100, txt: 'C', type: 1 },
				{ id: 4, x: 300, y: 100, txt: 'D', type: 1 },
			],
			typeIndex: { '1': { w: 100, h: 100, in: 'b', out: 'rgb' } },
		}).surfaceLayout.controls

		expect([c['hwc/1'], c['hwc/2'], c['hwc/3'], c['hwc/4']]).toEqual([
			{ row: 0, column: 0 },
			{ row: 0, column: 1 },
			{ row: 0, column: 2 },
			{ row: 0, column: 3 },
		])
	})

	test('a per-control typeOverride is applied over its type', () => {
		const c = layoutOf({
			HWc: [
				{ id: 1, x: 100, y: 100, txt: 'Plain', type: 1 },
				{ id: 2, x: 300, y: 100, txt: 'Display', type: 1, typeOverride: { disp: { w: 64, h: 32, subidx: 0 } } },
				{ id: 3, x: 500, y: 100, txt: 'Now a fader', type: 1, typeOverride: { in: 'av' } },
			],
			typeIndex: { '1': { w: 100, h: 100, in: 'b', out: 'rgb' } },
		}).surfaceLayout.controls

		expect(c['hwc/1'].stylePreset).toBeUndefined()
		expect(c['hwc/2'].stylePreset).toBeDefined()
		expect(c['hwc/3']).toBeUndefined()
	})
})
