/**
 * Per-surface settings that change the panel's own settings. All opt-in: with the defaults the
 * plugin never sends `SleepTimer=` or `PanelBrightness=`.
 */
import type { SomeCompanionInputField } from '@companion-surface/base'
import type { PanelCommand } from './protocol.js'

/** Dropdown value meaning "leave the panel's sleep timer alone" */
const SLEEP_TIMER_UNCHANGED = 'panel'

const MINUTE = 60_000

export const surfaceConfigFields: SomeCompanionInputField[] = [
	{
		id: 'sleepTimer',
		type: 'dropdown',
		label: 'Panel sleep timeout',
		tooltip:
			'Sent to the panel on every connect, since the panel resets it to 4 hours when it restarts. Choosing "Leave the panel\'s setting" again stops sending it but does not undo a value already sent.',
		default: SLEEP_TIMER_UNCHANGED,
		choices: [
			{ id: SLEEP_TIMER_UNCHANGED, label: "Leave the panel's setting" },
			{ id: 1 * MINUTE, label: '1 minute' },
			{ id: 5 * MINUTE, label: '5 minutes' },
			{ id: 15 * MINUTE, label: '15 minutes' },
			{ id: 30 * MINUTE, label: '30 minutes' },
			{ id: 60 * MINUTE, label: '1 hour' },
			{ id: 120 * MINUTE, label: '2 hours' },
			{ id: 240 * MINUTE, label: '4 hours (panel default)' },
			{ id: 0, label: 'Never (displays may burn in)' },
		],
	},
	{
		id: 'linkBrightness',
		type: 'checkbox',
		label: 'Set panel brightness from Companion',
		tooltip:
			"Ties the panel's LED and display brightness to this surface's Brightness setting (0-100% becomes the panel's 0-8). Off leaves the panel's brightness alone; turning it off does not undo a value already sent.",
		default: false,
	},
]

export interface PanelSettings {
	/** Sleep timeout in ms (0 = never), or undefined to leave the panel's alone */
	sleepTimerMs: number | undefined
	linkBrightness: boolean
}

export const DEFAULT_PANEL_SETTINGS: PanelSettings = { sleepTimerMs: undefined, linkBrightness: false }

export function parsePanelSettings(config: Record<string, unknown>): PanelSettings {
	return { sleepTimerMs: parseSleepTimer(config.sleepTimer), linkBrightness: config.linkBrightness === true }
}

/** A sleep timeout in ms (0 = never), or undefined for "leave the panel's setting" or anything invalid. */
function parseSleepTimer(value: unknown): number | undefined {
	if (typeof value !== 'number' && typeof value !== 'string') return undefined
	if (value === SLEEP_TIMER_UNCHANGED || value === '') return undefined
	const ms = Number(value)
	return Number.isInteger(ms) && ms >= 0 ? ms : undefined
}

/** `SleepTimer=<ms>`; the panel echoes `_sleepTimer=<ms>`. */
function sleepTimerCommand(ms: number): PanelCommand {
	return { key: 'SleepTimer', line: `SleepTimer=${ms}` }
}

/** `PanelBrightness=<leds>,<displays>`, each 0-8, from Companion's 0-100. */
function panelBrightnessCommand(percent: number): PanelCommand {
	const level = Math.max(0, Math.min(8, Math.round((percent / 100) * 8)))
	return { key: 'PanelBrightness', line: `PanelBrightness=${level},${level}` }
}

/** The setting commands to send on connect and when a setting changes. */
export function settingCommands(settings: PanelSettings, brightnessPercent: number | undefined): PanelCommand[] {
	const commands: PanelCommand[] = []
	if (settings.sleepTimerMs !== undefined) commands.push(sleepTimerCommand(settings.sleepTimerMs))
	if (settings.linkBrightness && brightnessPercent !== undefined) {
		commands.push(panelBrightnessCommand(brightnessPercent))
	}
	return commands
}
