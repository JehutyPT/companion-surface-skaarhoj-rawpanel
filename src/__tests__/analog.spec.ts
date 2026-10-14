/**
 * Analog controls (joysticks, rockers, faders, T-bars) as Companion input transfer variables.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { LoggingSink, OpenSurfaceResult } from '@companion-surface/base'
import { Harness } from './helpers/harness.js'
import { sleep, waitFor } from './helpers/fake-panel.js'
import { FakeSurfaceContext, type ContextCall } from './helpers/fake-context.js'
import { ptzExtremeTopology } from './fixtures/topologies.js'
import { parseAnalogTuning } from '../analog.js'

let harness: Harness | undefined

beforeEach(() => {
	const sink: LoggingSink = () => null
	globalThis.SURFACE_LOGGER = sink
})

afterEach(async () => {
	await harness?.stop()
	harness = undefined
	globalThis.SURFACE_LOGGER = undefined
})

async function openSurface(topology: unknown = ptzExtremeTopology) {
	harness = new Harness({ topology })
	await harness.start()
	await harness.connect()
	const opened = await harness.open(await harness.waitForAnnouncements())
	await waitFor(() => harness!.panel.commands.length > 0)
	await sleep(30)
	return { ...opened, panel: harness.panel }
}

const variables = (calls: ContextCall[]) => calls.filter((c) => c[0] === 'variable')

describe('analog transfer variables', () => {
	test('every analog axis in the topology is one input transfer variable, named from the topology', async () => {
		const { result } = await openSurface()

		expect(result.registerProps.transferVariables).toEqual([
			{
				id: 'hwc_58',
				type: 'input',
				name: 'Elastomer Zoom Rocker (HWC 58)',
				description: expect.stringMatching(/can't create or preselect.*skaarhoj_zoom/),
			},
			{
				id: 'hwc_60',
				type: 'input',
				name: '4-Axis Joystick, Left-Right (HWC 60)',
				description: expect.stringContaining('skaarhoj_lr'),
			},
			{
				id: 'hwc_61',
				type: 'input',
				name: '4-Axis Joystick, Up-Down (HWC 61)',
				description: expect.stringContaining('skaarhoj_ud'),
			},
			{
				id: 'hwc_62',
				type: 'input',
				name: '4-Axis Joystick, Rotate (HWC 62)',
				description: expect.stringContaining('skaarhoj_rotate'),
			},
		])
		// Analog controls stay out of the button layout
		expect(Object.keys(result.registerProps.surfaceLayout.controls)).not.toContain('hwc/58')
	})

	test('a topology without analog controls declares no transfer variables', async () => {
		const { result } = await openSurface({
			HWc: [{ id: 1, x: 100, y: 100, txt: 'One', type: 1 }],
			typeIndex: { '1': { w: 100, in: 'b', out: 'rgb' } },
		})

		expect(result.registerProps.transferVariables).toBeUndefined()
	})

	test('an unlabelled axis or a repeated label still gets a unique name and suggestion', async () => {
		const { result } = await openSurface({
			HWc: [
				{ id: 1, x: 100, y: 100, txt: 'One', type: 1 },
				{ id: 5, x: 300, y: 100, txt: 'Fader', type: 2 },
				{ id: 6, x: 500, y: 100, txt: 'Fader', type: 2 },
				{ id: 7, x: 700, y: 100, txt: '', type: 3 },
			],
			typeIndex: {
				'1': { w: 100, in: 'b', out: 'rgb' },
				'2': { w: 100, in: 'av' },
				'3': { w: 100, in: 'ah' },
			},
		})
		const vars = result.registerProps.transferVariables!

		expect(vars.map((v) => [v.id, v.name])).toEqual([
			['hwc_5', 'Fader (HWC 5)'],
			['hwc_6', 'Fader (HWC 6)'],
			['hwc_7', 'Analog control (HWC 7)'],
		])
		expect(vars[0].description).toContain('skaarhoj_fader_5')
		expect(vars[1].description).toContain('skaarhoj_fader_6')
		expect(vars[2].description).toContain('skaarhoj_hwc_7')
	})
})

describe('analog values', () => {
	test('intensity axes start at rest: each sends 0 when the surface opens', async () => {
		const { context } = await openSurface()

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_58', 0],
			['variable', 'hwc_60', 0],
			['variable', 'hwc_61', 0],
			['variable', 'hwc_62', 0],
		])
	})

	test('the rest values wait for ready(): Companion drops variable values before the surface is registered', async () => {
		harness = new Harness({ topology: ptzExtremeTopology })
		await harness.start()
		await harness.connect()
		const info = await harness.waitForAnnouncements()
		const context = new FakeSurfaceContext()
		const result = await harness.plugin.openSurface(info.surfaceId, info.pluginInfo, context)
		harness.opened.push(result)
		await result.surface.init()
		await sleep(30)
		expect(variables(context.calls)).toEqual([])

		await result.surface.ready()

		expect(variables(context.calls).map((c) => c[1])).toEqual(['hwc_58', 'hwc_60', 'hwc_61', 'hwc_62'])
	})

	test('a move sends its value at once; with the default dead zone the ends stay at ±500', async () => {
		const { context, panel } = await openSurface()
		context.calls.length = 0

		panel.send('HWC#60=Speed:-487', 'HWC#58=Speed:500')
		await sleep(20)

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_60', -487],
			['variable', 'hwc_58', 500],
		])
	})

	test('absolute (fader) values run 0 to 1000', async () => {
		const { context, panel } = await openSurface({
			HWc: [
				{ id: 1, x: 100, y: 100, txt: 'One', type: 1 },
				{ id: 5, x: 300, y: 100, txt: 'Fader', type: 2 },
			],
			typeIndex: { '1': { w: 100, in: 'b', out: 'rgb' }, '2': { w: 100, in: 'av' } },
		})
		// A fader has no rest position, so nothing is sent until it moves
		expect(variables(context.calls)).toEqual([])

		panel.send('HWC#5=Abs:1000')
		await sleep(20)

		expect(variables(context.calls)).toEqual([['variable', 'hwc_5', 1000]])
	})

	test('a fast burst is coalesced per axis to one send per 50 ms, always ending on the final value', async () => {
		const { context, panel } = await openSurface()
		await sleep(60)
		context.calls.length = 0

		for (let v = 10; v <= 400; v += 10) panel.send(`HWC#61=Speed:${v}`)
		panel.send('HWC#61=Speed:0', 'HWC#62=Speed:-200')
		await sleep(120)

		const sent = variables(context.calls)
		expect(sent.filter((c) => c[1] === 'hwc_61').length).toBeLessThanOrEqual(3)
		expect(sent.filter((c) => c[1] === 'hwc_61').at(-1)).toEqual(['variable', 'hwc_61', 0])
		// Another axis is not held back by the first one's coalescing
		// -200 scaled past the default dead zone of 6: 500 * 194 / 494 = 196.4
		expect(sent.filter((c) => c[1] === 'hwc_62')).toEqual([['variable', 'hwc_62', -196]])
	})

	test('changes within the deadband are not sent, but the return to centre always is', async () => {
		const { context, panel } = await openSurface()
		context.calls.length = 0

		panel.send('HWC#60=Speed:3')
		await sleep(70)
		panel.send('HWC#60=Speed:40')
		await sleep(70)
		panel.send('HWC#60=Speed:42')
		await sleep(70)
		panel.send('HWC#60=Speed:0')
		await sleep(70)

		// Scaled past the default dead zone of 6: 40 -> 34, 42 -> 36 (within 6 of 34)
		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_60', 34],
			['variable', 'hwc_60', 0],
		])
	})

	test('an intensity axis resting a few units off centre reads 0', async () => {
		const { context, panel } = await openSurface()
		context.calls.length = 0

		panel.send('HWC#62=Speed:-20')
		await sleep(70)
		panel.send('HWC#62=Speed:-3')
		await sleep(70)

		// -20 scaled past the dead zone: 500 * 14 / 494 = 14.2
		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_62', -14],
			['variable', 'hwc_62', 0],
		])
	})

	test('on a fader the dead zone is a change threshold across the whole travel; only 0 and 1000 bypass it', async () => {
		const { context, panel } = await openSurface({
			HWc: [
				{ id: 1, x: 100, y: 100, txt: 'One', type: 1 },
				{ id: 5, x: 300, y: 100, txt: 'Fader', type: 2 },
			],
			typeIndex: { '1': { w: 100, in: 'b', out: 'rgb' }, '2': { w: 100, in: 'av' } },
		})

		for (const v of [700, 703, 997, 1000]) {
			panel.send(`HWC#5=Abs:${v}`)
			await sleep(70)
		}

		// Scaled by 1000 / 994: 700 -> 698, 703 -> 701 (within 6 of 698), 997 -> 997
		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_5', 698],
			['variable', 'hwc_5', 997],
			['variable', 'hwc_5', 1000],
		])
	})

	test('a value queued just before Companion locks is not sent', async () => {
		const { context, panel } = await openSurface()
		await sleep(60)
		context.calls.length = 0

		panel.send('HWC#60=Speed:100', 'HWC#60=Speed:200')
		await waitFor(() => variables(context.calls).length >= 1)
		context.locked = true
		await sleep(70)

		expect(variables(context.calls)).toEqual([['variable', 'hwc_60', 95]])
	})

	test('a deflected axis returns to 0 when the link drops, so nothing keeps moving', async () => {
		const { context, panel } = await openSurface()
		panel.send('HWC#60=Speed:-300', 'HWC#58=Speed:250')
		await waitFor(() => variables(context.calls).length >= 6)
		context.calls.length = 0

		panel.dropClients()
		await waitFor(() => variables(context.calls).length >= 2)

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_58', 0],
			['variable', 'hwc_60', 0],
		])
	})

	test('while locked, moves are ignored but the return to centre is still sent', async () => {
		const { context, panel } = await openSurface()
		panel.send('HWC#60=Speed:-300')
		await waitFor(() => variables(context.calls).length >= 5)
		context.calls.length = 0
		context.locked = true

		panel.send('HWC#61=Speed:200')
		await sleep(70)
		panel.send('HWC#60=Speed:0')
		await sleep(70)

		expect(variables(context.calls)).toEqual([['variable', 'hwc_60', 0]])
	})

	test('nothing is sent after the surface closes', async () => {
		const { context, panel, result } = await openSurface()
		panel.send('HWC#60=Speed:100', 'HWC#60=Speed:200')
		await result.surface.close()
		context.calls.length = 0

		await sleep(80)

		expect(variables(context.calls)).toEqual([])
	})
})

describe('analog tuning (surface settings)', () => {
	const fields = (result: OpenSurfaceResult) => result.registerProps.configFields ?? []

	test('each axis in the topology gets its own dead zone and saturation field, named after the axis', async () => {
		const { result } = await openSurface()
		const analogFields = fields(result).filter((f) => /^analog(Deadband|Saturation)/.test(f.id))

		expect(analogFields.map((f) => [f.id, f.label])).toEqual([
			['analogDeadband_58', 'Elastomer Zoom Rocker (HWC 58): dead zone'],
			['analogSaturation_58', 'Elastomer Zoom Rocker (HWC 58): saturation'],
			['analogDeadband_60', '4-Axis Joystick, Left-Right (HWC 60): dead zone'],
			['analogSaturation_60', '4-Axis Joystick, Left-Right (HWC 60): saturation'],
			['analogDeadband_61', '4-Axis Joystick, Up-Down (HWC 61): dead zone'],
			['analogSaturation_61', '4-Axis Joystick, Up-Down (HWC 61): saturation'],
			['analogDeadband_62', '4-Axis Joystick, Rotate (HWC 62): dead zone'],
			['analogSaturation_62', '4-Axis Joystick, Rotate (HWC 62): saturation'],
		])
		expect(fields(result).find((f) => f.id === 'analogDeadband_60')).toMatchObject({
			type: 'number',
			default: 6,
			min: 0,
			max: 100,
		})
		// Saturation defaults to full travel: off
		expect(fields(result).find((f) => f.id === 'analogSaturation_60')).toMatchObject({
			type: 'number',
			default: 500,
			min: 100,
			max: 500,
		})
		expect(fields(result).find((f) => f.id === 'analogInterval')).toMatchObject({
			type: 'number',
			default: 50,
			min: 10,
			max: 1000,
		})
		expect(fields(result).find((f) => f.id === 'analogDeadband')).toBeUndefined()
	})

	test('a fader saturates at 1000 by default; a topology without analog controls has no analog fields', async () => {
		const { result } = await openSurface({
			HWc: [
				{ id: 1, x: 100, y: 100, txt: 'One', type: 1 },
				{ id: 5, x: 300, y: 100, txt: 'Fader', type: 2 },
			],
			typeIndex: { '1': { w: 100, in: 'b', out: 'rgb' }, '2': { w: 100, in: 'av' } },
		})
		expect(fields(result).find((f) => f.id === 'analogSaturation_5')).toMatchObject({
			default: 1000,
			min: 100,
			max: 1000,
		})
		await harness!.stop()

		const { result: plain } = await openSurface({
			HWc: [{ id: 1, x: 100, y: 100, txt: 'One', type: 1 }],
			typeIndex: { '1': { w: 100, in: 'b', out: 'rgb' } },
		})
		expect(
			fields(plain)
				.filter((f) => f.id.startsWith('analog'))
				.map((f) => f.id),
		).toEqual(['analogInterval'])
	})

	test('an axis that stops short of full travel reaches ±500 once its saturation is set just below its end', async () => {
		const { context, panel, result } = await openSurface()
		await result.surface.updateConfig!({ analogSaturation_60: 495 })
		context.calls.length = 0

		panel.send('HWC#60=Speed:-496')
		await sleep(70)
		panel.send('HWC#60=Speed:496')
		await sleep(70)

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_60', -500],
			['variable', 'hwc_60', 500],
		])
	})

	test('between dead zone and saturation the value scales linearly to the full range', async () => {
		const { context, panel, result } = await openSurface()
		await result.surface.updateConfig!({ analogDeadband_60: 6, analogSaturation_60: 495 })
		context.calls.length = 0

		panel.send('HWC#60=Speed:250')
		await sleep(70)
		panel.send('HWC#60=Speed:-125')
		await sleep(70)

		// 500 * (250 - 6) / (495 - 6) = 249.49 -> 249; 500 * (125 - 6) / 489 = 121.68 -> -122
		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_60', 249],
			['variable', 'hwc_60', -122],
		])
	})

	test('the scale is continuous at both edges: no jump past the dead zone or before saturation', async () => {
		const { context, panel, result } = await openSurface()
		// 500 / (120 - 20) = 5 per panel step
		await result.surface.updateConfig!({ analogDeadband_61: 20, analogSaturation_61: 120 })
		await sleep(60)
		context.calls.length = 0

		for (const v of [-60, -21, -20, 119, 120]) {
			panel.send(`HWC#61=Speed:${v}`)
			await sleep(70)
		}

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_61', -200],
			['variable', 'hwc_61', -5],
			['variable', 'hwc_61', 0],
			['variable', 'hwc_61', 495],
			['variable', 'hwc_61', 500],
		])
	})

	test('two axes with different settings are tuned independently', async () => {
		const { context, panel, result } = await openSurface()
		await result.surface.updateConfig!({
			analogDeadband_60: 0,
			analogSaturation_60: 500,
			analogDeadband_61: 50,
			analogSaturation_61: 250,
		})
		await sleep(60)
		context.calls.length = 0

		panel.send('HWC#60=Speed:40', 'HWC#61=Speed:40')
		await sleep(70)
		panel.send('HWC#60=Speed:250', 'HWC#61=Speed:250')
		await sleep(70)

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_60', 40],
			['variable', 'hwc_60', 250],
			['variable', 'hwc_61', 500],
		])
	})

	test('a fader scales from its dead zone above 0 to its saturation', async () => {
		const { context, panel, result } = await openSurface({
			HWc: [
				{ id: 1, x: 100, y: 100, txt: 'One', type: 1 },
				{ id: 5, x: 300, y: 100, txt: 'Fader', type: 2 },
			],
			typeIndex: { '1': { w: 100, in: 'b', out: 'rgb' }, '2': { w: 100, in: 'av' } },
		})
		await result.surface.updateConfig!({ analogDeadband_5: 10, analogSaturation_5: 990 })

		for (const v of [500, 995, 8]) {
			panel.send(`HWC#5=Abs:${v}`)
			await sleep(70)
		}

		// 1000 * (500 - 10) / 980 = 500
		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_5', 500],
			['variable', 'hwc_5', 1000],
			['variable', 'hwc_5', 0],
		])
	})

	test('a dead zone of 0 sends every change, including a few units off centre', async () => {
		const { context, panel, result } = await openSurface()
		await result.surface.updateConfig!({ analogDeadband_60: 0 })
		context.calls.length = 0

		panel.send('HWC#60=Speed:3')
		await sleep(70)
		panel.send('HWC#60=Speed:4')
		await sleep(70)

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_60', 3],
			['variable', 'hwc_60', 4],
		])
	})

	test('a larger dead zone swallows bigger changes, but the ends of travel and centre still get through', async () => {
		const { context, panel, result } = await openSurface()
		await result.surface.updateConfig!({ analogDeadband_60: 50 })
		context.calls.length = 0

		// Scaled by 500 / 450: 40 -> 0, 100 -> 56, 140 -> 100 (within 50 of 56), 480 -> 478
		for (const v of [40, 100, 140, 480, 500, 30]) {
			panel.send(`HWC#60=Speed:${v}`)
			await sleep(70)
		}

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_60', 56],
			['variable', 'hwc_60', 478],
			['variable', 'hwc_60', 500],
			['variable', 'hwc_60', 0],
		])
	})

	test('the old single dead zone setting still applies to every axis that has no setting of its own', async () => {
		const { context, panel, result } = await openSurface()
		await result.surface.updateConfig!({ analogDeadband: 0, analogDeadband_61: 50 })
		context.calls.length = 0

		panel.send('HWC#60=Speed:3', 'HWC#61=Speed:30')
		await sleep(70)

		expect(variables(context.calls)).toEqual([['variable', 'hwc_60', 3]])
	})

	test('a longer send interval coalesces a burst more, still ending on the final value', async () => {
		const { context, panel, result } = await openSurface()
		await result.surface.updateConfig!({ analogInterval: 300, analogDeadband_61: 0 })
		await sleep(300)
		context.calls.length = 0

		panel.send('HWC#61=Speed:100')
		await sleep(100)
		panel.send('HWC#61=Speed:200')
		await sleep(100)
		panel.send('HWC#61=Speed:250')
		await sleep(30)
		expect(variables(context.calls)).toEqual([['variable', 'hwc_61', 100]])

		await sleep(200)
		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_61', 100],
			['variable', 'hwc_61', 250],
		])
	})

	test('changing the tuning applies at once, without reconnecting or sending the panel anything', async () => {
		const { context, panel, result } = await openSurface()
		const connections = panel.connectionCount
		panel.clearReceived()
		await result.surface.updateConfig!({ analogDeadband_60: 0, analogSaturation_60: 400, analogInterval: 10 })
		await sleep(50)
		context.calls.length = 0

		panel.send('HWC#60=Speed:2')
		await sleep(30)
		panel.send('HWC#60=Speed:450')
		await sleep(30)

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_60', 3],
			['variable', 'hwc_60', 500],
		])
		expect(panel.connectionCount).toBe(connections)
		expect(panel.commands).toEqual([])
	})

	const joystick = {
		hwc: 60,
		variableId: 'hwc_60',
		name: 'LR',
		suggestedVariable: 'skaarhoj_lr',
		mode: 'Speed' as const,
	}
	const fader = {
		hwc: 5,
		variableId: 'hwc_5',
		name: 'Fader',
		suggestedVariable: 'skaarhoj_fader',
		mode: 'Abs' as const,
	}

	test.each([
		['missing', {}, 50, { deadband: 6, saturation: 500 }],
		[
			'empty strings',
			{ analogDeadband_60: '', analogSaturation_60: '', analogInterval: '' },
			50,
			{ deadband: 6, saturation: 500 },
		],
		[
			'not numbers',
			{ analogDeadband_60: 'abc', analogSaturation_60: null, analogInterval: null },
			50,
			{ deadband: 6, saturation: 500 },
		],
		[
			'numeric strings',
			{ analogDeadband_60: '12', analogSaturation_60: '480', analogInterval: '120' },
			120,
			{ deadband: 12, saturation: 480 },
		],
		[
			'below range',
			{ analogDeadband_60: -5, analogSaturation_60: 3, analogInterval: 0 },
			10,
			{ deadband: 0, saturation: 100 },
		],
		[
			'above range',
			{ analogDeadband_60: 900, analogSaturation_60: 900, analogInterval: 99999 },
			1000,
			{ deadband: 100, saturation: 500 },
		],
		[
			'fractions',
			{ analogDeadband_60: 2.6, analogSaturation_60: 480.4, analogInterval: 75.4 },
			75,
			{ deadband: 3, saturation: 480 },
		],
		['the old single dead zone', { analogDeadband: 20 }, 50, { deadband: 20, saturation: 500 }],
		[
			'saturation not above the dead zone',
			{ analogDeadband_60: 100, analogSaturation_60: 100 },
			50,
			{ deadband: 100, saturation: 500 },
		],
	])('%s values are read as a usable tuning', (_name, config, intervalMs, axis) => {
		expect(parseAnalogTuning(config, [joystick])).toEqual({ intervalMs, axes: { 60: axis } })
	})

	test('a fader is tuned on its own scale, 0 to 1000', () => {
		expect(parseAnalogTuning({}, [fader])).toEqual({ intervalMs: 50, axes: { 5: { deadband: 6, saturation: 1000 } } })
		expect(parseAnalogTuning({ analogSaturation_5: 2000 }, [fader]).axes[5].saturation).toBe(1000)
	})
})
