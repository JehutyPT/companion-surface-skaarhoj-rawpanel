import EventEmitter from 'node:events'
import type { PanelConnectionEvents, PanelIdentity } from '../../connection.js'
import type { LinkConnection } from '../../link.js'
import type { PanelEvent } from '../../protocol.js'
import { parseTopology } from '../../topology.js'

/** What the panel reports when the connection comes online; `topology` is a fixture as the panel sends it. */
export type FakeIdentity = Partial<Omit<PanelIdentity, 'topology'>> & { topology: unknown }

/**
 * An in-memory connection for link tests: the test drives it (online, offline, events) and reads
 * what the link wrote. No socket, no timers of its own.
 */
export class FakeConnection extends EventEmitter<PanelConnectionEvents> implements LinkConnection {
	isOnline = false
	started = false
	stopped = false
	/** `[key, line]` per write, in order */
	readonly writes: [key: string, line: string][] = []
	resetDiffsCalls = 0

	start(): void {
		this.started = true
	}

	stop(): void {
		this.stopped = true
		this.isOnline = false
	}

	write(key: string, line: string): void {
		this.writes.push([key, line])
	}

	resetDiffs(): void {
		this.resetDiffsCalls++
	}

	/** Connected and topology received, as after every (re)connect. */
	goOnline(identity: FakeIdentity): void {
		this.isOnline = true
		const reported: PanelIdentity = {
			model: identity.model,
			serial: identity.serial,
			version: identity.version,
			topology: parseTopology(JSON.stringify(identity.topology)),
		}
		this.emit('online', reported)
	}

	/** The connection was lost after having been online. */
	goOffline(reason = 'connection closed'): void {
		this.isOnline = false
		this.emit('offline', reason)
	}

	/** An inbound line other than connection chatter. */
	receive(event: PanelEvent): void {
		this.emit('event', event)
	}
}
