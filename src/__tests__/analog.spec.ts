/**
 * Analog controls (joysticks, rockers, faders, T-bars) as Companion input transfer variables.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { LoggingSink } from '@companion-surface/base'
import { Harness } from './helpers/harness.js'
import { sleep, waitFor } from './helpers/fake-panel.js'
import { FakeSurfaceContext, type ContextCall } from './helpers/fake-context.js'
import { ptzExtremeTopology } from './fixtures/topologies.js'

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

	test('a move sends the raw panel value at once', async () => {
		const { context, panel } = await openSurface()
		context.calls.length = 0

		panel.send('HWC#60=Speed:-487', 'HWC#58=Speed:500')
		await sleep(20)

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_60', -487],
			['variable', 'hwc_58', 500],
		])
	})

	test('absolute (fader) values are sent raw, 0 to 1000', async () => {
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
		expect(sent.filter((c) => c[1] === 'hwc_62')).toEqual([['variable', 'hwc_62', -200]])
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

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_60', 40],
			['variable', 'hwc_60', 0],
		])
	})

	test('an intensity axis resting a few units off centre reads 0', async () => {
		const { context, panel } = await openSurface()
		context.calls.length = 0

		panel.send('HWC#62=Speed:-10')
		await sleep(70)
		panel.send('HWC#62=Speed:-3')
		await sleep(70)

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_62', -10],
			['variable', 'hwc_62', 0],
		])
	})

	test('on a fader the deadband applies across the whole travel; only 0 and 1000 bypass it', async () => {
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

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_5', 700],
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

		expect(variables(context.calls)).toEqual([['variable', 'hwc_60', 100]])
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
