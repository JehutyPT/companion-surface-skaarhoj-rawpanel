/**
 * One TCP link to a Raw Panel: line framing, the connect sequence (`list`, `PanelTopology?`),
 * ping liveness, reconnect with exponential backoff, and a paced, coalescing write queue that
 * honours `BSY`/`RDY`.
 */
import { createModuleLogger, type ModuleLogger } from '@companion-surface/base'
import EventEmitter from 'node:events'
import net from 'node:net'
import { parseLine, type PanelEvent } from './protocol.js'
import { parseTopology, type Topology } from './topology.js'

export interface ConnectionTimings {
	/** Give up on a TCP connect after this long */
	connectTimeoutMs: number
	/** Fail the connection if no usable `_panelTopology_HWC` arrives this long after connecting */
	topologyTimeoutMs: number
	/** Send `ping` this often */
	pingIntervalMs: number
	/** Declare the link dead after this long with nothing received. Must cover the panel's stalls after connect and wake (~0.5 s). */
	livenessTimeoutMs: number
	/** First reconnect delay; doubles per failed attempt */
	backoffInitialMs: number
	/** Reconnect delay cap */
	backoffMaxMs: number
	/** Time between write bursts */
	writeIntervalMs: number
	/** Most lines sent per burst */
	writeBurst: number
	/** Resume writing this long after `BSY` if neither `RDY` nor a panel `ping` has arrived */
	busyTimeoutMs: number
	/** First delay before announcing the surface again after Companion rejects it; doubles up to `backoffMaxMs` */
	rejectRetryMs: number
}

export const DEFAULT_TIMINGS: ConnectionTimings = {
	connectTimeoutMs: 3000,
	topologyTimeoutMs: 10000,
	pingIntervalMs: 1000,
	livenessTimeoutMs: 5000,
	backoffInitialMs: 1000,
	backoffMaxMs: 30000,
	writeIntervalMs: 20,
	writeBurst: 8,
	busyTimeoutMs: 1000,
	rejectRetryMs: 1000,
}

/** Longest inbound line accepted. Topology lines are tens of kB. */
const MAX_LINE_LENGTH = 4 * 1024 * 1024

export interface PanelIdentity {
	model: string | undefined
	serial: string | undefined
	version: string | undefined
	topology: Topology
}

export interface PanelConnectionEvents {
	/** Connected and topology received. Fired again after every reconnect. The panel has blanked itself: push everything. */
	online: [identity: PanelIdentity]
	/** Link lost after having been online. */
	offline: [reason: string]
	/** Any inbound line other than connection chatter (`ack`, `ping`, `BSY`, `RDY`, `list` replies, topology). */
	event: [event: PanelEvent]
}

function unknownIdentity(): Omit<PanelIdentity, 'topology'> {
	return { model: undefined, serial: undefined, version: undefined }
}

/** How a connection failure is logged: `error` needs the user's attention, `warn` heals itself. */
type FailureSeverity = 'error' | 'warn'

const CONNECTION_REPLY_KEYS = new Set(['model', 'serial', 'version', 'bluePillReady', 'panelTopology_svgbase'])

export class PanelConnection extends EventEmitter<PanelConnectionEvents> {
	readonly host: string
	readonly port: number
	readonly #timings: ConnectionTimings
	readonly #logger: ModuleLogger

	#socket: net.Socket | undefined
	#stopped = true
	#online = false
	#buffer = ''
	#lastSeen = 0
	#backoffMs: number
	#identity = unknownIdentity()

	#connectTimer: NodeJS.Timeout | undefined
	#topologyTimer: NodeJS.Timeout | undefined
	#pingTimer: NodeJS.Timeout | undefined
	#reconnectTimer: NodeJS.Timeout | undefined
	#writeTimer: NodeJS.Timeout | undefined
	#busyTimer: NodeJS.Timeout | undefined

	#busy = false
	readonly #pending = new Map<string, string>()
	readonly #lastSent = new Map<string, string>()

	constructor(host: string, port: number, timings: Partial<ConnectionTimings> = {}) {
		super()
		this.host = host
		this.port = port
		this.#timings = { ...DEFAULT_TIMINGS, ...timings }
		this.#backoffMs = this.#timings.backoffInitialMs
		this.#logger = createModuleLogger(`Connection/${host}:${port}`)
	}

	get isOnline(): boolean {
		return this.#online
	}

	start(): void {
		if (!this.#stopped) return
		this.#stopped = false
		this.#connect()
	}

	stop(): void {
		if (this.#stopped) return
		this.#stopped = true
		clearTimeout(this.#reconnectTimer)
		this.#teardown()
		this.#online = false
	}

	/**
	 * Queue a command. `key` identifies what the line sets (e.g. `HWCc#12`): a newer line for the
	 * same key replaces a queued one, and a line equal to the last one sent for that key is dropped.
	 * Writes while offline are dropped; the owner pushes full state on `online`.
	 */
	write(key: string, line: string): void {
		if (!this.#online) return
		if (this.#lastSent.get(key) === line) {
			this.#pending.delete(key)
			return
		}
		// Re-insert so the queue keeps the order the commands were last written in (colour before state).
		this.#pending.delete(key)
		this.#pending.set(key, line)
		this.#scheduleFlush()
	}

	/** Forget what was sent, so the next writes go out even if unchanged (the panel blanked itself). */
	resetDiffs(): void {
		this.#lastSent.clear()
	}

	#connect(): void {
		this.#identity = unknownIdentity()
		this.#buffer = ''
		this.#setBusy(false)
		this.#pending.clear()
		this.#lastSent.clear()

		const socket = net.createConnection({ host: this.host, port: this.port })
		this.#socket = socket
		socket.setEncoding('latin1')
		socket.setNoDelay(true)

		this.#connectTimer = setTimeout(() => this.#fail('connect timed out'), this.#timings.connectTimeoutMs)

		socket.on('connect', () => {
			clearTimeout(this.#connectTimer)
			this.#lastSeen = Date.now()
			this.#rawWrite(['list', 'PanelTopology?'])
			this.#topologyTimer = setTimeout(
				() =>
					this.#fail(
						`no usable topology within ${this.#timings.topologyTimeoutMs} ms of connecting (PanelTopology? unanswered); the plugin needs the panel's topology to build the layout`,
						'error',
					),
				this.#timings.topologyTimeoutMs,
			)
			this.#pingTimer = setInterval(() => this.#ping(), this.#timings.pingIntervalMs)
		})
		socket.on('data', (chunk: string) => this.#onData(chunk))
		socket.on('error', (e) => this.#fail(e.message))
		socket.on('close', () => this.#fail('connection closed'))
	}

	#onData(chunk: string): void {
		this.#lastSeen = Date.now()
		this.#buffer += chunk
		let index: number
		while ((index = this.#buffer.indexOf('\n')) >= 0) {
			let line = this.#buffer.slice(0, index)
			this.#buffer = this.#buffer.slice(index + 1)
			if (line.endsWith('\r')) line = line.slice(0, -1)
			if (line.length > 0) this.#onLine(line)
			if (!this.#socket) return
		}
		if (this.#buffer.length > MAX_LINE_LENGTH) this.#fail(`line longer than ${MAX_LINE_LENGTH} bytes`)
	}

	#onLine(line: string): void {
		const event = parseLine(line)
		switch (event.type) {
			case 'ack':
				return
			case 'ping':
				this.#rawWrite(['ack'])
				this.#setBusy(false)
				return
			case 'busy':
				this.#setBusy(true)
				return
			case 'ready':
				this.#setBusy(false)
				return
			case 'reply':
				if (event.key === 'panelTopology_HWC') {
					this.#onTopology(event.value)
					return
				}
				if (event.key === 'model') this.#identity.model = event.value
				if (event.key === 'serial') this.#identity.serial = event.value
				if (event.key === 'version') this.#identity.version = event.value
				if (CONNECTION_REPLY_KEYS.has(event.key)) return
				break
		}
		this.emit('event', event)
	}

	#onTopology(json: string): void {
		let topology: Topology
		try {
			topology = parseTopology(json)
		} catch (e) {
			this.#fail(`unusable topology: ${e instanceof Error ? e.message : String(e)}`, 'error')
			return
		}
		clearTimeout(this.#topologyTimer)
		this.#online = true
		this.#backoffMs = this.#timings.backoffInitialMs
		this.#logger.info(
			`Connected: ${this.#identity.model ?? 'unknown model'} serial ${this.#identity.serial ?? 'unknown'} ${this.#identity.version ?? ''}`,
		)
		this.emit('online', { ...this.#identity, topology })
	}

	#ping(): void {
		if (Date.now() - this.#lastSeen > this.#timings.livenessTimeoutMs) {
			this.#fail(`no reply from the panel for ${this.#timings.livenessTimeoutMs} ms`)
			return
		}
		this.#rawWrite(['ping'])
	}

	/** Write immediately, bypassing the queue and BSY (connection chatter only). */
	#rawWrite(lines: string[]): void {
		const socket = this.#socket
		if (!socket || socket.destroyed) return
		socket.write(lines.map((l) => l + '\n').join(''), 'latin1')
	}

	/**
	 * Hold or resume writes. A hold ends on `RDY`, a panel `ping`, or after `busyTimeoutMs`, so the
	 * queue cannot freeze if the panel sends neither.
	 */
	#setBusy(busy: boolean): void {
		clearTimeout(this.#busyTimer)
		this.#busyTimer = undefined
		this.#busy = busy
		if (busy) {
			this.#busyTimer = setTimeout(() => {
				this.#logger.debug(`Still busy after ${this.#timings.busyTimeoutMs} ms with no RDY; resuming writes`)
				this.#setBusy(false)
			}, this.#timings.busyTimeoutMs)
		} else {
			this.#scheduleFlush()
		}
	}

	#scheduleFlush(): void {
		if (this.#writeTimer || this.#pending.size === 0 || this.#busy || !this.#online) return
		this.#writeTimer = setTimeout(() => {
			this.#writeTimer = undefined
			this.#flush()
		}, this.#timings.writeIntervalMs)
	}

	#flush(): void {
		if (this.#busy || !this.#online) return
		const lines: string[] = []
		for (const [key, line] of this.#pending) {
			if (lines.length >= this.#timings.writeBurst) break
			this.#pending.delete(key)
			this.#lastSent.set(key, line)
			lines.push(line)
		}
		if (lines.length) this.#rawWrite(lines)
		this.#scheduleFlush()
	}

	#teardown(): void {
		clearTimeout(this.#connectTimer)
		clearTimeout(this.#topologyTimer)
		clearInterval(this.#pingTimer)
		clearTimeout(this.#writeTimer)
		this.#writeTimer = undefined
		clearTimeout(this.#busyTimer)
		this.#busyTimer = undefined
		this.#pending.clear()
		const socket = this.#socket
		this.#socket = undefined
		if (socket) {
			socket.removeAllListeners()
			socket.on('error', () => null)
			socket.destroy()
		}
	}

	#fail(reason: string, severity: FailureSeverity = 'warn'): void {
		if (!this.#socket) return
		this.#teardown()
		const wasOnline = this.#online
		this.#online = false
		if (this.#stopped) return

		const delay = this.#backoffMs
		this.#backoffMs = Math.min(this.#backoffMs * 2, this.#timings.backoffMaxMs)
		const message = `${this.host}:${this.port}: ${reason}; reconnecting in ${delay} ms`
		this.#logger[severity](message)
		this.#reconnectTimer = setTimeout(() => this.#connect(), delay)

		if (wasOnline) this.emit('offline', reason)
	}
}
