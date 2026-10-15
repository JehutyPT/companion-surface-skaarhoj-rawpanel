import {
	createModuleLogger,
	type DetectionSurfaceInfo,
	type RemoteSurfaceConnectionInfo,
	type SomeCompanionInputField,
	type SurfacePluginRemote,
	type SurfacePluginRemoteEvents,
} from '@companion-surface/base'
import EventEmitter from 'node:events'
import { PanelConnection, type ConnectionTimings } from './connection.js'
import {
	CONNECTION_CONFIG_MATCH_EXPRESSION,
	connectionConfigFields,
	parseConnectionSettings,
} from './connection-settings.js'
import { PanelLink, type LinkTimings, type RawPanelDeviceInfo } from './link.js'

/**
 * Companion's remote connections. Several connection entries with the same `address:port` and
 * control map share one link, ref-counted, so editing an unrelated field (or adding a duplicate)
 * does not reconnect. The control map is part of the link's identity: the layout is fixed when
 * the surface opens, so saving a different map stops the old link and starts a new one.
 */
export class RawPanelPluginRemoteService
	extends EventEmitter<SurfacePluginRemoteEvents<RawPanelDeviceInfo>>
	implements SurfacePluginRemote<RawPanelDeviceInfo>
{
	readonly #logger = createModuleLogger('RemoteService')
	readonly #timings: Partial<ConnectionTimings>
	readonly #linkTimings: Partial<LinkTimings>

	/** connectionId -> address:port key */
	readonly #activeConnections = new Map<string, string>()
	/** address:port key -> link and reference count */
	readonly #links = new Map<string, { link: PanelLink; refs: number }>()

	#initialised = false
	/** Announcements made before init() resolved; emitting them earlier would lose them */
	readonly #queued: DetectionSurfaceInfo<RawPanelDeviceInfo>[] = []

	constructor(timings: Partial<ConnectionTimings> = {}, linkTimings: Partial<LinkTimings> = {}) {
		super()
		this.#timings = timings
		this.#linkTimings = linkTimings
	}

	readonly configFields: SomeCompanionInputField[] = connectionConfigFields()

	readonly checkConfigMatchesExpression: string | null = CONNECTION_CONFIG_MATCH_EXPRESSION

	async init(): Promise<void> {
		this.#initialised = true
		const queued = this.#queued.splice(0)
		if (queued.length) this.emit('surfacesConnected', queued)
	}

	async destroy(): Promise<void> {
		for (const { link } of this.#links.values()) link.stop()
		this.#links.clear()
		this.#activeConnections.clear()
		this.#initialised = false
	}

	async startConnections(connectionInfos: RemoteSurfaceConnectionInfo[]): Promise<void> {
		this.#logger.info(`Starting connections: ${connectionInfos.map((c) => c.connectionId).join(', ')}`)

		const invalidIds: string[] = []
		for (const info of connectionInfos) {
			const settings = parseConnectionSettings(info.config)
			if (!settings.valid) {
				invalidIds.push(info.connectionId)
				continue
			}

			const { address, port, controlMap, linkKey, warnings } = settings
			const oldKey = this.#activeConnections.get(info.connectionId)
			if (oldKey === linkKey) continue
			if (oldKey !== undefined) this.#release(oldKey)
			for (const warning of warnings) this.#logger.warn(warning)

			this.#activeConnections.set(info.connectionId, linkKey)
			const entry = this.#links.get(linkKey)
			if (entry) {
				entry.refs++
			} else {
				const connection = new PanelConnection(address, port, this.#timings)
				const link = new PanelLink(
					connection,
					address,
					port,
					(surface) => this.#announce(surface),
					controlMap,
					this.#linkTimings,
				)
				this.#links.set(linkKey, { link, refs: 1 })
				link.start()
			}
		}

		if (invalidIds.length > 0) await this.stopConnections(invalidIds)
	}

	async stopConnections(connectionIds: string[]): Promise<void> {
		this.#logger.info(`Stopping connections: ${connectionIds.join(', ')}`)
		for (const connectionId of connectionIds) {
			const key = this.#activeConnections.get(connectionId)
			if (key === undefined) continue
			this.#activeConnections.delete(connectionId)
			this.#release(key)
		}
	}

	rejectSurface(surfaceInfo: DetectionSurfaceInfo<RawPanelDeviceInfo>): void {
		// Companion may still hold a surface with this id (removed and re-added before it closed):
		// the link announces again after a backoff.
		surfaceInfo.pluginInfo.link.rejected(surfaceInfo.pluginInfo)
	}

	#release(key: string): void {
		const entry = this.#links.get(key)
		if (!entry) return
		entry.refs--
		if (entry.refs > 0) return
		this.#links.delete(key)
		entry.link.stop()
	}

	#announce(surface: DetectionSurfaceInfo<RawPanelDeviceInfo>): void {
		if (!this.#initialised) {
			this.#queued.push(surface)
			return
		}
		this.emit('surfacesConnected', [surface])
	}
}
