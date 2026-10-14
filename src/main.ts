import type { OpenSurfaceResult, SurfaceContext, SurfacePlugin } from '@companion-surface/base'
import { RawPanelPluginRemoteService } from './remote.js'

export interface RawPanelDeviceInfo {
	address: string
	port: number
}

const RawPanelPlugin: SurfacePlugin<RawPanelDeviceInfo> = {
	remote: new RawPanelPluginRemoteService(),

	init: async (): Promise<void> => {
		// Nothing to do
	},
	destroy: async (): Promise<void> => {
		// Nothing to do
	},

	openSurface: async (
		_surfaceId: string,
		_pluginInfo: RawPanelDeviceInfo,
		_context: SurfaceContext,
	): Promise<OpenSurfaceResult> => {
		throw new Error('Not implemented')
	},
}

export default RawPanelPlugin
