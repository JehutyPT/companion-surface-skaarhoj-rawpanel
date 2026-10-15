import { afterEach, describe, expect, test } from 'vitest'
import { fastTimings, Harness } from './helpers/harness.js'
import { sleep, waitFor } from './helpers/timing.js'
import { ptzExtremeTopology, smallTopology } from './fixtures/topologies.js'
import { captureLogs } from './helpers/logs.js'

let harness: Harness | undefined
const logs = captureLogs()

afterEach(async () => {
	await harness?.stop()
	harness = undefined
})

/** Panel settings the plugin must never send. */
const PANEL_SETTINGS =
	/^(Clear|ClearLEDs|ClearDisplays|SleepTimer=|PanelBrightness=|encoderPressMode=|HeartBeatTimer=|SleepMode=|SleepScreenSaver=|DimmedGain=)/

describe('connecting to a panel', () => {
	test('asks for list then topology, and announces the surface by serial', async () => {
		harness = new Harness({ topology: ptzExtremeTopology })
		await harness.start()
		await harness.connect()

		const info = await harness.waitForAnnouncements()

		expect(info.surfaceId).toBe('skaarhoj:442845')
		expect(info.description).toContain('SK_PTZEXTREMEV2')
		expect(harness.panel.receivedOnLatest.slice(0, 2)).toEqual(['list', 'PanelTopology?'])
	})

	test('uses address and port as the surface id when the panel reports no serial', async () => {
		harness = new Harness({ topology: smallTopology, listReply: ['_model=SK_TEST'] })
		await harness.start()
		await harness.connect()

		const info = await harness.waitForAnnouncements()

		expect(info.surfaceId).toBe(`skaarhoj:127.0.0.1:${harness.panel.port}`)
	})

	test('a long svgbase line split across many chunks does not stop the topology from arriving', async () => {
		const svgbase = `<svg>${'<path d="M0 0L10 10"/>'.repeat(20000)}</svg>` // ~460 kB
		harness = new Harness(
			{ topology: ptzExtremeTopology, svgbase, chunkSize: 1500 },
			{ ...fastTimings, topologyTimeoutMs: 20_000 },
		)
		await harness.start()
		await harness.connect()

		// Hundreds of chunks take a while on a loaded machine. The wait is shorter than the topology
		// timeout, which is shorter than the test's own.
		const info = await harness.waitForAnnouncements(1, 15_000)

		expect(info.surfaceId).toBe('skaarhoj:442845')
		expect(harness.panel.connectionCount).toBe(1)
	}, 30_000)

	test('a line longer than 4 MiB with no newline yet fails the connection, which then reconnects', async () => {
		// The svgbase line comes before the topology; past the limit, the connection gives up on it
		const svgbase = 'x'.repeat(5 * 1024 * 1024)
		harness = new Harness({ topology: smallTopology, svgbase }, { ...fastTimings, topologyTimeoutMs: 5000 })
		await harness.start()
		await harness.connect()

		await waitFor(() => harness!.panel.connectionCount >= 2, 4000, 'a reconnect')

		expect(logs.some((l) => /line longer than/.test(l.message))).toBe(true)
		expect(harness.announced).toEqual([])
	}, 10_000)

	test('holds announcements made before init until init resolves', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.panel.listen()
		await harness.connect()
		await waitFor(() => harness!.panel.receivedOnLatest.includes('PanelTopology?'))
		await sleep(50)
		expect(harness.announced).toHaveLength(0)

		await harness.plugin.init()

		await harness.waitForAnnouncements()
		expect(harness.announced).toHaveLength(1)
	})

	test('answers a panel ping with ack', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect()
		await harness.waitForAnnouncements()

		harness.panel.send('ping')

		await waitFor(() => harness!.panel.receivedOnLatest.includes('ack'))
	})

	test('sends no panel settings during connect, open and reconnect', async () => {
		harness = new Harness({ topology: ptzExtremeTopology })
		await harness.start()
		await harness.connect()
		await harness.open(await harness.waitForAnnouncements())
		harness.panel.dropClients()
		await waitFor(() => harness!.panel.connectionCount === 2 && harness!.panel.commands.length > 0)
		harness.panel.send('_isSleeping=1', '_isSleeping=0')
		await sleep(50)

		expect(harness.panel.received.filter((l) => PANEL_SETTINGS.test(l))).toEqual([])
	})
})

describe('topology is required', () => {
	test('fails the connection with a logged error and retries when the panel never sends topology', async () => {
		harness = new Harness({ topology: null })
		await harness.start()
		await harness.connect()

		await waitFor(() => harness!.panel.connectionCount >= 2, 2000, 'a retry')

		expect(harness.announced).toEqual([])
		expect(logs.some((l) => l.level === 'error' && /topology/i.test(l.message))).toBe(true)
	})

	test('fails the connection when the topology is not usable JSON', async () => {
		harness = new Harness({ topology: '{"HWc": [ not json' })
		await harness.start()
		await harness.connect()

		await waitFor(() => harness!.panel.connectionCount >= 2, 2000, 'a retry')

		expect(harness.announced).toEqual([])
		expect(logs.some((l) => l.level === 'error' && /topology/i.test(l.message))).toBe(true)
	})

	test.each([
		['an empty HWc list', { HWc: [], typeIndex: {} }],
		[
			'only analog, unknown and input-less controls',
			{
				HWc: [
					{ id: 1, x: 100, y: 100, txt: 'Fader', type: 1 },
					{ id: 2, x: 300, y: 100, txt: 'Mystery', type: 2 },
					{ id: 3, x: 500, y: 100, txt: 'Label', type: 3 },
					{ id: 4, x: 700, y: 100, txt: 'Disabled', type: 0 },
				],
				typeIndex: { '1': { w: 100, h: 600, in: 'av' }, '2': { w: 100, in: 'zz' }, '3': { w: 400, h: 60 } },
			},
		],
	])('fails the connection with a logged error and retries when the topology has %s', async (_name, topology) => {
		harness = new Harness({ topology })
		await harness.start()
		await harness.connect()

		await waitFor(() => harness!.panel.connectionCount >= 2, 2000, 'a retry')

		expect(harness.announced).toEqual([])
		expect(logs.some((l) => l.level === 'error' && /no buttons or encoders/i.test(l.message))).toBe(true)
	})

	test('backs off between retries', async () => {
		harness = new Harness(
			{ topology: null },
			{ ...fastTimings, topologyTimeoutMs: 100, backoffInitialMs: 100, backoffMaxMs: 1000 },
		)
		await harness.start()
		await harness.connect()

		const times: number[] = []
		await waitFor(
			() => {
				if (harness!.panel.connectionCount > times.length) times.push(Date.now())
				return times.length >= 4
			},
			5000,
			'4 attempts',
		)

		// Each attempt waits the 100 ms topology timeout, then 100, 200, 400 ms of backoff.
		const gaps = times.slice(1).map((t, i) => t - times[i])
		expect(gaps[2] - gaps[0]).toBeGreaterThanOrEqual(200)
	})
})

describe('link liveness and reconnect', () => {
	test('drops and reconnects when the panel stops answering', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect()
		await harness.waitForAnnouncements()

		harness.panel.options.answerPings = false

		await waitFor(() => harness!.panel.connectionCount >= 2, 2000, 'a reconnect')
		// Link loss is expected in the field: a warning, not an error
		expect(logs.some((l) => l.level === 'warn' && /no reply from the panel/.test(l.message))).toBe(true)
		expect(logs.filter((l) => l.level === 'error')).toEqual([])
	})

	test('tolerates acks delayed by a stall shorter than the liveness timeout', async () => {
		harness = new Harness({ topology: smallTopology, ackDelayMs: 150 })
		await harness.start()
		await harness.connect()
		await harness.waitForAnnouncements()

		await sleep(600)

		expect(harness.panel.connectionCount).toBe(1)
	})

	test('keeps the surface open across a reconnect and re-pushes all state', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect()
		const { result, context } = await harness.open(await harness.waitForAnnouncements())
		await result.surface.draw(new AbortController().signal, { controlId: 'hwc/1', color: '#ff0000', pressed: false })
		await waitFor(() => harness!.panel.commands.includes('HWC#1=4'))

		harness.panel.dropClients()

		await waitFor(() => harness!.panel.connectionCount === 2, 2000, 'a reconnect')
		await waitFor(() => harness!.panel.commands.includes('HWC#1=4'), 2000, 'state re-pushed')
		expect(harness.panel.commands).toContain('HWCc#1=240')
		expect(harness.panel.commands).toContain('HWC#2=0')
		expect(harness.announced).toHaveLength(1)
		expect(context.calls.filter((c) => c[0] === 'disconnect')).toEqual([])
	})

	test('replaces the surface when the topology changes on reconnect', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect()
		const first = await harness.waitForAnnouncements()
		const { result, context } = await harness.open(first)
		context.onDisconnect = () => void result.surface.close()

		harness.panel.options.topology = ptzExtremeTopology
		harness.panel.dropClients()

		const second = await harness.waitForAnnouncements(2)
		expect(context.calls).toContainEqual(['disconnect', 'Panel topology changed'])
		expect(second.surfaceId).toBe(first.surfaceId)
		expect(second.deviceHandle).not.toBe(first.deviceHandle)
		await expect(harness.open(first)).rejects.toThrow()
		const reopened = await harness.open(second)
		expect(Object.keys(reopened.result.registerProps.surfaceLayout.controls)).toContain('hwc/63')
	})
})

describe('Companion declines or still holds the surface', () => {
	test('asks Companion to drop the surface once, even if the connection is removed before it closes', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect()
		const { context } = await harness.open(await harness.waitForAnnouncements())
		const disconnects = () => context.calls.filter((c) => c[0] === 'disconnect')

		harness.panel.options.topology = ptzExtremeTopology
		harness.panel.dropClients()
		await waitFor(() => disconnects().length > 0, 2000, 'the topology-change disconnect')
		await harness.plugin.remote!.stopConnections(['conn1'])
		await sleep(30)

		expect(disconnects()).toEqual([['disconnect', 'Panel topology changed']])
	})

	test('announces the surface again after Companion rejects it', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect()
		const first = await harness.waitForAnnouncements()

		harness.plugin.remote!.rejectSurface(first)

		const second = await harness.waitForAnnouncements(2)
		expect(second.surfaceId).toBe(first.surfaceId)
		expect(second.deviceHandle).not.toBe(first.deviceHandle)
		await expect(harness.open(first)).rejects.toThrow()
		await harness.open(second)
	})

	test('a panel removed and re-added before its old surface closed comes back once Companion lets it', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect('a')
		const { result: old, context } = await harness.open(await harness.waitForAnnouncements())
		await harness.plugin.remote!.stopConnections(['a'])
		expect(context.calls).toContainEqual(['disconnect', 'Connection removed'])

		// Re-added while Companion still holds the old surface: it rejects the new announcement
		await harness.connect('b')
		const readded = await harness.waitForAnnouncements(2)
		expect(readded.surfaceId).toBe('skaarhoj:442845')
		harness.plugin.remote!.rejectSurface(readded)
		await old.surface.close()

		const back = await harness.waitForAnnouncements(3)
		expect(back.surfaceId).toBe(readded.surfaceId)
		harness.panel.clearReceived()
		await harness.open(back)
		await waitFor(() => harness!.panel.commands.includes('HWC#1=0'), 2000, 'the reopened surface to push state')
	})
})

describe('connections are shared per address and port', () => {
	test('two connection entries for one panel share one TCP connection', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect('a')
		await harness.connect('b')
		await harness.waitForAnnouncements()
		await sleep(50)

		expect(harness.panel.connectionCount).toBe(1)
		expect(harness.announced).toHaveLength(1)

		await harness.plugin.remote!.stopConnections(['a'])
		await sleep(50)
		expect(harness.panel.openClients).toBe(1)

		await harness.plugin.remote!.stopConnections(['b'])
		await waitFor(() => harness!.panel.openClients === 0, 2000, 'the connection to close')
	})

	test('re-saving a connection with the same address and port does not reconnect', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect('a')
		await harness.waitForAnnouncements()

		await harness.connect('a')
		await sleep(50)

		expect(harness.panel.connectionCount).toBe(1)
	})

	test('stopping the last connection disconnects the open surface', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect('a')
		const { context } = await harness.open(await harness.waitForAnnouncements())

		await harness.plugin.remote!.stopConnections(['a'])

		expect(context.calls).toContainEqual(['disconnect', 'Connection removed'])
	})
})

describe('flow control', () => {
	test('holds writes while the panel is busy and sends only the latest per control on RDY', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect()
		const { result } = await harness.open(await harness.waitForAnnouncements())
		await waitFor(() => harness!.panel.commands.includes('HWC#10=0'))
		harness.panel.clearReceived()

		harness.panel.send('BSY')
		await sleep(30)
		const signal = new AbortController().signal
		await result.surface.draw(signal, { controlId: 'hwc/1', color: '#ff0000', pressed: false })
		await result.surface.draw(signal, { controlId: 'hwc/1', color: '#00ff00', pressed: false })
		await result.surface.draw(signal, { controlId: 'hwc/1', color: '#0000ff', pressed: false })
		await sleep(50)
		expect(harness.panel.commands).toEqual([])

		harness.panel.send('RDY')

		await waitFor(() => harness!.panel.commands.includes('HWC#1=4'))
		expect(harness.panel.commands.filter((l) => l.startsWith('HWCc#1='))).toEqual(['HWCc#1=195'])
	})

	test('stops holding writes when the panel stays busy past the busy timeout', async () => {
		harness = new Harness({ topology: smallTopology }, { ...fastTimings, busyTimeoutMs: 150 })
		await harness.start()
		await harness.connect()
		const { result } = await harness.open(await harness.waitForAnnouncements())
		await waitFor(() => harness!.panel.commands.includes('HWC#10=0'))
		harness.panel.clearReceived()

		// The real panel sent neither RDY nor ping of its own in captures
		harness.panel.send('BSY')
		await sleep(30)
		const drawnAt = Date.now()
		await result.surface.draw(new AbortController().signal, { controlId: 'hwc/1', color: '#ff0000', pressed: false })
		await sleep(60)
		expect(harness.panel.commands).toEqual([])

		await waitFor(() => harness!.panel.commands.includes('HWC#1=4'), 2000, 'the held write')
		expect(Date.now() - drawnAt).toBeGreaterThanOrEqual(100)
	})

	test('sends nothing for a draw that does not change what the panel shows', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect()
		const { result } = await harness.open(await harness.waitForAnnouncements())
		await waitFor(() => harness!.panel.commands.includes('HWC#10=0'))
		const signal = new AbortController().signal
		await result.surface.draw(signal, { controlId: 'hwc/1', color: '#ff0000', pressed: false })
		await waitFor(() => harness!.panel.commands.includes('HWC#1=4'))
		harness.panel.clearReceived()

		await result.surface.draw(signal, { controlId: 'hwc/1', color: '#ff0000', pressed: false })
		await sleep(50)

		expect(harness.panel.commands).toEqual([])
	})
})
