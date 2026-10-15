/**
 * Raw Panel ASCII v1: parsing inbound lines and encoding outbound commands.
 * See docs/raw-panel-protocol.md.
 */

/** `Speed` (intensity: joystick, rocker, -500..500, rests at 0) or `Abs` (absolute: fader, T-bar, 0..1000) */
export type AnalogMode = 'Speed' | 'Abs'

export type PanelEvent =
	/** `_key=value` reply or unsolicited state, split on the first `=` */
	| { type: 'reply'; key: string; value: string }
	/** `HWC#n=Down|Up` or the four-way form `HWC#n.edge=Down|Up` */
	| { type: 'button'; hwc: number; edge: number | undefined; down: boolean }
	/** `HWC#n=Press`, the encoder push on firmware without the blue pill */
	| { type: 'press'; hwc: number }
	/** `HWC#n=Enc:±d` */
	| { type: 'encoder'; hwc: number; delta: number }
	/** `HWC#n=Speed:v` or `HWC#n=Abs:v` */
	| { type: 'analog'; hwc: number; mode: AnalogMode; value: number }
	| { type: 'ack' }
	| { type: 'ping' }
	| { type: 'busy' }
	| { type: 'ready' }
	| { type: 'unknown'; line: string }

// [LIB] ^HWC#([0-9]+)(|.([0-9]+))=(Down|Up|Press|Abs|Speed|Enc)(|:([-0-9,]+))$
const HWC_EVENT = /^HWC#(\d+)(?:\.(\d+))?=(Down|Up|Press|Abs|Speed|Enc)(?::(-?\d+))?$/
/** `map=<hwc>:<n>`, sent per input HWC on every connect; the plugin takes its controls from the topology instead. */
const MAP = /^map=\d+:\d+$/

/**
 * The event a panel line carries, or undefined for a line that carries nothing for the plugin
 * (`map=`), so it is neither an event nor unknown.
 */
export function parseLine(line: string): PanelEvent | undefined {
	switch (line) {
		case 'ack':
			return { type: 'ack' }
		case 'ping':
			return { type: 'ping' }
		case 'BSY':
			return { type: 'busy' }
		case 'RDY':
			return { type: 'ready' }
	}

	if (line.startsWith('_')) {
		const eq = line.indexOf('=')
		if (eq > 1) return { type: 'reply', key: line.slice(1, eq), value: line.slice(eq + 1) }
		return { type: 'unknown', line }
	}

	if (MAP.test(line)) return undefined

	const m = HWC_EVENT.exec(line)
	if (!m) return { type: 'unknown', line }
	const hwc = Number(m[1])
	const edge = m[2] === undefined ? undefined : Number(m[2])
	const action = m[3]
	const arg = m[4] === undefined ? undefined : Number(m[4])

	switch (action) {
		case 'Down':
		case 'Up':
			if (arg !== undefined) break
			return { type: 'button', hwc, edge, down: action === 'Down' }
		case 'Press':
			if (arg !== undefined || edge !== undefined) break
			return { type: 'press', hwc }
		case 'Enc':
			if (arg === undefined || edge !== undefined) break
			return { type: 'encoder', hwc, delta: arg }
		case 'Speed':
		case 'Abs':
			if (arg === undefined || edge !== undefined) break
			return { type: 'analog', hwc, mode: action, value: arg }
	}
	return { type: 'unknown', line }
}

/** A queued command: `key` names what it sets, so newer lines for the same key replace older ones. */
export interface PanelCommand {
	key: string
	line: string
}

/** LED state values (`HWC#n=`) */
const LED_OFF = 0
const LED_ON = 4
const LED_DIMMED = 5
/** `HWCc#n=` indexed white, used for pressed feedback on an unlit button */
const COLOR_WHITE = 128 + 2

function channel(hex: string): number {
	const value = parseInt(hex, 16)
	return Number.isFinite(value) ? Math.max(0, Math.min(255, value)) : 0
}

/** Parse `#rrggbb`. Anything else is black. */
function parseHexColor(color: string | undefined): { r: number; g: number; b: number } {
	if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return { r: 0, g: 0, b: 0 }
	return { r: channel(color.slice(1, 3)), g: channel(color.slice(3, 5)), b: channel(color.slice(5, 7)) }
}

/** `HWCc#` value for an RGB colour: `192 + (r<<4 | g<<2 | b)`, 2 bits per channel. */
function quantiseColor(r: number, g: number, b: number): number {
	return 192 + (((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6))
}

/**
 * LED commands for a control: black or no colour is off; any other colour is on in that colour.
 * Pressed shows dimmed in the colour, or white if the button is unlit.
 */
export function ledCommands(hwc: number, color: string | undefined, pressed: boolean): PanelCommand[] {
	const { r, g, b } = parseHexColor(color)
	const lit = r > 0 || g > 0 || b > 0
	const stateKey = `HWC#${hwc}`
	const colorKey = `HWCc#${hwc}`
	if (!lit && !pressed) return [{ key: stateKey, line: `${stateKey}=${LED_OFF}` }]
	const colorValue = lit ? quantiseColor(r, g, b) : COLOR_WHITE
	const state = lit && pressed ? LED_DIMMED : LED_ON
	return [
		{ key: colorKey, line: `${colorKey}=${colorValue}` },
		{ key: stateKey, line: `${stateKey}=${state}` },
	]
}

/** Longest `HWCt` command, whole line included. */
const MAX_TEXT_COMMAND_LENGTH = 63
/** Longest title or text line on a display. */
const MAX_TEXT_LINE_LENGTH = 24

function sanitiseTextLine(line: string): string {
	// Printable ASCII only; `|` separates fields and cannot be escaped.
	return line
		.replace(/[^\x20-\x7e]/g, '')
		.replace(/\|/g, '')
		.trim()
		.slice(0, MAX_TEXT_LINE_LENGTH)
}

/**
 * Companion keeps escapes typed into button text (`\n`, `\r`, `\t`) as literal two-character
 * sequences and only converts them when it renders (RenderThread.js). Do the same: they become a
 * line break or a space; an escaped `\r\n` is one line break. A real `\r\n` needs nothing here: it
 * splits on `\n` and the sanitiser drops the `\r`.
 */
function unescapeCompanionText(text: string): string {
	return text.replaceAll('\\r\\n', '\n').replaceAll('\\n', '\n').replaceAll('\\r', '\n').replaceAll('\\t', ' ')
}

/**
 * Display command for Companion button text. One line renders as one big line, two or more as
 * two small lines (extra lines are dropped); empty text clears the display.
 */
export function textCommand(hwc: number, text: string | undefined): PanelCommand {
	const key = `HWCt#${hwc}`
	const lines = unescapeCompanionText(text ?? '')
		.split('\n')
		.map(sanitiseTextLine)
	while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

	if (lines.length === 0) return { key, line: `${key}=||||||` }
	if (lines.length === 1) return { key, line: `${key}=1|10||${lines[0]}` }

	const prefix = `${key}=1|11|||1|`
	let [first, second] = lines
	const overflow = () => prefix.length + first.length + 1 + second.length - MAX_TEXT_COMMAND_LENGTH
	if (overflow() > 0) second = second.slice(0, Math.max(0, second.length - overflow()))
	if (overflow() > 0) first = first.slice(0, Math.max(0, first.length - overflow()))
	return { key, line: `${prefix}${first}|${second}` }
}
