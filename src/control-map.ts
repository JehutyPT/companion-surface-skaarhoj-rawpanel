/**
 * The custom control map, a remote connection setting: `<hwc>=<row>/<column>` entries separated by
 * commas, semicolons or newlines, e.g. `37=1/5, 38=1/6`. Rows and columns are 0-based, as in
 * Companion's grid. Parsing knows nothing about the panel; `buildLayout` checks the HWCs.
 */

export interface ControlCell {
	row: number
	column: number
}

/** HWC id -> the cell the user put it on, in the order the entries were written */
export type ControlMap = ReadonlyMap<number, ControlCell>

const ENTRY = /^(\d+)\s*=\s*(\d+)\s*\/\s*(\d+)$/

/**
 * Parse the map. Malformed entries and repeats of a listed HWC (the first entry wins) are skipped,
 * each with a warning; the rest still apply.
 */
export function parseControlMap(text: unknown): { map: ControlMap; warnings: string[] } {
	const map = new Map<number, ControlCell>()
	const warnings: string[] = []
	if (typeof text !== 'string') return { map, warnings }

	for (const raw of text.split(/[,;\n]/)) {
		const entry = raw.trim()
		if (!entry) continue
		const numbers = ENTRY.exec(entry)?.slice(1).map(Number)
		const [hwc, row, column] = numbers ?? []
		if (!numbers || hwc <= 0 || !numbers.every(Number.isSafeInteger)) {
			warnings.push(`Control positions: ignoring '${entry}', expected <hwc>=<row>/<column> like 37=1/5`)
			continue
		}
		if (map.has(hwc)) {
			warnings.push(`Control positions: HWC ${hwc} is listed more than once; ignoring '${entry}'`)
			continue
		}
		map.set(hwc, { row, column })
	}
	return { map, warnings }
}

/**
 * The map in one canonical form: equal for maps written with different whitespace or separators.
 * Entry order is kept, since it decides which of two entries for one cell wins.
 */
export function formatControlMap(map: ControlMap): string {
	return [...map].map(([hwc, { row, column }]) => `${hwc}=${row}/${column}`).join(',')
}
