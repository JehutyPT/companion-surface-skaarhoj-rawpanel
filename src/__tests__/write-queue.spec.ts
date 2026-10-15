import { createModuleLogger } from '@companion-surface/base'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WriteQueue } from '../write-queue.js'

const INTERVAL = 20
const BURST = 8
const BUSY_TIMEOUT = 1000

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

/** A queue whose sends are recorded: `bursts` holds each call, `sent` every line in order. */
function makeQueue() {
	const bursts: string[][] = []
	const queue = new WriteQueue(
		(lines) => bursts.push(lines),
		{ writeIntervalMs: INTERVAL, writeBurst: BURST, busyTimeoutMs: BUSY_TIMEOUT },
		createModuleLogger('WriteQueueTest'),
	)
	return { queue, bursts, sent: () => bursts.flat() }
}

describe('pacing', () => {
	test('a write to an idle queue goes out on the next timer turn, not after an interval', () => {
		const { queue, sent } = makeQueue()

		queue.write('HWC#1', 'HWC#1=4')
		expect(sent()).toEqual([])
		vi.advanceTimersByTime(0)

		expect(sent()).toEqual(['HWC#1=4'])
	})

	test('writes made in the same tick share one burst, in the order they were written', () => {
		const { queue, bursts } = makeQueue()

		queue.write('HWCc#1', 'HWCc#1=240')
		queue.write('HWC#1', 'HWC#1=4')
		vi.advanceTimersByTime(0)

		expect(bursts).toEqual([['HWCc#1=240', 'HWC#1=4']])
	})

	test('sends at most one burst of writeBurst lines per interval', () => {
		const { queue, bursts } = makeQueue()
		const lines = Array.from({ length: 20 }, (_, i) => `HWC#${i + 1}=4`)

		lines.forEach((line, i) => queue.write(`HWC#${i + 1}`, line))
		vi.advanceTimersByTime(0)
		expect(bursts).toEqual([lines.slice(0, BURST)])
		vi.advanceTimersByTime(INTERVAL - 1)
		expect(bursts).toHaveLength(1)
		vi.advanceTimersByTime(1)
		expect(bursts).toEqual([lines.slice(0, BURST), lines.slice(BURST, 2 * BURST)])
		vi.advanceTimersByTime(INTERVAL)

		expect(bursts).toEqual([lines.slice(0, BURST), lines.slice(BURST, 2 * BURST), lines.slice(2 * BURST)])
	})

	test('a write soon after a burst waits out the rest of the interval', () => {
		const { queue, sent } = makeQueue()
		queue.write('HWC#1', 'HWC#1=4')
		vi.advanceTimersByTime(0)
		vi.advanceTimersByTime(5)

		queue.write('HWC#2', 'HWC#2=4')
		vi.advanceTimersByTime(INTERVAL - 5 - 1)
		expect(sent()).toEqual(['HWC#1=4'])
		vi.advanceTimersByTime(1)

		expect(sent()).toEqual(['HWC#1=4', 'HWC#2=4'])
	})

	test('a write after a quiet interval goes out at once again', () => {
		const { queue, sent } = makeQueue()
		queue.write('HWC#1', 'HWC#1=4')
		vi.advanceTimersByTime(INTERVAL)

		queue.write('HWC#2', 'HWC#2=4')
		vi.advanceTimersByTime(0)

		expect(sent()).toEqual(['HWC#1=4', 'HWC#2=4'])
	})
})

describe('coalescing and diffing', () => {
	test('sends only the latest pending line per key, in the order keys were last written', () => {
		const { queue, sent } = makeQueue()

		queue.write('HWC#1', 'HWC#1=4')
		queue.write('HWC#2', 'HWC#2=4')
		queue.write('HWC#1', 'HWC#1=5')
		vi.advanceTimersByTime(0)

		expect(sent()).toEqual(['HWC#2=4', 'HWC#1=5'])
	})

	test('drops a line equal to the last one sent for its key', () => {
		const { queue, sent } = makeQueue()
		queue.write('HWC#1', 'HWC#1=4')
		vi.advanceTimersByTime(INTERVAL)

		queue.write('HWC#1', 'HWC#1=4')
		vi.advanceTimersByTime(INTERVAL)

		expect(sent()).toEqual(['HWC#1=4'])
	})

	test('a key changed and changed back before the flush sends nothing', () => {
		const { queue, sent } = makeQueue()
		queue.write('HWC#1', 'HWC#1=4')
		vi.advanceTimersByTime(INTERVAL)

		queue.write('HWC#1', 'HWC#1=5')
		queue.write('HWC#1', 'HWC#1=4')
		vi.advanceTimersByTime(INTERVAL)

		expect(sent()).toEqual(['HWC#1=4'])
	})

	test('after resetDiffs, a line equal to the last one sent goes out again', () => {
		const { queue, sent } = makeQueue()
		queue.write('HWC#1', 'HWC#1=4')
		vi.advanceTimersByTime(INTERVAL)

		queue.resetDiffs()
		queue.write('HWC#1', 'HWC#1=4')
		vi.advanceTimersByTime(INTERVAL)

		expect(sent()).toEqual(['HWC#1=4', 'HWC#1=4'])
	})
})

describe('discarding', () => {
	test("a discarded key's pending line is never sent; other keys are", () => {
		const { queue, sent } = makeQueue()
		queue.setBusy(true)
		queue.write('SleepTimer', 'SleepTimer=300000')
		queue.write('HWC#1', 'HWC#1=4')

		queue.discard('SleepTimer')
		queue.setBusy(false)
		vi.advanceTimersByTime(0)

		expect(sent()).toEqual(['HWC#1=4'])
	})

	test('a line already sent stays sent: the same line again is still dropped', () => {
		const { queue, sent } = makeQueue()
		queue.write('SleepTimer', 'SleepTimer=300000')
		vi.advanceTimersByTime(0)

		queue.discard('SleepTimer')
		queue.write('SleepTimer', 'SleepTimer=300000')
		vi.advanceTimersByTime(INTERVAL)

		expect(sent()).toEqual(['SleepTimer=300000'])
	})
})

describe('BSY / RDY', () => {
	test('holds writes while busy and sends the latest per key once ready', () => {
		const { queue, sent } = makeQueue()
		queue.setBusy(true)

		queue.write('HWC#1', 'HWC#1=4')
		queue.write('HWC#1', 'HWC#1=5')
		vi.advanceTimersByTime(BUSY_TIMEOUT - 1)
		expect(sent()).toEqual([])
		queue.setBusy(false)
		vi.advanceTimersByTime(0)

		expect(sent()).toEqual(['HWC#1=5'])
	})

	test('holds a burst already scheduled when the panel turns busy', () => {
		const { queue, sent } = makeQueue()
		queue.write('HWC#1', 'HWC#1=4')
		queue.setBusy(true)
		vi.advanceTimersByTime(BUSY_TIMEOUT - 1)
		expect(sent()).toEqual([])

		queue.setBusy(false)
		vi.advanceTimersByTime(0)

		expect(sent()).toEqual(['HWC#1=4'])
	})

	test('resumes on its own busyTimeoutMs after BSY when nothing says ready', () => {
		const { queue, sent } = makeQueue()
		queue.setBusy(true)
		queue.write('HWC#1', 'HWC#1=4')

		vi.advanceTimersByTime(BUSY_TIMEOUT - 1)
		expect(sent()).toEqual([])
		// The timeout ends the hold; the flush it schedules runs on the next timer turn, 1 ms on
		vi.advanceTimersByTime(2)

		expect(sent()).toEqual(['HWC#1=4'])
	})

	test('a repeated BSY restarts the busy timeout', () => {
		const { queue, sent } = makeQueue()
		queue.setBusy(true)
		queue.write('HWC#1', 'HWC#1=4')
		vi.advanceTimersByTime(BUSY_TIMEOUT / 2)

		queue.setBusy(true)
		vi.advanceTimersByTime(BUSY_TIMEOUT - 1)
		expect(sent()).toEqual([])
		// The timeout ends the hold; the flush it schedules runs on the next timer turn, 1 ms on
		vi.advanceTimersByTime(2)

		expect(sent()).toEqual(['HWC#1=4'])
	})
})

describe('reset', () => {
	test('drops pending lines and cancels a scheduled burst', () => {
		const { queue, sent } = makeQueue()
		queue.write('HWC#1', 'HWC#1=4')

		queue.reset()
		vi.advanceTimersByTime(BUSY_TIMEOUT)

		expect(sent()).toEqual([])
	})

	test('a line pending before the reset does not go out with the next write', () => {
		const { queue, sent } = makeQueue()
		queue.write('HWC#1', 'HWC#1=4')

		queue.reset()
		queue.write('HWC#2', 'HWC#2=4')
		vi.advanceTimersByTime(0)

		expect(sent()).toEqual(['HWC#2=4'])
	})

	test('forgets what was sent, the busy hold and the last burst time', () => {
		const { queue, sent } = makeQueue()
		queue.write('HWC#1', 'HWC#1=4')
		vi.advanceTimersByTime(0)
		queue.setBusy(true)

		queue.reset()
		queue.write('HWC#1', 'HWC#1=4')
		vi.advanceTimersByTime(0)

		expect(sent()).toEqual(['HWC#1=4', 'HWC#1=4'])
	})
})
