/**
 * A PanelLink is one panel at one `address:port`: it owns the connection and decides when
 * Companion is told about the surface. The surface is announced once per link; reconnects with the
 * same panel and layout are absorbed here (the open surface re-pushes its state), and only a
 * changed panel or layout replaces the surface. If Companion rejects an announcement (typically
 * because it still holds a surface with the same id, e.g. the connection was removed and re-added
 * before the old surface closed), the link announces again after a backoff until one is opened.
 */
import { createModuleLogger, type DetectionSurfaceInfo, type ModuleLogger } from '@companion-surface/base'
import { randomUUID } from 'node:crypto'
import EventEmitter from 'node:events'
import { DEFAULT_TIMINGS, PanelConnection, type ConnectionTimings, type PanelIdentity } from './connection.js'
import type { PanelCommand, PanelEvent } from './protocol.js'
import { buildLayout, type PanelLayout, type Topology } from './topology.js'

export interface RawPanelDeviceInfo {
	link: PanelLink
	/** The handle this announcement was made with; stale once the link re-announces */
	deviceHandle: string
}

export interface PanelLinkEvents {
	/** An input event for the open surface */
	input: [event: PanelEvent]
	/** The panel blanked itself (reconnect or wake): push all state */
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
	readonly #connection: PanelConnection
	readonly #announce: (info: DetectionSurfaceInfo<RawPanelDeviceInfo>) => void
	readonly #logger: ModuleLogger
	readonly #timings: ConnectionTimings
	readonly #loggedUnknown = new Set<string>()

	#stopped = false
	#surfaceId: string | undefined
	#description = ''
	#layout: PanelLayout | undefined
	#deviceHandle: string | undefined
	#surface: PanelSurfaceHandle | undefined
	#reannounceOnClose = false
	#rejectTimer: NodeJS.Timeout | undefined
	#rejectRetryMs: number

	constructor(
		address: string,
		port: number,
		timings: Partial<ConnectionTimings>,
		announce: (info: DetectionSurfaceInfo<RawPanelDeviceInfo>) => void,
	) {
		super()
		this.address = address
		this.port = port
		this.#announce = announce
		this.#timings = { ...DEFAULT_TIMINGS, ...timings }
		this.#rejectRetryMs = this.#timings.rejectRetryMs
		this.#logger = createModuleLogger(`Link/${address}:${port}`)
		this.#connection = new PanelConnection(address, port, this.#timings)
		this.#connection.on('online', (identity) => this.#onOnline(identity))
		this.#connection.on('offline', () => this.emit('offline'))
		this.#connection.on('event', (event) => {
			if (event.type === 'reply' && event.key === 'isSleeping') {
				if (event.value === '0') this.emit('resync')
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

	/** Called by the surface instance when it opens. */
	attach(surface: PanelSurfaceHandle): void {
		this.#surface = surface
		clearTimeout(this.#rejectTimer)
		this.#rejectRetryMs = this.#timings.rejectRetryMs
	}

	/**
	 * Companion rejected the announcement `info`. Announce again after a delay that doubles per
	 * rejection; a rejection of an announcement that is no longer current is ignored.
	 */
	rejected(info: RawPanelDeviceInfo): void {
		if (this.#stopped || this.#surface || info.deviceHandle !== this.#deviceHandle) return
		this.#deviceHandle = undefined
		const delay = this.#rejectRetryMs
		this.#rejectRetryMs = Math.min(delay * 2, this.#timings.backoffMaxMs)
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

	/** Forget what was sent, so the next writes all go out (the panel blanked itself). */
	resetDiffs(): void {
		this.#connection.resetDiffs()
	}

	write(commands: PanelCommand[]): void {
		for (const command of commands) this.#connection.write(command.key, command.line)
	}

	#onOnline(identity: PanelIdentity): void {
		const surfaceId = identity.serial ? `skaarhoj:${identity.serial}` : `skaarhoj:${this.address}:${this.port}`
		this.#logUnknownControls(identity.topology)
		const layout = buildLayout(identity.topology)
		const samePanelAndLayout = surfaceId === this.#surfaceId && layout.signature === this.#layout?.signature

		this.#surfaceId = surfaceId
		this.#description = `SKAARHOJ ${identity.model ?? 'Raw Panel'}`
		this.#layout = layout

		if (this.#deviceHandle === undefined) {
			this.#doAnnounce()
		} else if (samePanelAndLayout) {
			this.emit('resync')
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
