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
import { formatControlMap, parseControlMap } from './control-map.js'
import { PanelLink, type LinkTimings, type RawPanelDeviceInfo } from './link.js'

export const DEFAULT_TCP_PORT = 9923

export interface RawPanelConnectionConfig {
	address: string
	port: number
	/** Custom control positions, `<hwc>=<row>/<column>, ...` (see `control-map.ts`) */
	controlMap?: string
}

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
		{
			id: 'controlMap',
			type: 'textinput',
			label: 'Control positions',
			default: '',
			tooltip:
				'Optional. Move controls on the Companion grid: <HWC>=<row>/<column>, separated by commas, e.g. 37=1/5, 38=1/6. Rows and columns start at 0 (top left). Unlisted controls keep their automatic position. Saving reconnects the panel.',
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

			const { map, warnings } = parseControlMap(config.controlMap)
			const mapKey = formatControlMap(map)
			const key = mapKey ? `${address}:${port}|${mapKey}` : `${address}:${port}`
			const oldKey = this.#activeConnections.get(info.connectionId)
			if (oldKey === key) continue
			if (oldKey !== undefined) this.#release(oldKey)
			for (const warning of warnings) this.#logger.warn(warning)

			this.#activeConnections.set(info.connectionId, key)
			const entry = this.#links.get(key)
			if (entry) {
				entry.refs++
			} else {
				const connection = new PanelConnection(address, port, this.#timings)
				const link = new PanelLink(
					connection,
					address,
					port,
					(surface) => this.#announce(surface),
					map,
					this.#linkTimings,
				)
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
