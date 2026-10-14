import { afterEach, describe, expect, test } from 'vitest'
import { PanelConnection } from '../connection.js'
import { fastTimings } from './helpers/harness.js'
import { FakeRawPanel, sleep, waitFor } from './helpers/fake-panel.js'
import { smallTopology } from './fixtures/topologies.js'

/** Long enough that a write held for a full interval is clearly distinguishable from one sent at once. */
const INTERVAL = 300

let panel: FakeRawPanel | undefined
let connection: PanelConnection | undefined

afterEach(async () => {
	connection?.stop()
	connection = undefined
	await panel?.close()
	panel = undefined
})

/** Connect `panel` and `connection` and let the write queue go idle. */
async function connectIdle(): Promise<void> {
	panel = new FakeRawPanel({ topology: smallTopology })
	await panel.listen()
	connection = new PanelConnection('127.0.0.1', panel.port, {
		...fastTimings,
		pingIntervalMs: 1000,
		livenessTimeoutMs: 5000,
		writeIntervalMs: INTERVAL,
		writeBurst: 8,
	})
	const online = new Promise<void>((resolve) => connection!.once('online', () => resolve()))
	connection.start()
	await online
	// Let the queue go idle for longer than one interval
	await sleep(INTERVAL + 50)
}

describe('write pacing', () => {
	test('a write to an idle queue goes out at once, not after a full interval', async () => {
		await connectIdle()
		const start = Date.now()
		connection!.write('HWC#1', 'HWC#1=4')
		await waitFor(() => panel!.commands.includes('HWC#1=4'), 2000, 'the write')
		expect(Date.now() - start).toBeLessThan(INTERVAL / 2)
	})

	test('never sends more than one burst per interval', async () => {
		await connectIdle()
		for (let i = 1; i <= 20; i++) connection!.write(`HWC#${i}`, `HWC#${i}=4`)
		await sleep(INTERVAL / 3)
		expect(panel!.commands).toEqual(Array.from({ length: 8 }, (_, i) => `HWC#${i + 1}=4`))
		await sleep(INTERVAL)
		expect(panel!.commands).toHaveLength(16)
		await waitFor(() => panel!.commands.length === 20, 2000, 'the rest')
		expect(panel!.commands).toEqual(Array.from({ length: 20 }, (_, i) => `HWC#${i + 1}=4`))
	})

	test('a write soon after a leading-edge write waits for the interval and is coalesced per key', async () => {
		await connectIdle()
		connection!.write('HWC#1', 'HWC#1=4')
		await waitFor(() => panel!.commands.length === 1)
		await sleep(INTERVAL / 6)
		connection!.write('HWC#2', 'HWC#2=4')
		connection!.write('HWC#2', 'HWC#2=5')
		await sleep(INTERVAL / 3)
		expect(panel!.commands).toEqual(['HWC#1=4'])
		await waitFor(() => panel!.commands.length === 2, 2000, 'the paced write')
		expect(panel!.commands).toEqual(['HWC#1=4', 'HWC#2=5'])
	})

	test('an idle-queue write is held while the panel is busy', async () => {
		await connectIdle()
		panel!.send('BSY')
		await sleep(30)
		connection!.write('HWC#1', 'HWC#1=4')
		await sleep(50)
		expect(panel!.commands).toEqual([])
		panel!.send('RDY')
		await waitFor(() => panel!.commands.includes('HWC#1=4'), 2000, 'the held write')
	})

	test('a fresh link starts with an idle queue, even right after a write on the old one', async () => {
		await connectIdle()
		connection!.write('HWC#1', 'HWC#1=4')
		await waitFor(() => panel!.commands.length === 1)
		const online = new Promise<void>((resolve) => connection!.once('online', () => resolve()))
		panel!.dropClients()
		await online
		const start = Date.now()
		connection!.write('HWC#1', 'HWC#1=4')
		await waitFor(() => panel!.commands.includes('HWC#1=4'), 2000, 'the write on the new link')
		expect(Date.now() - start).toBeLessThan(INTERVAL / 2)
	})
})
