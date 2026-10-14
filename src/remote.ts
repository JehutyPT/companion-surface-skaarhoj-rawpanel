import {
	createModuleLogger,
	type DetectionSurfaceInfo,
	type RemoteSurfaceConnectionInfo,
	type SomeCompanionInputField,
	type SurfacePluginRemote,
	type SurfacePluginRemoteEvents,
} from '@companion-surface/base'
import EventEmitter from 'node:events'
import type { RawPanelDeviceInfo } from './main.js'

export const DEFAULT_TCP_PORT = 9923

export interface RawPanelConnectionConfig {
	address: string
	port: number
}

export class RawPanelPluginRemoteService
	extends EventEmitter<SurfacePluginRemoteEvents<RawPanelDeviceInfo>>
	implements SurfacePluginRemote<RawPanelDeviceInfo>
{
	readonly #logger = createModuleLogger('RemoteService')

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

	async startConnections(connectionInfos: RemoteSurfaceConnectionInfo[]): Promise<void> {
		this.#logger.info(`Starting connections: ${connectionInfos.map((c) => c.connectionId).join(', ')}`)
	}

	async stopConnections(connectionIds: string[]): Promise<void> {
		this.#logger.info(`Stopping connections: ${connectionIds.join(', ')}`)
	}

	rejectSurface(_surfaceInfo: DetectionSurfaceInfo<RawPanelDeviceInfo>): void {
		// Nothing to clean up yet
	}
}
