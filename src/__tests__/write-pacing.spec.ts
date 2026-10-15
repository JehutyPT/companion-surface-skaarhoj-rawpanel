import { afterEach, describe, expect, test } from 'vitest'
import { PanelConnection } from '../connection.js'
import { fastTimings } from './helpers/harness.js'
import { FakeRawPanel } from './helpers/fake-panel.js'
import { waitFor } from './helpers/timing.js'
import { smallTopology } from './fixtures/topologies.js'

let panel: FakeRawPanel | undefined
let connection: PanelConnection | undefined

afterEach(async () => {
	connection?.stop()
	connection = undefined
	await panel?.close()
	panel = undefined
})

/** Connect `panel` and `connection`. The pacing rules themselves are in `write-queue.spec.ts`, on fake timers. */
async function connect(): Promise<void> {
	panel = new FakeRawPanel({ topology: smallTopology })
	await panel.listen()
	connection = new PanelConnection('127.0.0.1', panel.port, {
		...fastTimings,
		pingIntervalMs: 1000,
		livenessTimeoutMs: 5000,
	})
	const online = new Promise<void>((resolve) => connection!.once('online', () => resolve()))
	connection.start()
	await online
}

describe('writes over TCP', () => {
	test('reach the panel coalesced per key, in the order keys were last written', async () => {
		await connect()

		connection!.write('HWC#1', 'HWC#1=4')
		connection!.write('HWC#2', 'HWC#2=4')
		connection!.write('HWC#1', 'HWC#1=5')

		await waitFor(() => panel!.commands.length === 2, 2000, 'the writes')
		expect(panel!.commands).toEqual(['HWC#2=4', 'HWC#1=5'])
	})

	test('a reconnect forgets what was sent before it', async () => {
		await connect()
		connection!.write('HWC#1', 'HWC#1=4')
		await waitFor(() => panel!.commands.length === 1)
		const online = new Promise<void>((resolve) => connection!.once('online', () => resolve()))
		panel!.dropClients()
		await online

		connection!.write('HWC#1', 'HWC#1=4')

		// `commands` holds only the new connection's lines
		await waitFor(() => panel!.commands.includes('HWC#1=4'), 2000, 'the write after the reconnect')
		expect(panel!.connectionCount).toBe(2)
	})
})
