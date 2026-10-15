/**
 * Raw Panel ASCII v1 encoding, tested directly: `parseLine` for panel input, `ledCommands` and
 * `textCommand` for drawing. surface.spec.ts checks draws and key presses travel end to end.
 */
import { describe, expect, test } from 'vitest'
import { ledCommands, parseLine, textCommand } from '../protocol.js'

describe('parsing panel lines', () => {
	test.each([
		['ack', { type: 'ack' }],
		['ping', { type: 'ping' }],
		['BSY', { type: 'busy' }],
		['RDY', { type: 'ready' }],
		['_isSleeping=1', { type: 'reply', key: 'isSleeping', value: '1' }],
		['_panelTopology_HWC={"a":"b=c"}', { type: 'reply', key: 'panelTopology_HWC', value: '{"a":"b=c"}' }],
		['HWC#1=Down', { type: 'button', hwc: 1, edge: undefined, down: true }],
		['HWC#1=Up', { type: 'button', hwc: 1, edge: undefined, down: false }],
		['HWC#6.8=Down', { type: 'button', hwc: 6, edge: 8, down: true }],
		['HWC#6.1=Up', { type: 'button', hwc: 6, edge: 1, down: false }],
		['HWC#10=Press', { type: 'press', hwc: 10 }],
		['HWC#10=Enc:1', { type: 'encoder', hwc: 10, delta: 1 }],
		['HWC#10=Enc:-3', { type: 'encoder', hwc: 10, delta: -3 }],
		['HWC#60=Speed:-500', { type: 'analog', hwc: 60, mode: 'Speed', value: -500 }],
		['HWC#11=Abs:500', { type: 'analog', hwc: 11, mode: 'Abs', value: 500 }],
	])('%s', (line, event) => {
		expect(parseLine(line)).toEqual(event)
	})

	test.each([
		'nack',
		'HWC#1=Sideways',
		'_noequals',
		'_=x',
		'HWC#1=Down:1',
		'HWC#10.1=Enc:1',
		'HWC#10=Enc',
		'HWC#10.2=Press',
	])('%s is unknown', (line) => {
		expect(parseLine(line)).toEqual({ type: 'unknown', line })
	})

	test.each(['map=37:37', 'map=1:0'])('%s carries nothing for the plugin: no event, not unknown', (line) => {
		expect(parseLine(line)).toBeUndefined()
	})
})

describe('LED commands', () => {
	const lines = (...args: Parameters<typeof ledCommands>) => ledCommands(...args).map((c) => c.line)

	test('a colour lights the LED in the nearest of the 64 panel colours', () => {
		// r=3, g=2, b=0: 192 + (3<<4 | 2<<2 | 0) = 248
		expect(lines(1, '#ff8000', false)).toEqual(['HWCc#1=248', 'HWC#1=4'])
		expect(lines(1, '#ff0000', false)).toEqual(['HWCc#1=240', 'HWC#1=4'])
		expect(lines(1, '#0000ff', false)).toEqual(['HWCc#1=195', 'HWC#1=4'])
	})

	test('black, no colour or an unreadable colour turns the LED off', () => {
		expect(lines(1, '#000000', false)).toEqual(['HWC#1=0'])
		expect(lines(1, undefined, false)).toEqual(['HWC#1=0'])
		expect(lines(1, 'red', false)).toEqual(['HWC#1=0'])
	})

	test('pressed shows a lit button dimmed and an unlit button white', () => {
		expect(lines(1, '#ff0000', true)).toEqual(['HWCc#1=240', 'HWC#1=5'])
		expect(lines(2, '#000000', true)).toEqual(['HWCc#2=130', 'HWC#2=4'])
	})

	test('each command is keyed by what it sets, so a newer one replaces an older one', () => {
		expect(ledCommands(7, '#ff0000', false).map((c) => c.key)).toEqual(['HWCc#7', 'HWC#7'])
		expect(ledCommands(7, '#000000', false).map((c) => c.key)).toEqual(['HWC#7'])
	})
})

describe('text commands', () => {
	const line = (text: string | undefined, hwc = 10) => textCommand(hwc, text).line

	test('empty text clears the display', () => {
		expect(line('')).toBe('HWCt#10=||||||')
		expect(line(undefined)).toBe('HWCt#10=||||||')
	})

	test('the command is keyed by its HWC, so a newer text replaces an older one', () => {
		expect(textCommand(10, 'x').key).toBe('HWCt#10')
	})

	test('one line of text is shown as one big line', () => {
		expect(line('CAM 1')).toBe('HWCt#10=1|10||CAM 1')
	})

	test('two lines of text are shown as two lines; further lines are dropped', () => {
		expect(line('Line one\nLine two\nLine three')).toBe('HWCt#10=1|11|||1|Line one|Line two')
	})

	test('escaped line breaks and tabs in text are read the way Companion renders them', () => {
		expect(line('Line one\\nLine two')).toBe('HWCt#10=1|11|||1|Line one|Line two')
		expect(line('Up\\rDown')).toBe('HWCt#10=1|11|||1|Up|Down')
		expect(line('CAM\\t1')).toBe('HWCt#10=1|10||CAM 1')
		expect(line('Real\r\nbreak')).toBe('HWCt#10=1|11|||1|Real|break')
	})

	test('an escaped CRLF in text is one line break', () => {
		expect(line('Line one\\r\\nLine two')).toBe('HWCt#10=1|11|||1|Line one|Line two')
	})

	test('text is cleaned of pipes and non-ASCII', () => {
		expect(line('Câm | 1 ✓', 6)).toBe('HWCt#6=1|10||Cm  1')
	})

	test('a line is cut to 24 characters', () => {
		expect(line('ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe('HWCt#10=1|10||ABCDEFGHIJKLMNOPQRSTUVWX')
	})

	test('two long lines are cut to fit the 63-character command, the second line first', () => {
		const sent = line('ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz')

		expect(sent).toBe('HWCt#10=1|11|||1|ABCDEFGHIJKLMNOPQRSTUVWX|abcdefghijklmnopqrstu')
		expect(sent.length).toBe(63)
	})
})
