/**
 * Opt-in panel settings: the sleep timeout and tying the panel's brightness to Companion's.
 * With defaults, nothing touches the panel's own settings.
 */
import { afterEach, describe, expect, test } from 'vitest'
import type { CompanionInputFieldDropdown } from '@companion-surface/base'
import { Harness } from './helpers/harness.js'
import { sleep, waitFor } from './helpers/timing.js'
import { ptzExtremeTopology } from './fixtures/topologies.js'
import { layoutOf } from './helpers/layout.js'
import { parseSurfaceSettings, surfaceConfigFields } from '../settings.js'
import type { AnalogAxis } from '../topology.js'
import { captureLogs } from './helpers/logs.js'

let harness: Harness | undefined

// Keep the plugin's logs out of the test output
captureLogs()

afterEach(async () => {
	await harness?.stop()
	harness = undefined
})

const settingLines = (lines: string[]) => lines.filter((l) => /^(SleepTimer|PanelBrightness)=/.test(l))

/** Open the surface, then give it `config` and `brightness` as the host does, and settle. */
async function openSurface(config: Record<string, unknown>, brightness = 50) {
	harness = new Harness({ topology: ptzExtremeTopology })
	const { result } = await harness.connectAndOpen()
	await result.surface.updateConfig!(config)
	await result.surface.setBrightness(brightness)
	await harness.settle()
	return { surface: result.surface, result, panel: harness.panel }
}

async function reconnect() {
	const panel = harness!.panel
	const connections = panel.connectionCount
	panel.clearReceived()
	panel.dropClients()
	await waitFor(() => panel.connectionCount > connections && panel.commands.length > 0, 2000, 'reconnect')
	await harness!.settle()
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
		await waitFor(() => settingLines(panel.commands).length > 0, 2000, 'the sleep timeout')
		await harness!.settle()
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
		await waitFor(() => settingLines(panel.commands).at(-1) === 'PanelBrightness=2,2', 2000, 'the brightness')
		expect(settingLines(panel.commands).at(-1)).toBe('PanelBrightness=2,2')

		await reconnect()
		expect(settingLines(panel.commands)).toEqual(['PanelBrightness=2,2'])
	})

	test('turning the brightness link on applies the current brightness at once; off stops sending', async () => {
		const { surface, panel } = await openSurface(defaults, 75)
		expect(settingLines(panel.commands)).toEqual([])

		await surface.updateConfig!({ ...defaults, linkBrightness: true })
		await waitFor(() => settingLines(panel.commands).length > 0, 2000, 'the brightness')
		await harness!.settle()
		expect(settingLines(panel.commands)).toEqual(['PanelBrightness=6,6'])

		panel.clearReceived()
		await surface.updateConfig!(defaults)
		await surface.setBrightness(10)
		await sleep(20)
		expect(settingLines(panel.commands)).toEqual([])
	})

	describe('withdrawn while the panel is busy, before the line went out', () => {
		const led = layoutOf(ptzExtremeTopology).controls.find((c) => c.hasLed)!
		const signal = new AbortController().signal

		/** BSY, run `change`, then RDY; returns the setting lines the panel received meanwhile. */
		async function whileBusy(surface: Awaited<ReturnType<typeof openSurface>>['surface'], change: () => Promise<void>) {
			const panel = harness!.panel
			panel.clearReceived()
			// The panel acknowledges nothing for BSY. Lines are handled in order, so once a key press sent
			// after it reaches Companion, the BSY has been read (a ping would end the hold)
			const context = harness!.contexts[harness!.contexts.length - 1]
			const keys = context.calls.length
			panel.send('BSY', `HWC#${led.hwc}=Down`, `HWC#${led.hwc}=Up`)
			await waitFor(() => context.calls.length >= keys + 2, 2000, 'the BSY to be read')
			await change()
			// A marker queued last, so its arrival shows the queue flushed after RDY
			await surface.draw(signal, { controlId: led.controlId, color: '#ff0000', pressed: false })
			panel.send('RDY')
			await waitFor(() => panel.commands.some((l) => l.startsWith(`HWC#${led.hwc}=`)), 2000, 'the flush on RDY')
			await harness!.settle()
			return settingLines(panel.received)
		}

		test('a sleep timeout set back to "leave the panel\'s setting" is never sent', async () => {
			const { surface } = await openSurface(defaults)

			const sent = await whileBusy(surface, async () => {
				await surface.updateConfig!({ ...defaults, sleepTimer: 300000 })
				await surface.updateConfig!(defaults)
			})

			expect(sent).toEqual([])
		})

		test('brightness linked then unlinked is never sent', async () => {
			const { surface } = await openSurface(defaults, 75)

			const sent = await whileBusy(surface, async () => {
				await surface.updateConfig!({ ...defaults, linkBrightness: true })
				await surface.updateConfig!(defaults)
			})

			expect(sent).toEqual([])
		})
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

// What Companion shows and what the plugin reads: ids, defaults and ranges are stored user settings
const ptzAxes = layoutOf(ptzExtremeTopology).axes
const joystick: AnalogAxis = {
	hwc: 60,
	variableId: 'hwc_60',
	name: 'LR',
	suggestedVariable: 'skaarhoj_lr',
	mode: 'Speed',
}
const fader: AnalogAxis = {
	hwc: 5,
	variableId: 'hwc_5',
	name: 'Fader',
	suggestedVariable: 'skaarhoj_fader',
	mode: 'Abs',
}

describe('surface settings fields', () => {
	test('the PTZ Extreme axes and a fader: ids, types, labels, tooltips, defaults, ranges and order', () => {
		expect(surfaceConfigFields([...ptzAxes, fader])).toMatchInlineSnapshot(`
			[
			  {
			    "id": "presetPage",
			    "label": "PTZ Extreme preset page",
			    "type": "static-text",
			    "value": "A starter page that labels every control on the SK_PTZEXTREMEV2 and shows the joystick and zoom values: [download it from GitHub](https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel/blob/main/presets/ptz-extreme.companionconfig) (Download raw file).

			To use it: create the custom variables listed in this plugin's help, import the file on the Import / Export page into a page of your choice, put the panel on that page, and pick the joystick and zoom variables in these settings.",
			  },
			  {
			    "choices": [
			      {
			        "id": "panel",
			        "label": "Leave the panel's setting",
			      },
			      {
			        "id": 60000,
			        "label": "1 minute",
			      },
			      {
			        "id": 300000,
			        "label": "5 minutes",
			      },
			      {
			        "id": 900000,
			        "label": "15 minutes",
			      },
			      {
			        "id": 1800000,
			        "label": "30 minutes",
			      },
			      {
			        "id": 3600000,
			        "label": "1 hour",
			      },
			      {
			        "id": 7200000,
			        "label": "2 hours",
			      },
			      {
			        "id": 14400000,
			        "label": "4 hours (panel default)",
			      },
			      {
			        "id": 0,
			        "label": "Never (displays may burn in)",
			      },
			    ],
			    "default": "panel",
			    "id": "sleepTimer",
			    "label": "Panel sleep timeout",
			    "tooltip": "Sent to the panel on every connect, since the panel resets it to 4 hours when it restarts. Choosing "Leave the panel's setting" again stops sending it but does not undo a value already sent.",
			    "type": "dropdown",
			  },
			  {
			    "default": false,
			    "id": "linkBrightness",
			    "label": "Set panel brightness from Companion",
			    "tooltip": "Ties the panel's LED and display brightness to this surface's Brightness setting (0-100% becomes the panel's 0-8). Off leaves the panel's brightness alone; turning it off does not undo a value already sent.",
			    "type": "checkbox",
			  },
			  {
			    "default": 50,
			    "id": "analogInterval",
			    "label": "Analog send interval (ms)",
			    "max": 1000,
			    "min": 10,
			    "tooltip": "The shortest time between two values sent for one axis, in milliseconds. Faster moves are combined, always ending on the latest value. 50 ms is about 20 times a second; 10 is the fastest.",
			    "type": "number",
			  },
			  {
			    "default": true,
			    "id": "analogEnabled_58",
			    "label": "Elastomer Zoom Rocker (HWC 58): enabled",
			    "tooltip": "Off: this axis sends nothing to Companion, and a joystick or rocker is set back to 0 when turned off. The panel still reports the axis (Raw Panel has no command to stop it); the plugin ignores it.",
			    "type": "checkbox",
			  },
			  {
			    "default": 6,
			    "id": "analogDeadband_58",
			    "label": "Elastomer Zoom Rocker (HWC 58): dead zone",
			    "max": 100,
			    "min": 0,
			    "tooltip": "In panel steps from 0 (this axis runs -500 to 500). A value this close to 0 reads 0, and a change in the scaled value smaller than this is not sent; 0 and full travel always get through. 0 turns it off and sends every change.",
			    "type": "number",
			  },
			  {
			    "default": 500,
			    "id": "analogSaturation_58",
			    "label": "Elastomer Zoom Rocker (HWC 58): saturation",
			    "max": 500,
			    "min": 100,
			    "tooltip": "In panel steps from 0. A value at or past this reads as full travel (500); between the dead zone and this, the value is scaled linearly to the full range. If the axis stops short of its end (say at 496), set it a step below that. 500 turns it off.",
			    "type": "number",
			  },
			  {
			    "default": true,
			    "id": "analogEnabled_60",
			    "label": "4-Axis Joystick, Left-Right (HWC 60): enabled",
			    "tooltip": "Off: this axis sends nothing to Companion, and a joystick or rocker is set back to 0 when turned off. The panel still reports the axis (Raw Panel has no command to stop it); the plugin ignores it.",
			    "type": "checkbox",
			  },
			  {
			    "default": 6,
			    "id": "analogDeadband_60",
			    "label": "4-Axis Joystick, Left-Right (HWC 60): dead zone",
			    "max": 100,
			    "min": 0,
			    "tooltip": "In panel steps from 0 (this axis runs -500 to 500). A value this close to 0 reads 0, and a change in the scaled value smaller than this is not sent; 0 and full travel always get through. 0 turns it off and sends every change.",
			    "type": "number",
			  },
			  {
			    "default": 500,
			    "id": "analogSaturation_60",
			    "label": "4-Axis Joystick, Left-Right (HWC 60): saturation",
			    "max": 500,
			    "min": 100,
			    "tooltip": "In panel steps from 0. A value at or past this reads as full travel (500); between the dead zone and this, the value is scaled linearly to the full range. If the axis stops short of its end (say at 496), set it a step below that. 500 turns it off.",
			    "type": "number",
			  },
			  {
			    "default": true,
			    "id": "analogEnabled_61",
			    "label": "4-Axis Joystick, Up-Down (HWC 61): enabled",
			    "tooltip": "Off: this axis sends nothing to Companion, and a joystick or rocker is set back to 0 when turned off. The panel still reports the axis (Raw Panel has no command to stop it); the plugin ignores it.",
			    "type": "checkbox",
			  },
			  {
			    "default": 6,
			    "id": "analogDeadband_61",
			    "label": "4-Axis Joystick, Up-Down (HWC 61): dead zone",
			    "max": 100,
			    "min": 0,
			    "tooltip": "In panel steps from 0 (this axis runs -500 to 500). A value this close to 0 reads 0, and a change in the scaled value smaller than this is not sent; 0 and full travel always get through. 0 turns it off and sends every change.",
			    "type": "number",
			  },
			  {
			    "default": 500,
			    "id": "analogSaturation_61",
			    "label": "4-Axis Joystick, Up-Down (HWC 61): saturation",
			    "max": 500,
			    "min": 100,
			    "tooltip": "In panel steps from 0. A value at or past this reads as full travel (500); between the dead zone and this, the value is scaled linearly to the full range. If the axis stops short of its end (say at 496), set it a step below that. 500 turns it off.",
			    "type": "number",
			  },
			  {
			    "default": true,
			    "id": "analogEnabled_62",
			    "label": "4-Axis Joystick, Rotate (HWC 62): enabled",
			    "tooltip": "Off: this axis sends nothing to Companion, and a joystick or rocker is set back to 0 when turned off. The panel still reports the axis (Raw Panel has no command to stop it); the plugin ignores it.",
			    "type": "checkbox",
			  },
			  {
			    "default": 6,
			    "id": "analogDeadband_62",
			    "label": "4-Axis Joystick, Rotate (HWC 62): dead zone",
			    "max": 100,
			    "min": 0,
			    "tooltip": "In panel steps from 0 (this axis runs -500 to 500). A value this close to 0 reads 0, and a change in the scaled value smaller than this is not sent; 0 and full travel always get through. 0 turns it off and sends every change.",
			    "type": "number",
			  },
			  {
			    "default": 500,
			    "id": "analogSaturation_62",
			    "label": "4-Axis Joystick, Rotate (HWC 62): saturation",
			    "max": 500,
			    "min": 100,
			    "tooltip": "In panel steps from 0. A value at or past this reads as full travel (500); between the dead zone and this, the value is scaled linearly to the full range. If the axis stops short of its end (say at 496), set it a step below that. 500 turns it off.",
			    "type": "number",
			  },
			  {
			    "default": true,
			    "id": "analogEnabled_5",
			    "label": "Fader: enabled",
			    "tooltip": "Off: this axis sends nothing to Companion, and a joystick or rocker is set back to 0 when turned off. The panel still reports the axis (Raw Panel has no command to stop it); the plugin ignores it.",
			    "type": "checkbox",
			  },
			  {
			    "default": 6,
			    "id": "analogDeadband_5",
			    "label": "Fader: dead zone",
			    "max": 100,
			    "min": 0,
			    "tooltip": "In panel steps from 0 (this axis runs 0 to 1000). A value this close to 0 reads 0, and a change in the scaled value smaller than this is not sent; 0 and full travel always get through. 0 turns it off and sends every change.",
			    "type": "number",
			  },
			  {
			    "default": 1000,
			    "id": "analogSaturation_5",
			    "label": "Fader: saturation",
			    "max": 1000,
			    "min": 100,
			    "tooltip": "In panel steps from 0. A value at or past this reads as full travel (1000); between the dead zone and this, the value is scaled linearly to the full range. If the axis stops short of its end (say at 996), set it a step below that. 1000 turns it off.",
			    "type": "number",
			  },
			]
		`)
	})
})

describe('analog tuning fields', () => {
	test('a topology without analog controls has only the send interval', () => {
		const plainAxes = layoutOf({
			HWc: [{ id: 1, x: 100, y: 100, txt: 'One', type: 1 }],
			typeIndex: { '1': { w: 100, in: 'b', out: 'rgb' } },
		}).axes
		const analogIds = surfaceConfigFields(plainAxes)
			.filter((f) => f.id.startsWith('analog'))
			.map((f) => f.id)
		expect(analogIds).toEqual(['analogInterval'])
	})
})

describe('reading the surface settings', () => {
	const defaultPanel = { sleepTimerMs: undefined, linkBrightness: false }
	test.each([
		['missing', {}, defaultPanel, 50, { enabled: true, deadband: 6, saturation: 500 }],
		[
			'empty strings',
			{ sleepTimer: '', analogDeadband_60: '', analogSaturation_60: '', analogInterval: '' },
			defaultPanel,
			50,
			{ enabled: true, deadband: 6, saturation: 500 },
		],
		[
			'not numbers',
			{ sleepTimer: 'abc', analogDeadband_60: 'abc', analogSaturation_60: null, analogInterval: null },
			defaultPanel,
			50,
			{ enabled: true, deadband: 6, saturation: 500 },
		],
		[
			'numeric strings',
			{ sleepTimer: '300000', analogDeadband_60: '12', analogSaturation_60: '480', analogInterval: '120' },
			{ sleepTimerMs: 300000, linkBrightness: false },
			120,
			{ enabled: true, deadband: 12, saturation: 480 },
		],
		[
			'below range',
			{ sleepTimer: -1, analogDeadband_60: -5, analogSaturation_60: 3, analogInterval: 0 },
			defaultPanel,
			10,
			{ enabled: true, deadband: 0, saturation: 100 },
		],
		[
			'above range',
			{ analogDeadband_60: 900, analogSaturation_60: 900, analogInterval: 99999 },
			defaultPanel,
			1000,
			{ enabled: true, deadband: 100, saturation: 500 },
		],
		[
			'fractions',
			{ sleepTimer: 1.5, analogDeadband_60: 2.6, analogSaturation_60: 480.4, analogInterval: 75.4 },
			defaultPanel,
			75,
			{ enabled: true, deadband: 3, saturation: 480 },
		],
		[
			'an empty dead zone',
			{ analogDeadband_60: '' },
			defaultPanel,
			50,
			{ enabled: true, deadband: 6, saturation: 500 },
		],
		[
			'saturation not above the dead zone',
			{ analogDeadband_60: 100, analogSaturation_60: 100 },
			defaultPanel,
			50,
			{ enabled: true, deadband: 100, saturation: 500 },
		],
		['enabled true', { analogEnabled_60: true }, defaultPanel, 50, { enabled: true, deadband: 6, saturation: 500 }],
		['enabled false', { analogEnabled_60: false }, defaultPanel, 50, { enabled: false, deadband: 6, saturation: 500 }],
		// Only a real false disables: the checkbox stores a boolean
		[
			'enabled "false"',
			{ analogEnabled_60: 'false' },
			defaultPanel,
			50,
			{ enabled: true, deadband: 6, saturation: 500 },
		],
		[
			'panel settings set',
			{ sleepTimer: 0, linkBrightness: true },
			{ sleepTimerMs: 0, linkBrightness: true },
			50,
			{ enabled: true, deadband: 6, saturation: 500 },
		],
		[
			'panel settings left alone',
			{ sleepTimer: 'panel', linkBrightness: 'true' },
			defaultPanel,
			50,
			{ enabled: true, deadband: 6, saturation: 500 },
		],
	])('%s', (_name, config, panel, intervalMs, axis) => {
		expect(parseSurfaceSettings(config, [joystick])).toEqual({ panel, analog: { intervalMs, axes: { 60: axis } } })
	})

	test('a fader is read on its own scale, 0 to 1000', () => {
		expect(parseSurfaceSettings({}, [fader]).analog).toEqual({
			intervalMs: 50,
			axes: { 5: { enabled: true, deadband: 6, saturation: 1000 } },
		})
		expect(parseSurfaceSettings({ analogSaturation_5: 2000 }, [fader]).analog.axes[5].saturation).toBe(1000)
	})
})
