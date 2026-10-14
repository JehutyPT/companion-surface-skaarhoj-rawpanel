import type { DetectionSurfaceInfo, OpenSurfaceResult, SurfacePlugin } from '@companion-surface/base'
import { createRawPanelPlugin, type RawPanelDeviceInfo } from '../../main.js'
import type { ConnectionTimings } from '../../connection.js'
import { FakeRawPanel, waitFor, type FakePanelOptions } from './fake-panel.js'
import { FakeSurfaceContext } from './fake-context.js'

/** Short timings so link loss, reconnects and timeouts happen within a test. */
export const fastTimings: Partial<ConnectionTimings> = {
	connectTimeoutMs: 500,
	topologyTimeoutMs: 300,
	pingIntervalMs: 30,
	livenessTimeoutMs: 250,
	backoffInitialMs: 20,
	backoffMaxMs: 200,
	writeIntervalMs: 2,
	writeBurst: 50,
	busyTimeoutMs: 300,
	rejectRetryMs: 20,
}

/**
 * Drives the plugin the way Companion's surface host does: init, startConnections, collect
 * `surfacesConnected`, openSurface, init the instance.
 */
export class Harness {
	readonly panel: FakeRawPanel
	readonly plugin: SurfacePlugin<RawPanelDeviceInfo>
	readonly announced: DetectionSurfaceInfo<RawPanelDeviceInfo>[] = []
	readonly contexts: FakeSurfaceContext[] = []
	readonly opened: OpenSurfaceResult[] = []

	constructor(panelOptions: FakePanelOptions = {}, timings: Partial<ConnectionTimings> = fastTimings) {
		this.panel = new FakeRawPanel(panelOptions)
		this.plugin = createRawPanelPlugin({ timings })
		this.plugin.remote!.on('surfacesConnected', (infos) => this.announced.push(...infos))
	}

	async start(): Promise<void> {
		await this.panel.listen()
		await this.plugin.init()
	}

	async connect(connectionId = 'conn1'): Promise<void> {
		await this.plugin.remote!.startConnections([
			{ connectionId, config: { address: '127.0.0.1', port: this.panel.port } },
		])
	}

	async waitForAnnouncements(count = 1): Promise<DetectionSurfaceInfo<RawPanelDeviceInfo>> {
		await waitFor(() => this.announced.length >= count, 2000, `${count} surfacesConnected`)
		return this.announced[count - 1]
	}

	/** Open the latest announced surface and run the host's open sequence. */
	async open(
		info?: DetectionSurfaceInfo<RawPanelDeviceInfo>,
	): Promise<{ result: OpenSurfaceResult; context: FakeSurfaceContext }> {
		const target = info ?? this.announced[this.announced.length - 1]
		const context = new FakeSurfaceContext()
		const result = await this.plugin.openSurface(target.surfaceId, target.pluginInfo, context)
		await result.surface.init()
		await result.surface.ready()
		this.contexts.push(context)
		this.opened.push(result)
		return { result, context }
	}

	async stop(): Promise<void> {
		for (const opened of this.opened) await opened.surface.close()
		await this.plugin.destroy()
		await this.panel.close()
	}
}
