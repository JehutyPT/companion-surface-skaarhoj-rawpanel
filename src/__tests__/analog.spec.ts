/**
 * Analog controls (joysticks, rockers, faders, T-bars) as Companion input transfer variables.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { Harness } from './helpers/harness.js'
import { sleep, waitFor } from './helpers/timing.js'
import { FakeSurfaceContext, type ContextCall } from './helpers/fake-context.js'
import { ptzExtremeTopology } from './fixtures/topologies.js'
import { captureLogs } from './helpers/logs.js'

let harness: Harness | undefined

// Keep the plugin's logs out of the test output
captureLogs()

afterEach(async () => {
	await harness?.stop()
	harness = undefined
})

const variables = (calls: ContextCall[]) => calls.filter((c) => c[0] === 'variable')

describe('analog transfer variables', () => {
	test('every analog axis in the topology is one input transfer variable, named from the topology', async () => {
		harness = new Harness({ topology: ptzExtremeTopology })
		const { result } = await harness.connectAndOpen()

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
		harness = new Harness({
			topology: {
				HWc: [{ id: 1, x: 100, y: 100, txt: 'One', type: 1 }],
				typeIndex: { '1': { w: 100, in: 'b', out: 'rgb' } },
			},
		})
		const { result } = await harness.connectAndOpen()

		expect(result.registerProps.transferVariables).toBeUndefined()
	})

	test('an unlabelled axis or a repeated label still gets a unique name and suggestion', async () => {
		harness = new Harness({
			topology: {
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
			},
		})
		const { result } = await harness.connectAndOpen()
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

	test('values the panel reports between init() and ready() reach Companion at ready(): a rocker back at 0 sends 0, a fader its latest value', async () => {
		harness = new Harness({
			topology: {
				HWc: [
					{ id: 1, x: 100, y: 100, txt: 'One', type: 1 },
					{ id: 4, x: 300, y: 100, txt: 'Rocker', type: 2 },
					{ id: 5, x: 500, y: 100, txt: 'Fader', type: 3 },
				],
				typeIndex: {
					'1': { w: 100, in: 'b', out: 'rgb' },
					'2': { w: 100, in: 'ir' },
					'3': { w: 100, in: 'av' },
				},
			},
		})
		await harness.start()
		await harness.connect()
		const info = await harness.waitForAnnouncements()
		const context = new FakeSurfaceContext()
		const result = await harness.plugin.openSurface(info.surfaceId, info.pluginInfo, context)
		harness.opened.push(result)
		await result.surface.init()

		// The key press comes last on the same connection, so once it arrives the analog lines have too
		harness.panel.send('HWC#4=Speed:0', 'HWC#5=Abs:300', 'HWC#5=Abs:700', 'HWC#1=Down')
		await waitFor(() => context.calls.some((c) => c[0] === 'keyDown'))
		// Past the send interval: nothing still queued may land after ready() and pass for it
		await sleep(80)
		const beforeReady = context.calls.length

		await result.surface.ready()

		// 700 scaled past the default dead zone: 1000 * 694 / 994 = 698.2
		expect(variables(context.calls.slice(beforeReady))).toEqual([
			['variable', 'hwc_4', 0],
			['variable', 'hwc_5', 698],
		])
	})

	test('a deflected axis returns to 0 when the link drops, so nothing keeps moving', async () => {
		harness = new Harness({ topology: ptzExtremeTopology })
		const { context, panel } = await harness.connectAndOpen()
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
		harness = new Harness({ topology: ptzExtremeTopology })
		const { context, panel } = await harness.connectAndOpen()
		panel.send('HWC#60=Speed:-300')
		await waitFor(() => variables(context.calls).length >= 5)
		context.calls.length = 0
		context.locked = true

		// The ignored move is handled before the return to centre, which is sent at once or after an interval
		await panel.sendAndSync('HWC#61=Speed:200', 'HWC#60=Speed:0')
		await waitFor(() => variables(context.calls).length >= 1, 2000, 'the return to centre')

		expect(variables(context.calls)).toEqual([['variable', 'hwc_60', 0]])
	})

	test('nothing is sent after the surface closes', async () => {
		harness = new Harness({ topology: ptzExtremeTopology })
		const { context, panel, result } = await harness.connectAndOpen()
		panel.send('HWC#60=Speed:100', 'HWC#60=Speed:200')
		await result.surface.close()
		context.calls.length = 0

		await sleep(80)

		expect(variables(context.calls)).toEqual([])
	})
})

describe('analog tuning (surface settings)', () => {
	test('changing the tuning applies at once, without reconnecting or sending the panel anything', async () => {
		harness = new Harness({ topology: ptzExtremeTopology })
		const { context, panel, result } = await harness.connectAndOpen()
		const connections = panel.connectionCount
		panel.clearReceived()
		await result.surface.updateConfig!({ analogDeadband_60: 0, analogSaturation_60: 400, analogInterval: 10 })
		await sleep(50)
		context.calls.length = 0

		panel.send('HWC#60=Speed:2')
		await waitFor(() => variables(context.calls).length >= 1, 2000, 'the first value')
		panel.send('HWC#60=Speed:450')
		await waitFor(() => variables(context.calls).length >= 2, 2000, 'the second value')

		expect(variables(context.calls)).toEqual([
			['variable', 'hwc_60', 3],
			['variable', 'hwc_60', 500],
		])
		expect(panel.connectionCount).toBe(connections)
		expect(panel.commands).toEqual([])
	})
})
