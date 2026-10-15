import { afterEach, describe, expect, test } from 'vitest'
import { validateSurfaceLayout, type SurfaceInstance } from '@companion-surface/base'
import { Harness } from './helpers/harness.js'
import { sleep, waitFor } from './helpers/timing.js'
import type { FakeSurfaceContext } from './helpers/fake-context.js'
import { ptzExtremeLayoutHwcs, ptzExtremeTopology, smallTopology } from './fixtures/topologies.js'
import { layoutOf } from './helpers/layout.js'
import { captureLogs } from './helpers/logs.js'

let harness: Harness | undefined
const logs = captureLogs()

afterEach(async () => {
	await harness?.stop()
	harness = undefined
})

const signal = new AbortController().signal

/** Draw, then wait for the queue to flush and return what reached the panel. */
async function drawAndCollect(surface: SurfaceInstance, ...draws: Parameters<SurfaceInstance['draw']>[1][]) {
	harness!.panel.clearReceived()
	for (const props of draws) await surface.draw(signal, props)
	await harness!.settle()
	return harness!.panel.commands
}

describe('layout from topology', () => {
	// The layout rules are tested on buildLayout directly (topology.spec.ts); these check the wiring.
	test('the layout registered at open is the one built from the topology, with analog axes as transfer variables', async () => {
		harness = new Harness({ topology: ptzExtremeTopology })
		const { result } = await harness.connectAndOpen()
		const layout = result.registerProps.surfaceLayout

		validateSurfaceLayout(layout)
		expect(layout).toEqual(layoutOf(ptzExtremeTopology).surfaceLayout)
		expect(Object.keys(layout.controls).sort()).toEqual(ptzExtremeLayoutHwcs.map((n) => `hwc/${n}`).sort())
		// Analog controls are transfer variables instead (analog.spec.ts)
		expect(result.registerProps.transferVariables?.map((v) => v.id)).toEqual(['hwc_58', 'hwc_60', 'hwc_61', 'hwc_62'])
	})

	test('controls with neither an LED nor a display get no commands, on connect or on draw', async () => {
		harness = new Harness({ topology: ptzExtremeTopology })
		const { result, panel } = await harness.connectAndOpen()

		expect(panel.commands.filter((l) => /^HWCc?#(57|59|63)=/.test(l))).toEqual([])
		const sent = await drawAndCollect(result.surface, {
			controlId: 'hwc/57',
			color: '#ff0000',
			text: 'Iris',
			pressed: true,
		})
		expect(sent).toEqual([])
	})

	test('a control with an unknown input type is skipped and logged once', async () => {
		harness = new Harness({ topology: smallTopology })
		const { result } = await harness.connectAndOpen()
		harness.panel.dropClients()
		await waitFor(() => harness!.panel.connectionCount === 2 && harness!.panel.commands.length > 0)

		expect(result.registerProps.surfaceLayout.controls['hwc/12']).toBeUndefined()
		const warnings = logs.filter((l) => l.level === 'warn' && l.message.includes('HWC 12'))
		expect(warnings).toHaveLength(1)
		expect(warnings[0].message).toContain("'zz'")
	})
})

describe('drawing', () => {
	// LED colours and text encoding are tested on ledCommands and textCommand (protocol.spec.ts).
	test('opening the surface turns every control off and clears every display', async () => {
		harness = new Harness({ topology: smallTopology })
		const { panel } = await harness.connectAndOpen()

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

	test('black turns the LED off', async () => {
		harness = new Harness({ topology: smallTopology })
		const { result } = await harness.connectAndOpen()
		await drawAndCollect(result.surface, { controlId: 'hwc/1', color: '#00ff00', pressed: false })

		const sent = await drawAndCollect(result.surface, { controlId: 'hwc/1', color: '#000000', pressed: false })

		expect(sent).toEqual(['HWC#1=0'])
	})

	test('pressed shows a lit button dimmed and an unlit button white', async () => {
		harness = new Harness({ topology: smallTopology })
		const { result } = await harness.connectAndOpen()

		const sent = await drawAndCollect(
			result.surface,
			{ controlId: 'hwc/1', color: '#ff0000', pressed: true },
			{ controlId: 'hwc/2', color: '#000000', pressed: true },
		)

		expect(sent).toEqual(['HWCc#1=240', 'HWC#1=5', 'HWCc#2=130', 'HWC#2=4'])
	})

	test('one line of text is shown as one big line', async () => {
		harness = new Harness({ topology: smallTopology })
		const { result } = await harness.connectAndOpen()

		const sent = await drawAndCollect(result.surface, { controlId: 'hwc/10', text: 'CAM 1', pressed: false })

		expect(sent).toEqual(['HWCt#10=1|10||CAM 1'])
	})

	test('text is ignored on a control without a display', async () => {
		harness = new Harness({ topology: smallTopology })
		const { result } = await harness.connectAndOpen()

		const sent = await drawAndCollect(result.surface, { controlId: 'hwc/1', text: 'Hello', pressed: false })

		expect(sent).toEqual([])
	})

	test('blank turns lit controls off and clears displays that show text', async () => {
		harness = new Harness({ topology: smallTopology })
		const { result } = await harness.connectAndOpen()
		await drawAndCollect(
			result.surface,
			{ controlId: 'hwc/1', color: '#ff0000', pressed: false },
			{ controlId: 'hwc/10', color: '#0000ff', text: 'Hi', pressed: false },
		)
		harness.panel.clearReceived()

		await result.surface.blank()
		await waitFor(() => harness!.panel.commands.length > 0, 2000, 'the blank')
		await harness.settle()

		expect(harness.panel.commands.sort()).toEqual(['HWC#1=0', 'HWC#10=0', 'HWCt#10=||||||'].sort())
	})

	test('waking from sleep re-sends every control', async () => {
		harness = new Harness({ topology: smallTopology })
		const { result, panel } = await harness.connectAndOpen()
		await drawAndCollect(result.surface, { controlId: 'hwc/1', color: '#ff0000', pressed: false })
		panel.clearReceived()

		panel.send('_isSleeping=1', '_isSleeping=0')
		await waitFor(() => panel.commands.length > 0, 2000, 'the resync on wake')
		await harness.settle()

		expect(panel.commands).toContain('HWCc#1=240')
		expect(panel.commands).toContain('HWC#1=4')
		expect(panel.commands).toContain('HWC#2=0')
		expect(panel.commands).toContain('HWCt#10=||||||')
	})
})

describe('input', () => {
	async function openWithInput(topology: unknown = smallTopology) {
		harness = new Harness({ topology })
		const opened = await harness.connectAndOpen()
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

		// 500 scaled past the default dead zone of 6: 1000 * 494 / 994 = 497
		expect(context.calls).toEqual([['variable', 'hwc_11', 497]])
	})

	test("the panel's map= lines reach neither Companion nor the log", async () => {
		const { context, send } = await openWithInput()

		await send('map=1:1', 'map=10:10', 'map=37:0', 'HWC#1=Down')

		expect(context.calls).toEqual([['keyDown', 'hwc/1']])
		expect(logs.filter((l) => l.message.includes('map='))).toEqual([])
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
		harness = new Harness({ topology: smallTopology })
		const { result } = await harness.connectAndOpen()

		await result.surface.close()
		await result.surface.close()
	})

	test('a closed surface writes nothing to the panel from draw or blank', async () => {
		harness = new Harness({ topology: smallTopology })
		const { result } = await harness.connectAndOpen()
		await drawAndCollect(result.surface, { controlId: 'hwc/10', color: '#ff0000', text: 'CAM 1', pressed: false })
		await result.surface.close()

		expect(await drawAndCollect(result.surface, { controlId: 'hwc/1', color: '#00ff00', pressed: false })).toEqual([])
		harness.panel.clearReceived()
		await result.surface.blank()
		await harness.settle()
		expect(harness.panel.commands).toEqual([])
	})
})
