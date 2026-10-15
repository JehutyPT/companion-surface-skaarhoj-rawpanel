/**
 * A PanelLink is one panel at one `address:port`: it drives the connection it is given and decides when
 * Companion is told about the surface. The surface is announced once per link; reconnects with the
 * same panel and layout are absorbed here (the open surface re-pushes its state), and only a
 * changed panel or layout replaces the surface. If Companion rejects an announcement (typically
 * because it still holds a surface with the same id, e.g. the connection was removed and re-added
 * before the old surface closed), the link announces again after a backoff until one is opened.
 */
import { createModuleLogger, type DetectionSurfaceInfo, type ModuleLogger } from '@companion-surface/base'
import { randomUUID } from 'node:crypto'
import EventEmitter from 'node:events'
import type { PanelConnectionEvents, PanelIdentity } from './connection.js'
import type { ControlMap } from './control-map.js'
import type { PanelCommand, PanelEvent } from './protocol.js'
import { buildLayout, type PanelLayout, type Topology } from './topology.js'

/**
 * Announce again at most this many times after consecutive rejections (1 + 2 + 4 + 8 + 16 s by
 * default, ample for Companion to close an old surface). A rejection that persists (surface
 * declined, or two connections reaching the same panel) then stops until the panel reconnects.
 */
const MAX_REJECT_RETRIES = 5

/**
 * What the link uses of its connection (see `PanelConnection` for the contract of each member).
 * Production passes the TCP `PanelConnection`; link tests pass an in-memory one.
 */
export interface LinkConnection {
	readonly isOnline: boolean
	start(): void
	stop(): void
	write(key: string, line: string): void
	resetDiffs(): void
	on<E extends keyof PanelConnectionEvents>(event: E, listener: (...args: PanelConnectionEvents[E]) => void): unknown
}

export interface LinkTimings {
	/** First delay before announcing the surface again after Companion rejects it; doubles per rejection */
	rejectRetryMs: number
	/** Cap on that delay (the default matches the connection's reconnect backoff cap) */
	rejectRetryMaxMs: number
}

const DEFAULT_LINK_TIMINGS: LinkTimings = {
	rejectRetryMs: 1000,
	rejectRetryMaxMs: 30000,
}

export interface RawPanelDeviceInfo {
	link: PanelLink
	/** The handle this announcement was made with; stale once the link re-announces */
	deviceHandle: string
}

export interface PanelLinkEvents {
	/** An input event for the open surface */
	input: [event: PanelEvent]
	/** The panel blanked itself (reconnect or wake) and the connection has forgotten what it sent: push all state */
	resync: []
	/** The link went down; the surface stays open while it reconnects */
	offline: []
	/** The open surface must go: the panel or its layout changed, or the connection was removed */
	disconnect: [reason: string]
}

export interface PanelSurfaceHandle {
	readonly surfaceId: string
}

export class PanelLink extends EventEmitter<PanelLinkEvents> {
	readonly address: string
	readonly port: number
	readonly #connection: LinkConnection
	readonly #announce: (info: DetectionSurfaceInfo<RawPanelDeviceInfo>) => void
	readonly #logger: ModuleLogger
	readonly #timings: LinkTimings
	readonly #loggedUnknown = new Set<string>()
	readonly #controlMap: ControlMap
	readonly #loggedMapNotes = new Set<string>()

	#stopped = false
	#surfaceId: string | undefined
	#description = ''
	#layout: PanelLayout | undefined
	#deviceHandle: string | undefined
	#surface: PanelSurfaceHandle | undefined
	#reannounceOnClose = false
	#rejectTimer: NodeJS.Timeout | undefined
	#rejectRetryMs: number
	#rejections = 0

	constructor(
		connection: LinkConnection,
		address: string,
		port: number,
		announce: (info: DetectionSurfaceInfo<RawPanelDeviceInfo>) => void,
		controlMap: ControlMap = new Map(),
		timings: Partial<LinkTimings> = {},
	) {
		super()
		this.address = address
		this.port = port
		this.#controlMap = controlMap
		this.#announce = announce
		this.#timings = { ...DEFAULT_LINK_TIMINGS, ...timings }
		this.#rejectRetryMs = this.#timings.rejectRetryMs
		this.#logger = createModuleLogger(`Link/${address}:${port}`)
		this.#connection = connection
		this.#connection.on('online', (identity) => this.#onOnline(identity))
		this.#connection.on('offline', () => this.emit('offline'))
		this.#connection.on('event', (event) => {
			if (event.type === 'reply' && event.key === 'isSleeping') {
				if (event.value === '0') this.#resync()
				return
			}
			this.emit('input', event)
		})
	}

	/** Product name for Companion, e.g. `SKAARHOJ SK_PTZEXTREMEV2` */
	get description(): string {
		return this.#description
	}

	get layout(): PanelLayout | undefined {
		return this.#layout
	}

	get isOnline(): boolean {
		return this.#connection.isOnline
	}

	start(): void {
		this.#connection.start()
	}

	stop(): void {
		if (this.#stopped) return
		this.#stopped = true
		this.#reannounceOnClose = false
		clearTimeout(this.#rejectTimer)
		this.#connection.stop()
		this.#deviceHandle = undefined
		if (this.#surface) this.emit('disconnect', 'Connection removed')
	}

	/** Whether `info` is the current announcement of a running link, i.e. still safe to open. */
	isCurrent(info: RawPanelDeviceInfo): boolean {
		return !this.#stopped && info.deviceHandle === this.#deviceHandle && this.#layout !== undefined
	}

	/**
	 * Called by the surface instance when it opens. Forgets what was sent, so the new surface's
	 * first push all goes out even if an earlier surface sent the same lines.
	 */
	attach(surface: PanelSurfaceHandle): void {
		this.#surface = surface
		this.#connection.resetDiffs()
		this.#resetRejections()
	}

	/**
	 * Companion rejected the announcement `info`. Announce again after a delay that doubles per
	 * rejection, up to `MAX_REJECT_RETRIES` times; a rejection of an announcement that is no longer
	 * current is ignored.
	 */
	rejected(info: RawPanelDeviceInfo): void {
		if (this.#stopped || this.#surface || info.deviceHandle !== this.#deviceHandle) return
		this.#deviceHandle = undefined
		if (++this.#rejections > MAX_REJECT_RETRIES) {
			this.#logger.warn(
				`Companion rejected surface ${this.#surfaceId} ${this.#rejections} times in a row; not announcing it again until the panel reconnects`,
			)
			return
		}
		const delay = this.#rejectRetryMs
		this.#rejectRetryMs = Math.min(delay * 2, this.#timings.rejectRetryMaxMs)
		this.#logger.info(`Companion rejected surface ${this.#surfaceId}; announcing it again in ${delay} ms`)
		clearTimeout(this.#rejectTimer)
		this.#rejectTimer = setTimeout(() => {
			// A reconnect meanwhile announces by itself (no current handle), so check before announcing.
			if (this.#stopped || this.#surface || this.#deviceHandle !== undefined || !this.#connection.isOnline) return
			this.#doAnnounce()
		}, delay)
	}

	/** Called by the surface instance when it closes. */
	detach(surface: PanelSurfaceHandle): void {
		if (this.#surface !== surface) return
		this.#surface = undefined
		if (this.#reannounceOnClose && !this.#stopped && this.#connection.isOnline) {
			this.#reannounceOnClose = false
			this.#doAnnounce()
		}
	}

	write(commands: PanelCommand[]): void {
		for (const command of commands) this.#connection.write(command.key, command.line)
	}

	#resetRejections(): void {
		clearTimeout(this.#rejectTimer)
		this.#rejections = 0
		this.#rejectRetryMs = this.#timings.rejectRetryMs
	}

	#onOnline(identity: PanelIdentity): void {
		const surfaceId = identity.serial ? `skaarhoj:${identity.serial}` : `skaarhoj:${this.address}:${this.port}`
		this.#logUnknownControls(identity.topology)
		const layout = buildLayout(identity.topology, this.#controlMap)
		for (const note of layout.mapNotes) {
			if (this.#loggedMapNotes.has(note)) continue
			this.#loggedMapNotes.add(note)
			this.#logger.warn(note)
		}
		const samePanelAndLayout = surfaceId === this.#surfaceId && layout.signature === this.#layout?.signature

		this.#surfaceId = surfaceId
		this.#description = `SKAARHOJ ${identity.model ?? 'Raw Panel'}`
		this.#layout = layout

		if (this.#deviceHandle === undefined) {
			this.#resetRejections()
			this.#doAnnounce()
		} else if (samePanelAndLayout) {
			this.#resync()
		} else if (this.#surface) {
			// Companion still holds the old surface until it closes it; announce the new one after that.
			this.#logger.info(`Panel or layout changed on reconnect; replacing surface ${surfaceId}`)
			this.#reannounceOnClose = true
			this.#deviceHandle = undefined
			this.emit('disconnect', 'Panel topology changed')
		} else {
			this.#doAnnounce()
		}
	}

	/** The panel blanked itself: forget what was sent, so the surface's full push all goes out. */
	#resync(): void {
		this.#connection.resetDiffs()
		this.emit('resync')
	}

	#doAnnounce(): void {
		if (!this.#surfaceId || !this.#layout) return
		const deviceHandle = randomUUID()
		this.#deviceHandle = deviceHandle
		this.#announce({
			deviceHandle,
			surfaceId: this.#surfaceId,
			description: this.#description,
			pluginInfo: { link: this, deviceHandle },
		})
	}

	#logUnknownControls(topology: Topology): void {
		for (const control of topology.controls) {
			if (control.kind !== 'unknown') continue
			const key = `${control.hwc}:${control.input}`
			if (this.#loggedUnknown.has(key)) continue
			this.#loggedUnknown.add(key)
			this.#logger.warn(`Skipping HWC ${control.hwc} (${control.label}): unknown input type '${control.input}'`)
		}
	}
}
