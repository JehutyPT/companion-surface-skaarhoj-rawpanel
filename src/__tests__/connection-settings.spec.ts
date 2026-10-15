/**
 * Connection settings: the remote connection config fields (address, port, control positions) and
 * reading one connection's config into a valid connection or a rejection.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { LoggingSink } from '@companion-surface/base'
import { Harness } from './helpers/harness.js'
import { sleep, waitFor } from './helpers/fake-panel.js'
import { smallTopology } from './fixtures/topologies.js'
import { createRawPanelPlugin } from '../main.js'

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

const warnings = () => logs.filter((l) => l.level === 'warn').map((l) => l.message)

describe('connection settings fields', () => {
	// Characterization: written before connection settings left the remote, and unchanged by the move.
	test('Companion shows address, port and control positions, unchanged', () => {
		const remote = createRawPanelPlugin().remote!
		expect(remote.configFields).toEqual([
			{ id: 'address', type: 'textinput', label: 'IP Address', default: '' },
			{ id: 'port', type: 'number', label: 'Port', default: 9923, min: 1, max: 65535 },
			{
				id: 'controlMap',
				type: 'textinput',
				label: 'Control positions',
				default: '',
				tooltip:
					'Optional. Move controls on the Companion grid: <HWC>=<row>/<column>, separated by commas, e.g. 37=1/5, 38=1/6. Rows and columns start at 0 (top left). Unlisted controls keep their automatic position. Saving reconnects the panel.',
			},
		])
		expect(remote.checkConfigMatchesExpression).toBe(
			'$(objA:address) == $(objB:address) && $(objA:port) == $(objB:port)',
		)
	})
})

describe('the remote and invalid connections', () => {
	test.each([
		['an empty address', { address: '  ' }],
		['an out-of-range port', { port: 0 }],
	])('a connection saved with %s stops the link it held and starts none', async (_name, invalid) => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect('a')
		await harness.waitForAnnouncements()

		await harness.connect('a', invalid)

		await waitFor(() => harness!.panel.openClients === 0, 2000, 'the connection to close')
		await sleep(50)
		expect(harness.panel.connectionCount).toBe(1)
	})
})

describe('control-position warnings', () => {
	test('are logged when a connection starts, and not again when it is re-saved unchanged', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect('a', { controlMap: '1=0/1, x=1/2' })
		await harness.waitForAnnouncements()
		await harness.connect('a', { controlMap: '1=0/1; x=1/2' })
		await sleep(30)

		expect(warnings().filter((w) => w.includes("'x=1/2'"))).toHaveLength(1)
	})
})
