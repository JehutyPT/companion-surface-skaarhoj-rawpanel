/**
 * Opt-in panel settings: the sleep timeout and tying the panel's brightness to Companion's.
 * With defaults, nothing touches the panel's own settings.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { CompanionInputFieldDropdown, LoggingSink } from '@companion-surface/base'
import { Harness } from './helpers/harness.js'
import { sleep, waitFor } from './helpers/fake-panel.js'
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

const settingLines = (lines: string[]) => lines.filter((l) => /^(SleepTimer|PanelBrightness)=/.test(l))

/** Open the surface the way the host does: config before ready, then brightness. */
async function openSurface(config: Record<string, unknown>, brightness = 50) {
	harness = new Harness({ topology: ptzExtremeTopology })
	await harness.start()
	await harness.connect()
	const { result } = await harness.open(await harness.waitForAnnouncements())
	await result.surface.updateConfig!(config)
	await result.surface.setBrightness(brightness)
	await waitFor(() => harness!.panel.commands.length > 0)
	await sleep(30)
	return { surface: result.surface, result, panel: harness.panel }
}

async function reconnect() {
	const panel = harness!.panel
	const connections = panel.connectionCount
	panel.clearReceived()
	panel.dropClients()
	await waitFor(() => panel.connectionCount > connections && panel.commands.length > 0, 2000, 'reconnect')
	await sleep(30)
}

const defaults = { sleepTimer: 'panel', linkBrightness: false }

describe('panel settings', () => {
	test('are per-surface config fields: sleep timeout leaves the panel alone and brightness is off by default', async () => {
		const { result } = await openSurface(defaults)
		const fields = result.registerProps.configFields ?? []

		expect(result.registerProps.brightness).toBe(true)
		const sleepField = fields.find((f) => f.id === 'sleepTimer') as CompanionInputFieldDropdown
		expect(sleepField.type).toBe('dropdown')
		expect(sleepField.default).toBe('panel')
		expect(sleepField.choices.map((c) => c.id)).toContain(0)
		expect(fields.find((f) => f.id === 'linkBrightness')).toMatchObject({ type: 'checkbox', default: false })
	})

	test('with defaults, no panel setting is ever sent: not on open, brightness change or reconnect', async () => {
		const { surface, panel } = await openSurface(defaults)
		await surface.setBrightness(80)
		await sleep(20)
		expect(settingLines(panel.received)).toEqual([])

		await reconnect()
		await surface.setBrightness(20)
		await sleep(20)

		expect(settingLines(panel.received)).toEqual([])
	})

	test('a sleep timeout is sent when set, and again on every connect', async () => {
		const { surface, panel } = await openSurface(defaults)

		await surface.updateConfig!({ ...defaults, sleepTimer: 300000 })
		await sleep(20)
		expect(settingLines(panel.commands)).toEqual(['SleepTimer=300000'])

		await reconnect()
		expect(settingLines(panel.commands)).toEqual(['SleepTimer=300000'])
	})

	test('"never" sends SleepTimer=0', async () => {
		const { panel } = await openSurface({ ...defaults, sleepTimer: 0 })

		expect(settingLines(panel.commands)).toEqual(['SleepTimer=0'])
	})

	test('linked brightness maps Companion 0-100 to the panel 0-8 for LEDs and displays, and follows changes', async () => {
		const { surface, panel } = await openSurface({ ...defaults, linkBrightness: true }, 50)
		expect(settingLines(panel.commands)).toEqual(['PanelBrightness=4,4'])

		panel.clearReceived()
		await surface.setBrightness(100)
		await surface.setBrightness(30)
		await sleep(20)
		expect(settingLines(panel.commands).at(-1)).toBe('PanelBrightness=2,2')

		await reconnect()
		expect(settingLines(panel.commands)).toEqual(['PanelBrightness=2,2'])
	})

	test('turning the brightness link on applies the current brightness at once; off stops sending', async () => {
		const { surface, panel } = await openSurface(defaults, 75)
		expect(settingLines(panel.commands)).toEqual([])

		await surface.updateConfig!({ ...defaults, linkBrightness: true })
		await sleep(20)
		expect(settingLines(panel.commands)).toEqual(['PanelBrightness=6,6'])

		panel.clearReceived()
		await surface.updateConfig!(defaults)
		await surface.setBrightness(10)
		await sleep(20)
		expect(settingLines(panel.commands)).toEqual([])
	})

	test('a config or brightness change after close sends nothing to the panel', async () => {
		const { surface, panel } = await openSurface({ ...defaults, linkBrightness: true }, 50)
		await surface.close()
		panel.clearReceived()

		await surface.updateConfig!({ sleepTimer: 300000, linkBrightness: true })
		await surface.setBrightness(100)
		await sleep(20)

		expect(settingLines(panel.received)).toEqual([])
	})
})
