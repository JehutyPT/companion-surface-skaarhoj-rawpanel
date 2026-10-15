import net from 'node:net'
import { waitFor } from './timing.js'

export interface FakePanelOptions {
	/** Reply to `list`. Lines without the trailing newline. */
	listReply?: string[]
	/** The JSON sent as `_panelTopology_HWC=` in reply to `PanelTopology?`. `null` = never reply. */
	topology?: unknown
	/** Lines sent unprompted on every new connection. The real panel sends none. */
	greeting?: string[]
	/** The SVG sent as `_panelTopology_svgbase=` before the topology. */
	svgbase?: string
	/** Write the topology reply in chunks of this many characters, each in its own write. 0 = one write. */
	chunkSize?: number
	/** Delay before answering `ping` with `ack`, in ms. */
	ackDelayMs?: number
	/** Answer `ping` at all. */
	answerPings?: boolean
}

/**
 * The `list` reply of the SK_PTZEXTREMEV2 captured 2026-10-14 (fixtures/ptz-extreme-capture-*.log):
 * identity, then one `map=` line per HWC with an input. The serial is the capture's.
 */
export const PTZ_EXTREME_LIST_REPLY = [
	'_model=SK_PTZEXTREMEV2',
	'_serial=442845',
	'_version=v2.5.27',
	'_bluePillReady=0',
	...[...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 27 }, (_, i) => i + 37)].map(
		(n) => `map=${n}:${n}`,
	),
]

interface Client {
	socket: net.Socket
	lines: string[]
	/** Set while a chunked reply is being written: other writes wait here, so none lands inside its lines. */
	held?: string[]
}

/** Write `data` to the client, or hold it until a chunked reply in progress has been written. */
function writeTo(client: Client, data: string): void {
	if (client.socket.destroyed) return
	if (client.held) client.held.push(data)
	else client.socket.write(data)
}

/**
 * An in-process Raw Panel server on 127.0.0.1 for tests. It answers `list`, `PanelTopology?` and
 * `ping` like the real panel, records every line each client sends, and can push lines to clients.
 */
export class FakeRawPanel {
	readonly #server = net.createServer((socket) => this.#onConnection(socket))
	readonly #clients: Client[] = []
	readonly options: Required<Omit<FakePanelOptions, 'topology'>> & { topology: unknown }
	connectionCount = 0

	constructor(options: FakePanelOptions = {}) {
		this.options = {
			listReply: options.listReply ?? PTZ_EXTREME_LIST_REPLY,
			topology: options.topology === undefined ? null : options.topology,
			greeting: options.greeting ?? [],
			svgbase: options.svgbase ?? '<svg></svg>',
			chunkSize: options.chunkSize ?? 0,
			ackDelayMs: options.ackDelayMs ?? 0,
			answerPings: options.answerPings ?? true,
		}
	}

	get port(): number {
		const address = this.#server.address()
		if (!address || typeof address === 'string') throw new Error('Not listening')
		return address.port
	}

	async listen(): Promise<void> {
		await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve))
	}

	async close(): Promise<void> {
		for (const client of this.#clients) client.socket.destroy()
		await new Promise<void>((resolve) => this.#server.close(() => resolve()))
	}

	/** Lines received from every client so far, in arrival order per client, concatenated. */
	get received(): string[] {
		return this.#clients.flatMap((c) => c.lines)
	}

	/** Lines received from the most recent client. */
	get receivedOnLatest(): string[] {
		return this.#clients[this.#clients.length - 1]?.lines ?? []
	}

	/** Lines received from the latest client, excluding the connection chatter (`list`, `PanelTopology?`, `ping`, `ack`). */
	get commands(): string[] {
		return this.receivedOnLatest.filter((l) => l !== 'ping' && l !== 'ack' && l !== 'list' && l !== 'PanelTopology?')
	}

	clearReceived(): void {
		for (const client of this.#clients) client.lines.length = 0
	}

	get openClients(): number {
		return this.#clients.filter((c) => !c.socket.destroyed).length
	}

	/** Send lines to every open client. */
	send(...lines: string[]): void {
		for (const client of this.#clients) writeTo(client, lines.map((l) => l + '\n').join(''))
	}

	/** Write `data` to every open client as is, with no newline added: for lines split across writes. */
	sendRaw(data: string): void {
		for (const client of this.#clients) {
			if (!client.socket.destroyed) client.socket.write(data)
		}
	}

	/**
	 * Send `lines`, then a `ping`, and wait for the plugin's `ack`. The plugin handles lines in order,
	 * so once the ack is back every line before it has been handled. Note: a ping also ends a BSY hold.
	 */
	async sendAndSync(...lines: string[]): Promise<void> {
		const acks = () => this.receivedOnLatest.filter((l) => l === 'ack').length
		const before = acks()
		this.send(...lines, 'ping')
		await waitFor(() => acks() > before, 2000, 'the ack after the sent lines')
	}

	/** Drop every client connection, as if the panel rebooted or the cable was pulled. */
	dropClients(): void {
		for (const client of this.#clients) client.socket.destroy()
	}

	#onConnection(socket: net.Socket): void {
		this.connectionCount++
		const client: Client = { socket, lines: [] }
		this.#clients.push(client)
		socket.setEncoding('ascii')
		socket.on('error', () => null)
		if (this.options.greeting.length) socket.write(this.options.greeting.map((l) => l + '\n').join(''))

		let buffer = ''
		socket.on('data', (chunk: string) => {
			buffer += chunk
			let index: number
			while ((index = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, index).replace(/\r$/, '')
				buffer = buffer.slice(index + 1)
				client.lines.push(line)
				this.#reply(client, line)
			}
		})
	}

	#reply(client: Client, line: string): void {
		const { socket } = client
		const write = (lines: string[]) => writeTo(client, lines.map((l) => l + '\n').join(''))
		if (line === 'ping') {
			if (!this.options.answerPings) return
			if (this.options.ackDelayMs > 0) setTimeout(() => write(['ack']), this.options.ackDelayMs)
			else write(['ack'])
		} else if (line === 'list') {
			write(this.options.listReply)
		} else if (line === 'PanelTopology?') {
			if (this.options.topology === null) return
			const json =
				typeof this.options.topology === 'string' ? this.options.topology : JSON.stringify(this.options.topology)
			const reply = `_panelTopology_svgbase=${this.options.svgbase}\n_panelTopology_HWC=${json}\n`
			if (this.options.chunkSize <= 0) {
				writeTo(client, reply)
				return
			}
			// Like the real panel, nothing else (an `ack`, a test's line) goes out in the middle of the reply
			const held: string[] = (client.held ??= [])
			const sendFrom = (offset: number): void => {
				if (socket.destroyed) return
				if (offset >= reply.length) {
					client.held = undefined
					for (const data of held) socket.write(data)
					return
				}
				socket.write(reply.slice(offset, offset + this.options.chunkSize))
				setImmediate(() => sendFrom(offset + this.options.chunkSize))
			}
			sendFrom(0)
		}
	}
}
