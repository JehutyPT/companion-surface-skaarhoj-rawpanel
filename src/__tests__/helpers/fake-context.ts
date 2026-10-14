import type { HostCapabilities, SurfaceContext } from '@companion-surface/base'

export type ContextCall =
	| ['keyDown', string]
	| ['keyUp', string]
	| ['keyDownUp', string]
	| ['rotate', string, number]
	| ['rotateLeft', string, number | undefined]
	| ['rotateRight', string, number | undefined]
	| ['changePage', boolean]
	| ['variable', string, unknown]
	| ['disconnect', string]

/** A SurfaceContext that records every call the surface makes to Companion. */
export class FakeSurfaceContext implements SurfaceContext {
	readonly calls: ContextCall[] = []
	locked = false
	readonly capabilities: HostCapabilities = { supportsNonSquareButtons: true, supportsLeds: true }
	onDisconnect: ((error: Error) => void) | undefined

	get isLocked(): boolean {
		return this.locked
	}
	disconnect(error: Error): void {
		this.calls.push(['disconnect', error.message])
		this.onDisconnect?.(error)
	}
	keyDownById(controlId: string): void {
		this.calls.push(['keyDown', controlId])
	}
	keyUpById(controlId: string): void {
		this.calls.push(['keyUp', controlId])
	}
	keyDownUpById(controlId: string): void {
		this.calls.push(['keyDownUp', controlId])
	}
	rotateLeftById(controlId: string, amount?: number): void {
		this.calls.push(['rotateLeft', controlId, amount])
	}
	rotateRightById(controlId: string, amount?: number): void {
		this.calls.push(['rotateRight', controlId, amount])
	}
	rotateById(controlId: string, delta: number): void {
		this.calls.push(['rotate', controlId, delta])
	}
	changePage(forward: boolean): void {
		this.calls.push(['changePage', forward])
	}
	sendVariableValue(variable: string, value: unknown): void {
		this.calls.push(['variable', variable, value])
	}
}
