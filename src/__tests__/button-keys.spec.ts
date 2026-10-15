/**
 * Button presses to Companion key down/up, driven through `ButtonKeys` under fake timers: a four-way
 * button is one key, and its key up waits out the release debounce so a press that briefly lets go of
 * every edge is one press. The wiring between the surface and the keys (settings, link drop, close) is
 * covered end to end in surface.spec.ts.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ButtonKeys, DEFAULT_RELEASE_DEBOUNCE_MS } from '../button-keys.js'

function setup(debounceMs = DEFAULT_RELEASE_DEBOUNCE_MS) {
	const calls: [string, number][] = []
	const keys = new ButtonKeys(
		(hwc) => calls.push(['keyDown', hwc]),
		(hwc) => calls.push(['keyUp', hwc]),
	)
	keys.releaseDebounceMs = debounceMs
	return { keys, calls }
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

test('the default release debounce is 30 ms', () => {
	expect(DEFAULT_RELEASE_DEBOUNCE_MS).toBe(30)
})

test('a four-way release waits out the debounce, then sends key up', () => {
	const { keys, calls } = setup(30)

	keys.button(6, 1, true)
	keys.button(6, 1, false)
	expect(calls).toEqual([['keyDown', 6]])

	vi.advanceTimersByTime(29)
	expect(calls).toEqual([['keyDown', 6]])
	vi.advanceTimersByTime(1)
	expect(calls).toEqual([
		['keyDown', 6],
		['keyUp', 6],
	])
})

test('an edge down within the debounce continues the same press: one key down, one key up', () => {
	const { keys, calls } = setup(30)

	keys.button(6, 1, true)
	keys.button(6, 1, false)
	vi.advanceTimersByTime(20)
	keys.button(6, 8, true)
	vi.advanceTimersByTime(100)
	expect(calls).toEqual([['keyDown', 6]])

	keys.button(6, 8, false)
	vi.advanceTimersByTime(30)
	expect(calls).toEqual([
		['keyDown', 6],
		['keyUp', 6],
	])
})

test('key down is never delayed, and an edge down after the debounce is a new press', () => {
	const { keys, calls } = setup(30)

	keys.button(6, 2, true)
	expect(calls).toEqual([['keyDown', 6]])
	keys.button(6, 2, false)
	vi.advanceTimersByTime(30)
	keys.button(6, 4, true)

	expect(calls).toEqual([
		['keyDown', 6],
		['keyUp', 6],
		['keyDown', 6],
	])
})

test('key down on the first edge, key up only after the last edge lifts', () => {
	const { keys, calls } = setup(30)

	keys.button(6, 1, true)
	keys.button(6, 8, true)
	keys.button(6, 1, false)
	vi.advanceTimersByTime(100)
	expect(calls).toEqual([['keyDown', 6]])

	keys.button(6, 8, false)
	vi.advanceTimersByTime(30)
	expect(calls).toEqual([
		['keyDown', 6],
		['keyUp', 6],
	])
})

test('a debounce of 0 sends key up at once', () => {
	const { keys, calls } = setup(0)

	keys.button(6, 1, true)
	keys.button(6, 1, false)
	keys.button(6, 8, true)

	expect(calls).toEqual([
		['keyDown', 6],
		['keyUp', 6],
		['keyDown', 6],
	])
})

test('a plain button (no edge) is never debounced', () => {
	const { keys, calls } = setup(30)

	keys.button(1, undefined, true)
	keys.button(1, undefined, false)

	expect(calls).toEqual([
		['keyDown', 1],
		['keyUp', 1],
	])
})

test('a release with no press is ignored', () => {
	const { keys, calls } = setup(30)

	keys.button(6, 2, false)
	keys.button(1, undefined, false)
	vi.advanceTimersByTime(100)

	expect(calls).toEqual([])
})

test('each button debounces on its own', () => {
	const { keys, calls } = setup(30)

	keys.button(6, 1, true)
	keys.button(6, 1, false)
	keys.button(7, 1, true)
	vi.advanceTimersByTime(30)

	expect(calls).toEqual([
		['keyDown', 6],
		['keyDown', 7],
		['keyUp', 6],
	])
})

test('a changed debounce applies to the next release; a pending key up keeps its deadline', () => {
	const { keys, calls } = setup(100)

	keys.button(6, 1, true)
	keys.button(6, 1, false)
	keys.releaseDebounceMs = 0
	vi.advanceTimersByTime(99)
	expect(calls).toEqual([['keyDown', 6]])
	vi.advanceTimersByTime(1)
	expect(calls).toEqual([
		['keyDown', 6],
		['keyUp', 6],
	])

	keys.button(6, 1, true)
	keys.button(6, 1, false)
	expect(calls.slice(2)).toEqual([
		['keyDown', 6],
		['keyUp', 6],
	])
})

test('releaseAll sends key up for held and pending keys at once; nothing fires later', () => {
	const { keys, calls } = setup(30)
	keys.button(1, undefined, true)
	keys.button(6, 4, true)
	keys.button(7, 1, true)
	keys.button(7, 1, false)
	calls.length = 0

	keys.releaseAll()
	expect(calls.sort()).toEqual([
		['keyUp', 1],
		['keyUp', 6],
		['keyUp', 7],
	])

	vi.advanceTimersByTime(100)
	keys.button(6, 4, false)
	vi.advanceTimersByTime(100)
	expect(calls).toHaveLength(3)
})

test('stop sends pending key ups at once, forgets held keys and fires nothing later', () => {
	const { keys, calls } = setup(30)
	keys.button(6, 4, true)
	keys.button(7, 1, true)
	keys.button(7, 1, false)
	calls.length = 0

	keys.stop()
	expect(calls).toEqual([['keyUp', 7]])

	vi.advanceTimersByTime(100)
	keys.button(6, 4, false)
	vi.advanceTimersByTime(100)
	expect(calls).toEqual([['keyUp', 7]])
})
