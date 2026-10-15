import { validateSurfaceLayout } from '@companion-surface/base'
import { buildLayout, parseTopology, type PanelLayout } from '../../topology.js'
import type { ControlMap } from '../../control-map.js'

/**
 * Build the layout for a topology fixture the way the plugin does on connect: the fixture is
 * serialised as the panel would send it, parsed and laid out. The Companion layout is validated.
 * To check a new panel, add its topology to `fixtures/` and call this.
 */
export function layoutOf(topology: unknown, controlMap?: ControlMap): PanelLayout {
	const layout = buildLayout(parseTopology(JSON.stringify(topology)), controlMap)
	validateSurfaceLayout(layout.surfaceLayout)
	return layout
}

/** The HWC number of a layout control id (`hwc/37` is 37). */
function hwcOf(id: string): number {
	return Number(id.replace('hwc/', ''))
}

/** Render a layout as rows of right-aligned HWC numbers, `.` for an empty cell. */
export function asciiGrid(controls: Record<string, { row: number; column: number }>): string {
	const cells = Object.entries(controls).map(([id, c]) => ({ hwc: String(hwcOf(id)), ...c }))
	const rows = Math.max(...cells.map((c) => c.row)) + 1
	const columns = Math.max(...cells.map((c) => c.column)) + 1
	const grid = Array.from({ length: rows }, () => Array<string>(columns).fill('.'))
	for (const c of cells) grid[c.row][c.column] = c.hwc
	return grid.map((r) => r.map((cell) => cell.padStart(3)).join('')).join('\n')
}

/** A layout's controls as `hwc: [row, column]`. */
export function cellsOf(layout: PanelLayout): Record<number, [number, number]> {
	return Object.fromEntries(
		Object.entries(layout.surfaceLayout.controls).map(([id, c]) => [hwcOf(id), [c.row, c.column]]),
	)
}
