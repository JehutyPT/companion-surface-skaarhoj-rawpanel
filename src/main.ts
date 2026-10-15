import {
	createModuleLogger,
	type OpenSurfaceResult,
	type SurfaceContext,
	type SurfacePlugin,
} from '@companion-surface/base'
import type { ConnectionTimings } from './connection.js'
import { RawPanelSurface } from './instance.js'
import type { LinkTimings, RawPanelDeviceInfo } from './link.js'
import { RawPanelPluginRemoteService } from './remote.js'
import { surfaceConfigFields } from './settings.js'
import { axisTransferVariable } from './topology.js'

export type { RawPanelDeviceInfo } from './link.js'

export interface RawPanelPluginOptions {
	/** Connection timings; tests shorten them */
	timings?: Partial<ConnectionTimings>
	/** Link timings (announcing again after a rejection); tests shorten them */
	linkTimings?: Partial<LinkTimings>
}

const logger = createModuleLogger('Plugin')

export function createRawPanelPlugin(options: RawPanelPluginOptions = {}): SurfacePlugin<RawPanelDeviceInfo> {
	const remote = new RawPanelPluginRemoteService(options.timings, options.linkTimings)

	return {
		remote,

		init: async (): Promise<void> => {
			await remote.init()
		},
		destroy: async (): Promise<void> => {
			await remote.destroy()
		},

		openSurface: async (
			surfaceId: string,
			pluginInfo: RawPanelDeviceInfo,
			context: SurfaceContext,
		): Promise<OpenSurfaceResult> => {
			const link = pluginInfo.link
			const layout = link.layout
			if (!link.isCurrent(pluginInfo) || !layout) {
				throw new Error(`Panel ${link.address}:${link.port} changed or was removed before ${surfaceId} opened`)
			}
			logger.debug(`Opening ${surfaceId} with ${layout.controls.length} controls`)

			return {
				surface: new RawPanelSurface(surfaceId, link.description, link, layout, context),
				registerProps: {
					brightness: true,
					surfaceLayout: layout.surfaceLayout,
					pincodeMap: null,
					location: `${link.address}:${link.port}`,
					configFields: surfaceConfigFields(layout.axes),
					transferVariables: layout.axes.length ? layout.axes.map(axisTransferVariable) : undefined,
				},
			}
		},
	}
}

const RawPanelPlugin = createRawPanelPlugin()

export default RawPanelPlugin
