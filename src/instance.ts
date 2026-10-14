/**
 * The Companion surface for one panel: turns draws into panel commands and panel input into
 * Companion key and rotate events. Holds the desired state of every control so it can push it all
 * whenever the panel blanks itself (connect, reconnect, wake).
 */
import {
	createModuleLogger,
	type CardGenerator,
	type ModuleLogger,
	type SurfaceContext,
	type SurfaceDrawProps,
	type SurfaceInstance,
} from '@companion-surface/base'
import { AnalogSender } from './analog.js'
import type { PanelLink } from './link.js'
import { ledCommands, textCommand, type PanelCommand, type PanelEvent } from './protocol.js'
import { DEFAULT_PANEL_SETTINGS, parsePanelSettings, settingCommands, type PanelSettings } from './settings.js'
import type { LayoutControl, PanelLayout } from './topology.js'

interface ControlState {
	color: string | undefined
	text: string
	pressed: boolean
}

const OFF: ControlState = { color: undefined, text: '', pressed: false }

export class RawPanelSurface implements SurfaceInstance {
	readonly surfaceId: string
	readonly productName: string
	readonly #link: PanelLink
	readonly #context: SurfaceContext
	readonly #logger: ModuleLogger
	readonly #byHwc = new Map<number, LayoutControl>()
	readonly #byId = new Map<string, LayoutControl>()
	readonly #state = new Map<string, ControlState>()
	/** Pressed edges per HWC; plain (edge-less) presses use bit 1 */
	readonly #held = new Map<number, number>()
	readonly #analog: AnalogSender
	#settings: PanelSettings = DEFAULT_PANEL_SETTINGS
	/** Companion's latest brightness for this surface, 0-100; undefined until it sets one */
	#brightness: number | undefined
	#listening = false
	#closed = false
	#disconnectRequested = false

	readonly #onInput = (event: PanelEvent): void => this.#handleInput(event)
	readonly #onResync = (): void => this.#pushAll()
	readonly #onOffline = (): void => {
		this.#releaseAll()
		this.#analog.rest()
	}
	readonly #onDisconnect = (reason: string): void => {
		// Companion closes the surface in its own time; ask once even if another reason follows.
		if (this.#disconnectRequested) return
		this.#disconnectRequested = true
		this.#context.disconnect(new Error(reason))
	}

	constructor(surfaceId: string, productName: string, link: PanelLink, layout: PanelLayout, context: SurfaceContext) {
		this.surfaceId = surfaceId
		this.productName = productName
		this.#link = link
		this.#context = context
		this.#logger = createModuleLogger(`Surface/${surfaceId}`)
		for (const control of layout.controls) {
			this.#byHwc.set(control.hwc, control)
			this.#byId.set(control.controlId, control)
			this.#state.set(control.controlId, OFF)
		}
		this.#analog = new AnalogSender(
			layout.axes,
			(variableId, value) => this.#context.sendVariableValue(variableId, value),
			() => this.#context.isLocked,
		)
	}

	async init(): Promise<void> {
		if (this.#closed) throw new Error('Surface already closed')
		this.#link.attach(this)
		this.#listen(true)
		// The panel blanked itself on connect; make our view of it explicit.
		this.#pushAll()
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.#closed = true
		this.#listen(false)
		this.#held.clear()
		this.#analog.rest()
		this.#analog.stop()
		this.#link.detach(this)
	}

	async updateConfig(config: Record<string, any>): Promise<void> {
		this.#settings = parsePanelSettings(config)
		// Diffed per command, so only a changed setting goes out
		this.#link.write(settingCommands(this.#settings, this.#brightness))
	}

	async ready(): Promise<void> {
		// Joysticks and rockers start at rest. Not in init(): Companion has not registered the surface
		// yet and drops variable values sent before ready().
		this.#analog.rest()
	}

	async setBrightness(percent: number): Promise<void> {
		this.#brightness = percent
		// Only when the user linked the panel's brightness to Companion's
		if (this.#settings.linkBrightness) this.#link.write(settingCommands(this.#settings, percent))
	}

	async blank(): Promise<void> {
		for (const id of this.#state.keys()) this.#state.set(id, OFF)
		this.#pushAll(false)
	}

	async draw(_signal: AbortSignal, drawProps: SurfaceDrawProps): Promise<void> {
		const control = this.#byId.get(drawProps.controlId)
		if (!control) return
		const state: ControlState = {
			color: drawProps.color,
			text: control.hasDisplay ? (drawProps.text ?? '') : '',
			pressed: drawProps.pressed,
		}
		this.#state.set(control.controlId, state)
		this.#link.write(this.#commandsFor(control, state))
	}

	async showStatus(_signal: AbortSignal, _cardGenerator: CardGenerator, _statusMessage: string): Promise<void> {
		// No bitmap displays; the status card cannot be shown
	}

	#listen(on: boolean): void {
		if (on === this.#listening) return
		this.#listening = on
		const method = on ? 'on' : 'off'
		this.#link[method]('input', this.#onInput)
		this.#link[method]('resync', this.#onResync)
		this.#link[method]('offline', this.#onOffline)
		this.#link[method]('disconnect', this.#onDisconnect)
	}

	#commandsFor(control: LayoutControl, state: ControlState): PanelCommand[] {
		const commands = control.hasLed ? ledCommands(control.hwc, state.color, state.pressed) : []
		if (control.hasDisplay) commands.push(textCommand(control.hwc, state.text))
		return commands
	}

	/** Send every control's state. `reset` re-sends even what the panel should already show. */
	#pushAll(reset = true): void {
		if (reset) this.#link.resetDiffs()
		// Opt-in panel settings first: the panel resets the sleep timer when it restarts
		const commands: PanelCommand[] = settingCommands(this.#settings, this.#brightness)
		for (const control of this.#byId.values()) {
			commands.push(...this.#commandsFor(control, this.#state.get(control.controlId) ?? OFF))
		}
		this.#link.write(commands)
	}

	/** Release keys still held, so Companion does not keep them pressed across a link loss. */
	#releaseAll(): void {
		for (const [hwc, mask] of this.#held) {
			const control = this.#byHwc.get(hwc)
			if (mask !== 0 && control) this.#context.keyUpById(control.controlId)
		}
		this.#held.clear()
	}

	#handleInput(event: PanelEvent): void {
		if (!('hwc' in event)) {
			if (event.type === 'unknown') this.#logger.debug(`Ignoring line: ${event.line.slice(0, 80)}`)
			return
		}
		if (event.type === 'analog') {
			this.#analog.input(event.hwc, event.value)
			return
		}
		const control = this.#byHwc.get(event.hwc)
		if (!control) return

		switch (event.type) {
			case 'button': {
				// Multi-way buttons are one key: down on the first edge, up when the last edge lifts.
				const bit = event.edge ?? 1
				const before = this.#held.get(event.hwc) ?? 0
				const after = event.down ? before | bit : before & ~bit
				this.#held.set(event.hwc, after)
				if (before === 0 && after !== 0) this.#context.keyDownById(control.controlId)
				else if (before !== 0 && after === 0) this.#context.keyUpById(control.controlId)
				break
			}
			case 'press':
				this.#context.keyDownUpById(control.controlId)
				break
			case 'encoder':
				// Companion handles key presses while locked (pincode entry); rotation is ignored then.
				if (this.#context.isLocked || event.delta === 0) break
				this.#context.rotateById(control.controlId, event.delta)
				break
		}
	}
}
