import type { DetectionSurfaceInfo, OpenSurfaceResult, SurfacePlugin } from '@companion-surface/base'
import { createRawPanelPlugin, type RawPanelDeviceInfo } from '../../main.js'
import type { ConnectionTimings } from '../../connection.js'
import type { LinkTimings } from '../../link.js'
import { FakeRawPanel, type FakePanelOptions } from './fake-panel.js'
import { waitFor, waitForQuiet } from './timing.js'
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
}

/** Short link timings so a rejected surface is announced again within a test. */
export const fastLinkTimings: Partial<LinkTimings> = {
	rejectRetryMs: 20,
	rejectRetryMaxMs: 200,
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
		this.plugin = createRawPanelPlugin({ timings, linkTimings: fastLinkTimings })
		this.plugin.remote!.on('surfacesConnected', (infos) => this.announced.push(...infos))
	}

	async start(): Promise<void> {
		await this.panel.listen()
		await this.plugin.init()
	}

	async connect(connectionId = 'conn1', config: Record<string, unknown> = {}): Promise<void> {
		await this.plugin.remote!.startConnections([
			{ connectionId, config: { address: '127.0.0.1', port: this.panel.port, ...config } },
		])
	}

	async waitForAnnouncements(count = 1, timeoutMs = 2000): Promise<DetectionSurfaceInfo<RawPanelDeviceInfo>> {
		await waitFor(() => this.announced.length >= count, timeoutMs, `${count} surfacesConnected`)
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

	/**
	 * Connect to the fake panel with `config`, open the announced surface the way the host does and
	 * settle: wait for the resync on connect to reach the panel, then for it to finish.
	 */
	async connectAndOpen(
		config: Record<string, unknown> = {},
	): Promise<{ result: OpenSurfaceResult; context: FakeSurfaceContext; panel: FakeRawPanel }> {
		await this.start()
		await this.connect('conn1', config)
		const opened = await this.open(await this.waitForAnnouncements())
		await waitFor(() => this.panel.commands.length > 0, 2000, 'the resync on connect')
		await this.settle()
		return { ...opened, panel: this.panel }
	}

	/**
	 * Wait for the writes in flight to reach the panel: until no new command has arrived for
	 * `quietMs`. Takes at least `quietMs`, longer while commands keep arriving.
	 */
	async settle(quietMs = 40): Promise<void> {
		await waitForQuiet(() => this.panel.commands.length, quietMs, 2000, 'the panel to settle')
	}

	async stop(): Promise<void> {
		for (const opened of this.opened) await opened.surface.close()
		await this.plugin.destroy()
		await this.panel.close()
	}
}
