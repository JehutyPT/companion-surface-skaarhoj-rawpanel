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

// The wiring between the surface and the sender, end to end; the analog rules are in analog-sender.spec.ts
describe('analog values', () => {
	test('intensity axes are put at rest on ready(), not init(): Companion drops variable values before the surface is registered', async () => {
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

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_58', 0],
			['variable', 'hwc_60', 0],
			['variable', 'hwc_61', 0],
			['variable', 'hwc_62', 0],
		])
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

	test('each axis in the topology gets its own enabled, dead zone and saturation field, named after the axis', async () => {
		const { result } = await openSurface()
		const analogFields = fields(result).filter((f) => /^analog(Enabled|Deadband|Saturation)/.test(f.id))

		expect(analogFields.map((f) => [f.id, f.label])).toEqual([
			['analogEnabled_58', 'Elastomer Zoom Rocker (HWC 58): enabled'],
			['analogDeadband_58', 'Elastomer Zoom Rocker (HWC 58): dead zone'],
			['analogSaturation_58', 'Elastomer Zoom Rocker (HWC 58): saturation'],
			['analogEnabled_60', '4-Axis Joystick, Left-Right (HWC 60): enabled'],
			['analogDeadband_60', '4-Axis Joystick, Left-Right (HWC 60): dead zone'],
			['analogSaturation_60', '4-Axis Joystick, Left-Right (HWC 60): saturation'],
			['analogEnabled_61', '4-Axis Joystick, Up-Down (HWC 61): enabled'],
			['analogDeadband_61', '4-Axis Joystick, Up-Down (HWC 61): dead zone'],
			['analogSaturation_61', '4-Axis Joystick, Up-Down (HWC 61): saturation'],
			['analogEnabled_62', '4-Axis Joystick, Rotate (HWC 62): enabled'],
			['analogDeadband_62', '4-Axis Joystick, Rotate (HWC 62): dead zone'],
			['analogSaturation_62', '4-Axis Joystick, Rotate (HWC 62): saturation'],
		])
		expect(fields(result).find((f) => f.id === 'analogEnabled_60')).toMatchObject({ type: 'checkbox', default: true })
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
		expect(parseAnalogTuning(config, [joystick])).toEqual({ intervalMs, axes: { 60: { enabled: true, ...axis } } })
	})

	test('a fader is tuned on its own scale, 0 to 1000', () => {
		expect(parseAnalogTuning({}, [fader])).toEqual({
			intervalMs: 50,
			axes: { 5: { enabled: true, deadband: 6, saturation: 1000 } },
		})
		expect(parseAnalogTuning({ analogSaturation_5: 2000 }, [fader]).axes[5].saturation).toBe(1000)
	})

	test('the old single dead zone setting still applies to every axis that has no setting of its own', () => {
		const upDown = { ...joystick, hwc: 61, variableId: 'hwc_61' }
		const { axes } = parseAnalogTuning({ analogDeadband: 0, analogDeadband_61: 50 }, [joystick, upDown])

		expect(axes[60].deadband).toBe(0)
		expect(axes[61].deadband).toBe(50)
	})
})

describe('enabling and disabling an axis (surface settings)', () => {
	test.each([
		['missing', {}, true],
		['true', { analogEnabled_60: true }, true],
		['false', { analogEnabled_60: false }, false],
	])('enabled %s', (_name, config, enabled) => {
		const axis = { hwc: 60, variableId: 'hwc_60', name: 'LR', suggestedVariable: 'skaarhoj_lr', mode: 'Speed' as const }
		expect(parseAnalogTuning(config, [axis]).axes[60].enabled).toBe(enabled)
	})
})
