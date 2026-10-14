import net from 'node:net'

export interface FakePanelOptions {
	/** Reply to `list`. Lines without the trailing newline. */
	listReply?: string[]
	/** The JSON sent as `_panelTopology_HWC=` in reply to `PanelTopology?`. `null` = never reply. */
	topology?: unknown
	/** Lines sent unprompted on every new connection (the real panel sends `RDY` and `map=`). */
	greeting?: string[]
	/** Delay before answering `ping` with `ack`, in ms. */
	ackDelayMs?: number
	/** Answer `ping` at all. */
	answerPings?: boolean
}

interface Client {
	socket: net.Socket
	lines: string[]
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
			listReply: options.listReply ?? [
				'_model=SK_PTZEXTREMEV2',
				'_serial=FAKE0001',
				'_version=v2.5.27',
				'_bluePillReady=0',
			],
			topology: options.topology === undefined ? null : options.topology,
			greeting: options.greeting ?? ['RDY'],
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

	/** Lines received from the latest client, excluding the connection chatter (`list`, `PanelTopology?`, `ping`). */
	get commands(): string[] {
		return this.receivedOnLatest.filter((l) => l !== 'ping' && l !== 'list' && l !== 'PanelTopology?')
	}

	clearReceived(): void {
		for (const client of this.#clients) client.lines.length = 0
	}

	get openClients(): number {
		return this.#clients.filter((c) => !c.socket.destroyed).length
	}

	/** Send lines to every open client. */
	send(...lines: string[]): void {
		for (const client of this.#clients) {
			if (!client.socket.destroyed) client.socket.write(lines.map((l) => l + '\n').join(''))
		}
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
				this.#reply(socket, line)
			}
		})
	}

	#reply(socket: net.Socket, line: string): void {
		const write = (lines: string[]) => {
			if (!socket.destroyed) socket.write(lines.map((l) => l + '\n').join(''))
		}
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
			write(['_panelTopology_svgbase=<svg></svg>', `_panelTopology_HWC=${json}`])
		}
	}
}

/** Poll until `predicate` is true, or fail after `timeoutMs`. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000, message = 'condition'): Promise<void> {
	const start = Date.now()
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${message}`)
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

export async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms))
}
