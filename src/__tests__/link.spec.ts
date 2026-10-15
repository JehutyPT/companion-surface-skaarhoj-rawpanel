import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { DetectionSurfaceInfo } from '@companion-surface/base'
import { PanelLink, type LinkTimings, type RawPanelDeviceInfo } from '../link.js'
import { FakeConnection, type FakeIdentity } from './helpers/fake-connection.js'
import { ptzExtremeTopology, smallTopology } from './fixtures/topologies.js'
import { captureLogs } from './helpers/logs.js'

const panel: FakeIdentity = { model: 'SK_PTZEXTREMEV2', serial: '442845', topology: smallTopology }

const logs = captureLogs()

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

/** A started link on an in-memory connection, recording its announcements and events. */
function startLink(timings: Partial<LinkTimings> = {}) {
	const connection = new FakeConnection()
	const announced: DetectionSurfaceInfo<RawPanelDeviceInfo>[] = []
	const link = new PanelLink(connection, '10.0.0.5', 9923, (info) => announced.push(info), new Map(), timings)
	const events: unknown[][] = []
	link.on('input', (event) => events.push(['input', event]))
	link.on('resync', () => events.push(['resync']))
	link.on('offline', () => events.push(['offline']))
	link.on('disconnect', (reason) => events.push(['disconnect', reason]))
	link.start()
	return { connection, link, announced, events }
}

describe('announcing the surface', () => {
	test('announces the surface once when the panel comes online, by serial', () => {
		const { connection, link, announced } = startLink()
		expect(connection.started).toBe(true)

		connection.goOnline(panel)

		expect(announced).toHaveLength(1)
		expect(announced[0].surfaceId).toBe('skaarhoj:442845')
		expect(announced[0].description).toBe('SKAARHOJ SK_PTZEXTREMEV2')
		expect(link.isCurrent(announced[0].pluginInfo)).toBe(true)
	})

	test('uses address and port as the surface id when the panel reports no serial', () => {
		const { connection, announced } = startLink()

		connection.goOnline({ model: 'SK_TEST', topology: smallTopology })

		expect(announced.map((a) => a.surfaceId)).toEqual(['skaarhoj:10.0.0.5:9923'])
	})

	test('a reconnect with the same panel and layout does not announce again; the surface resyncs', () => {
		const { connection, link, announced, events } = startLink()
		connection.goOnline(panel)
		link.attach({ surfaceId: announced[0].surfaceId })

		connection.goOffline()
		connection.goOnline(panel)

		expect(announced).toHaveLength(1)
		expect(link.isCurrent(announced[0].pluginInfo)).toBe(true)
		expect(events).toEqual([['offline'], ['resync']])
	})

	test('a new topology on reconnect replaces the open surface, announcing once the old one closes', () => {
		const { connection, link, announced, events } = startLink()
		connection.goOnline(panel)
		const surface = { surfaceId: announced[0].surfaceId }
		link.attach(surface)

		connection.goOffline()
		connection.goOnline({ ...panel, topology: ptzExtremeTopology })

		expect(events).toContainEqual(['disconnect', 'Panel topology changed'])
		expect(announced).toHaveLength(1)
		expect(link.isCurrent(announced[0].pluginInfo)).toBe(false)

		link.detach(surface)

		expect(announced).toHaveLength(2)
		expect(announced[1].surfaceId).toBe(announced[0].surfaceId)
		expect(announced[1].deviceHandle).not.toBe(announced[0].deviceHandle)
		expect(link.isCurrent(announced[1].pluginInfo)).toBe(true)
		expect(link.layout?.surfaceLayout.controls).toHaveProperty('hwc/63')
	})

	test('a new topology before the surface opened announces the new layout at once', () => {
		const { connection, link, announced, events } = startLink()
		connection.goOnline(panel)

		connection.goOffline()
		connection.goOnline({ ...panel, topology: ptzExtremeTopology })

		expect(announced).toHaveLength(2)
		expect(link.isCurrent(announced[0].pluginInfo)).toBe(false)
		expect(link.isCurrent(announced[1].pluginInfo)).toBe(true)
		expect(events.filter((e) => e[0] === 'disconnect')).toEqual([])
	})
})

describe('Companion rejects the announcement', () => {
	/** Reject the latest announcement and return how long until the next one, in ms (undefined: none within a minute). */
	function rejectAndTime(link: PanelLink, announced: DetectionSurfaceInfo<RawPanelDeviceInfo>[]): number | undefined {
		const count = announced.length
		link.rejected(announced[count - 1].pluginInfo)
		for (let ms = 1; ms <= 60_000; ms++) {
			vi.advanceTimersByTime(1)
			if (announced.length > count) return ms
		}
		return undefined
	}

	test('announces again after 1 s, doubling per rejection, and stops with a warning once the fifth retry is rejected', () => {
		const { connection, link, announced } = startLink()
		connection.goOnline(panel)

		const delays = Array.from({ length: 6 }, () => rejectAndTime(link, announced))

		expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, undefined])
		expect(announced).toHaveLength(6)
		expect(logs.filter((l) => l.level === 'warn' && /rejected .* 6 times in a row/.test(l.message))).toHaveLength(1)
	})

	test('the delay stops doubling at the cap', () => {
		const { connection, link, announced } = startLink({ rejectRetryMs: 100, rejectRetryMaxMs: 300 })
		connection.goOnline(panel)

		const delays = Array.from({ length: 5 }, () => rejectAndTime(link, announced))

		expect(delays).toEqual([100, 200, 300, 300, 300])
	})

	test('a reconnect after the retries stopped announces again, and the backoff starts over', () => {
		const { connection, link, announced } = startLink()
		connection.goOnline(panel)
		for (let n = 0; n < 6; n++) rejectAndTime(link, announced)
		expect(announced).toHaveLength(6)

		connection.goOffline()
		connection.goOnline(panel)

		expect(announced).toHaveLength(7)
		expect(rejectAndTime(link, announced)).toBe(1000)
	})

	test('a surface that opens resets the backoff', () => {
		const { connection, link, announced } = startLink()
		connection.goOnline(panel)
		expect([rejectAndTime(link, announced), rejectAndTime(link, announced)]).toEqual([1000, 2000])
		const surface = { surfaceId: announced[2].surfaceId }

		link.attach(surface)
		link.detach(surface)

		expect(rejectAndTime(link, announced)).toBe(1000)
	})

	test('a rejection of an announcement that is no longer current is ignored', () => {
		const { connection, link, announced } = startLink()
		connection.goOnline(panel)
		rejectAndTime(link, announced)
		expect(announced).toHaveLength(2)

		link.rejected(announced[0].pluginInfo)
		vi.advanceTimersByTime(60_000)

		expect(announced).toHaveLength(2)
		expect(link.isCurrent(announced[1].pluginInfo)).toBe(true)
	})

	test('a retry that comes due while the panel is offline waits for the reconnect, which announces', () => {
		const { connection, link, announced } = startLink()
		connection.goOnline(panel)
		link.rejected(announced[0].pluginInfo)
		connection.goOffline()

		vi.advanceTimersByTime(60_000)
		expect(announced).toHaveLength(1)

		connection.goOnline(panel)
		expect(announced).toHaveLength(2)
	})

	test('stopping the link cancels a pending retry', () => {
		const { connection, link, announced } = startLink()
		connection.goOnline(panel)
		link.rejected(announced[0].pluginInfo)

		link.stop()
		vi.advanceTimersByTime(60_000)

		expect(announced).toHaveLength(1)
		expect(connection.stopped).toBe(true)
	})
})

describe('forwarding to the surface', () => {
	test('panel input goes to the surface; a wake resyncs it; going to sleep does not', () => {
		const { connection, events } = startLink()
		connection.goOnline(panel)

		connection.receive({ type: 'button', hwc: 1, edge: undefined, down: true })
		connection.receive({ type: 'reply', key: 'isSleeping', value: '1' })
		connection.receive({ type: 'reply', key: 'isSleeping', value: '0' })
		connection.receive({ type: 'encoder', hwc: 2, delta: -1 })

		expect(events).toEqual([
			['input', { type: 'button', hwc: 1, edge: undefined, down: true }],
			['resync'],
			['input', { type: 'encoder', hwc: 2, delta: -1 }],
		])
	})

	test('going offline is forwarded, and the surface stays open', () => {
		const { connection, link, announced, events } = startLink()
		connection.goOnline(panel)
		link.attach({ surfaceId: announced[0].surfaceId })

		connection.goOffline()

		expect(events).toEqual([['offline']])
		expect(link.isOnline).toBe(false)
	})

	test('writes and diff resets go to the connection', () => {
		const { connection, link } = startLink()
		connection.goOnline(panel)

		link.write([
			{ key: 'HWCc#1', line: 'HWCc#1=240' },
			{ key: 'HWC#1', line: 'HWC#1=4' },
		])
		link.resetDiffs()

		expect(connection.writes).toEqual([
			['HWCc#1', 'HWCc#1=240'],
			['HWC#1', 'HWC#1=4'],
		])
		expect(connection.resetDiffsCalls).toBe(1)
	})

	test('stopping the link disconnects the open surface and stops the connection', () => {
		const { connection, link, announced, events } = startLink()
		connection.goOnline(panel)
		link.attach({ surfaceId: announced[0].surfaceId })

		link.stop()

		expect(events).toEqual([['disconnect', 'Connection removed']])
		expect(connection.stopped).toBe(true)
		expect(link.isCurrent(announced[0].pluginInfo)).toBe(false)
	})
})
