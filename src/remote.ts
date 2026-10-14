import {
	createModuleLogger,
	type DetectionSurfaceInfo,
	type RemoteSurfaceConnectionInfo,
	type SomeCompanionInputField,
	type SurfacePluginRemote,
	type SurfacePluginRemoteEvents,
} from '@companion-surface/base'
import EventEmitter from 'node:events'
import type { ConnectionTimings } from './connection.js'
import { PanelLink, type RawPanelDeviceInfo } from './link.js'

export const DEFAULT_TCP_PORT = 9923

export interface RawPanelConnectionConfig {
	address: string
	port: number
}

/**
 * Companion's remote connections. Several connection entries may point at the same
 * `address:port`; they share one link, ref-counted, so editing an unrelated field (or adding a
 * duplicate) does not reconnect.
 */
export class RawPanelPluginRemoteService
	extends EventEmitter<SurfacePluginRemoteEvents<RawPanelDeviceInfo>>
	implements SurfacePluginRemote<RawPanelDeviceInfo>
{
	readonly #logger = createModuleLogger('RemoteService')
	readonly #timings: Partial<ConnectionTimings>

	/** connectionId -> address:port key */
	readonly #activeConnections = new Map<string, string>()
	/** address:port key -> link and reference count */
	readonly #links = new Map<string, { link: PanelLink; refs: number }>()

	#initialised = false
	/** Announcements made before init() resolved; emitting them earlier would lose them */
	readonly #queued: DetectionSurfaceInfo<RawPanelDeviceInfo>[] = []

	constructor(timings: Partial<ConnectionTimings> = {}) {
		super()
		this.#timings = timings
	}

	readonly configFields: SomeCompanionInputField[] = [
		{
			id: 'address',
			type: 'textinput',
			label: 'IP Address',
			default: '',
		},
		{
			id: 'port',
			type: 'number',
			label: 'Port',
			default: DEFAULT_TCP_PORT,
			min: 1,
			max: 65535,
		},
	]

	readonly checkConfigMatchesExpression: string | null =
		'$(objA:address) == $(objB:address) && $(objA:port) == $(objB:port)'

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
			const config = info.config as Partial<RawPanelConnectionConfig>
			const address = typeof config.address === 'string' ? config.address.trim() : ''
			const port = Number(config.port ?? DEFAULT_TCP_PORT)
			if (!address || !Number.isInteger(port) || port < 1 || port > 65535) {
				invalidIds.push(info.connectionId)
				continue
			}

			const key = `${address}:${port}`
			const oldKey = this.#activeConnections.get(info.connectionId)
			if (oldKey === key) continue
			if (oldKey !== undefined) this.#release(oldKey)

			this.#activeConnections.set(info.connectionId, key)
			const entry = this.#links.get(key)
			if (entry) {
				entry.refs++
			} else {
				const link = new PanelLink(address, port, this.#timings, (surface) => this.#announce(surface))
				this.#links.set(key, { link, refs: 1 })
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
