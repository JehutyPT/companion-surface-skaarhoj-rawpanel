/**
 * Connection settings: the remote connection config fields (address, port, control positions) and
 * reading one remote connection entry's config into valid connection settings or a rejection.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { LoggingSink } from '@companion-surface/base'
import { Harness } from './helpers/harness.js'
import { sleep, waitFor } from './helpers/fake-panel.js'
import { smallTopology } from './fixtures/topologies.js'
import { createRawPanelPlugin } from '../main.js'
import { parseConnectionSettings } from '../connection-settings.js'

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

/** The parsed settings for a valid config; fails the test on a rejection. */
function valid(config: Record<string, unknown>) {
	const settings = parseConnectionSettings(config)
	if (!settings.valid) throw new Error(`expected ${JSON.stringify(config)} to be valid`)
	return settings
}

describe('reading a connection config', () => {
	test('trims the address', () => {
		expect(valid({ address: '  10.0.0.5 ', port: 9923 }).address).toBe('10.0.0.5')
	})

	test.each([
		['empty', ''],
		['whitespace-only', ' \t '],
		['missing', undefined],
		['a number', 10],
		['null', null],
	])('rejects an address that is %s', (_name, address) => {
		expect(parseConnectionSettings({ address, port: 9923 })).toEqual({ valid: false })
	})

	test.each([
		['missing', {}],
		['null', { port: null }],
	])('a %s port defaults to 9923', (_name, port) => {
		expect(valid({ address: '10.0.0.5', ...port }).port).toBe(9923)
	})

	test('accepts a whole port, and a numeric string as Companion may store it', () => {
		expect(valid({ address: '10.0.0.5', port: 1 }).port).toBe(1)
		expect(valid({ address: '10.0.0.5', port: 65535 }).port).toBe(65535)
		expect(valid({ address: '10.0.0.5', port: '9924' }).port).toBe(9924)
	})

	test.each([
		['0', 0],
		['65536', 65536],
		['an empty string', ''],
		['not whole', 9923.5],
		['not a number', 'abc'],
	])('rejects a port that is %s', (_name, port) => {
		expect(parseConnectionSettings({ address: '10.0.0.5', port })).toEqual({ valid: false })
	})

	test('without control positions, the link key is address:port and the control map is empty', () => {
		const settings = valid({ address: '10.0.0.5', port: 9923 })
		expect(settings.linkKey).toBe('10.0.0.5:9923')
		expect(settings.controlMap.size).toBe(0)
		expect(settings.warnings).toEqual([])
	})

	test('reads the control positions into the control map', () => {
		const { controlMap } = valid({ address: '10.0.0.5', port: 9923, controlMap: '37=1/5, 38=1/6' })
		expect([...controlMap]).toEqual([
			[37, { row: 1, column: 5 }],
			[38, { row: 1, column: 6 }],
		])
	})

	test('control positions written with different whitespace or separators give the same link key', () => {
		const a = valid({ address: '10.0.0.5', port: 9923, controlMap: '37=1/5, 38=1/6' }).linkKey
		const b = valid({ address: ' 10.0.0.5', port: '9923', controlMap: ' 37 = 1/5 ;\n38=1/6' }).linkKey
		expect(b).toBe(a)
		expect(a).not.toBe('10.0.0.5:9923')
	})

	test('different control positions or ports give different link keys', () => {
		const base = valid({ address: '10.0.0.5', port: 9923, controlMap: '37=1/5' }).linkKey
		expect(valid({ address: '10.0.0.5', port: 9923, controlMap: '37=1/6' }).linkKey).not.toBe(base)
		expect(valid({ address: '10.0.0.5', port: 9924, controlMap: '37=1/5' }).linkKey).not.toBe(base)
	})

	test('malformed control-position entries are skipped with a warning each', () => {
		const settings = valid({ address: '10.0.0.5', port: 9923, controlMap: '1=0/1, x=1/2, 1=2/2' })
		expect([...settings.controlMap]).toEqual([[1, { row: 0, column: 1 }]])
		expect(settings.warnings).toHaveLength(2)
		expect(settings.warnings[0]).toContain("'x=1/2'")
		expect(settings.warnings[1]).toMatch(/HWC 1 is listed more than once/)
	})
})

describe('the remote and invalid connection settings', () => {
	test.each([
		['an empty address', { address: '  ' }],
		['an out-of-range port', { port: 0 }],
	])('a connection entry re-saved with %s stops the link it held and starts none', async (_name, invalid) => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()
		await harness.connect('a')
		await harness.waitForAnnouncements()

		await harness.connect('a', invalid)

		await waitFor(() => harness!.panel.openClients === 0, 2000, 'the connection to close')
		await sleep(50)
		expect(harness.panel.connectionCount).toBe(1)
	})
	test('a new connection entry with invalid settings starts no link', async () => {
		harness = new Harness({ topology: smallTopology })
		await harness.start()

		await harness.connect('a', { address: '' })
		await sleep(50)

		expect(harness.panel.connectionCount).toBe(0)
		expect(harness.announced).toHaveLength(0)
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
