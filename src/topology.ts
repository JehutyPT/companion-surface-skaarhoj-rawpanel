/**
 * The panel's `_panelTopology_HWC` report: parsing, classifying controls and building the
 * Companion surface layout from their physical positions. Nothing here knows about a model or a
 * specific HWC id; everything comes from the report.
 */
import type { SurfaceSchemaLayoutDefinition } from '@companion-surface/base'

export type ControlKind =
	/** `b`, `b2h`, `b2v`, `b4`: a key (edges of multi-way buttons collapse to one key) */
	| 'button'
	/** `p`: encoder without push */
	| 'encoder'
	/** `pb`: encoder with push */
	| 'encoder-push'
	/** `av`/`ah`/`ar`/`iv`/`ih`/`ir`: faders, T-bars, joysticks, rockers */
	| 'analog'
	/** No input at all: placeholders, labels, disabled (type 0) */
	| 'none'
	/** An `in` code this plugin does not know */
	| 'unknown'

export interface TopologyControl {
	hwc: number
	x: number
	y: number
	label: string
	kind: ControlKind
	/** The raw `in` code, after `typeOverride` */
	input: string
	/** The raw `out` code, after `typeOverride` */
	output: string
	hasDisplay: boolean
	/** Control size in 1/10 mm (`h` falls back to `w` for round controls); 0 if unknown */
	w: number
	h: number
}

export interface Topology {
	controls: TopologyControl[]
}

/** A Companion control: one per layout-able HWC. */
export interface LayoutControl {
	controlId: string
	hwc: number
	kind: Exclude<ControlKind, 'analog' | 'none' | 'unknown'>
	hasDisplay: boolean
	row: number
	column: number
}

export interface PanelLayout {
	controls: LayoutControl[]
	surfaceLayout: SurfaceSchemaLayoutDefinition
	/** A string that is equal for two layouts exactly when Companion would see the same surface */
	signature: string
}

export const DISPLAY_STYLE_PRESET = 'display'

const BUTTON_CODES = new Set(['b', 'b2h', 'b2v', 'b4'])
const ANALOG_CODES = new Set(['av', 'ah', 'ar', 'iv', 'ih', 'ir'])

interface RawTypeDef {
	w?: number
	h?: number
	in?: string
	out?: string
	desc?: string
	disp?: unknown
}

function classify(input: string): ControlKind {
	const codes = input
		.split(',')
		.map((c) => c.trim())
		.filter((c) => c.length > 0)
	if (codes.length === 0) return 'none'
	if (codes.includes('pb')) return 'encoder-push'
	if (codes.includes('p')) return 'encoder'
	if (codes.some((c) => BUTTON_CODES.has(c))) return 'button'
	if (codes.some((c) => ANALOG_CODES.has(c))) return 'analog'
	return 'unknown'
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function num(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
	return typeof value === 'string' ? value : ''
}

/**
 * Overlay a per-HWC `typeOverride` on its `typeIndex` entry, field by field: only non-zero and
 * non-empty override fields win (SKAARHOJ/rawpanel-lib `GetTypeDefWithOverride`).
 */
function mergeTypeDef(base: RawTypeDef, override: RawTypeDef | undefined): RawTypeDef {
	if (!override) return base
	const merged = { ...base }
	if (num(override.w) > 0) merged.w = override.w
	if (num(override.h) > 0) merged.h = override.h
	if (str(override.in)) merged.in = override.in
	if (str(override.out)) merged.out = override.out
	if (str(override.desc)) merged.desc = override.desc
	if (override.disp) merged.disp = override.disp
	return merged
}

/**
 * Parse the JSON of a `_panelTopology_HWC=` reply. Throws if it is not a usable topology (not
 * JSON, or no `HWc` array).
 */
export function parseTopology(json: string): Topology {
	let data: unknown
	try {
		data = JSON.parse(json)
	} catch (e) {
		throw new Error(`Topology is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
	}
	const root = asObject(data)
	const hwcs = root?.HWc
	if (!root || !Array.isArray(hwcs)) throw new Error('Topology has no HWc list')
	const typeIndex = asObject(root.typeIndex) ?? {}

	const controls: TopologyControl[] = []
	for (const entry of hwcs) {
		const hwc = asObject(entry)
		if (!hwc) continue
		const id = num(hwc.id)
		if (!Number.isInteger(id) || id <= 0) continue
		const type = num(hwc.type)
		const typeDef = mergeTypeDef(asObject(typeIndex[String(type)]) ?? {}, asObject(hwc.typeOverride))
		const input = type === 0 ? '' : str(typeDef.in)
		const w = num(typeDef.w)
		controls.push({
			hwc: id,
			x: num(hwc.x),
			y: num(hwc.y),
			label: str(hwc.txt),
			kind: classify(input),
			input,
			output: str(typeDef.out),
			hasDisplay: asObject(typeDef.disp) !== undefined,
			w,
			h: num(typeDef.h) || w,
		})
	}
	return { controls }
}

function median(values: number[]): number {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Rank-quantise coordinates: sort the distinct values, start a new bucket whenever a value is
 * more than `tolerance` past the first value of the current bucket, and return each value's
 * bucket index.
 */
function quantise(values: number[], tolerance: number): Map<number, number> {
	const sorted = [...new Set(values)].sort((a, b) => a - b)
	const result = new Map<number, number>()
	let bucket = -1
	let bucketStart = -Infinity
	for (const value of sorted) {
		if (value - bucketStart > tolerance) {
			bucket++
			bucketStart = value
		}
		result.set(value, bucket)
	}
	return result
}

/** Fallback merge tolerance, in 1/10 mm, when the topology gives no control sizes. */
const DEFAULT_TOLERANCE = 50

/**
 * Build the Companion layout from the topology. Buttons and encoders become controls; analog,
 * input-less and unknown controls are left out. Columns and rows mirror the physical panel: x and
 * y are rank-quantised, merging coordinates within half the typical control size. A control that
 * lands on an occupied cell moves right to the next free column.
 */
export function buildLayout(topology: Topology): PanelLayout {
	const usable = topology.controls
		.filter(
			(c): c is TopologyControl & { kind: LayoutControl['kind'] } =>
				c.kind === 'button' || c.kind === 'encoder' || c.kind === 'encoder-push',
		)
		.sort((a, b) => a.hwc - b.hwc)

	const xTolerance = median(usable.map((c) => c.w).filter((w) => w > 0)) / 2 || DEFAULT_TOLERANCE
	const yTolerance = median(usable.map((c) => c.h).filter((h) => h > 0)) / 2 || DEFAULT_TOLERANCE
	const columns = quantise(
		usable.map((c) => c.x),
		xTolerance,
	)
	const rows = quantise(
		usable.map((c) => c.y),
		yTolerance,
	)

	const occupied = new Set<string>()
	const seen = new Set<number>()
	const controls: LayoutControl[] = []
	for (const c of usable) {
		if (seen.has(c.hwc)) continue
		seen.add(c.hwc)
		const row = rows.get(c.y) ?? 0
		let column = columns.get(c.x) ?? 0
		while (occupied.has(`${row}/${column}`)) column++
		occupied.add(`${row}/${column}`)
		controls.push({ controlId: `hwc/${c.hwc}`, hwc: c.hwc, kind: c.kind, hasDisplay: c.hasDisplay, row, column })
	}

	const surfaceLayout: SurfaceSchemaLayoutDefinition = {
		stylePresets: {
			default: { colors: 'hex' },
			[DISPLAY_STYLE_PRESET]: { colors: 'hex', text: true },
		},
		controls: Object.fromEntries(
			controls.map((c) => [
				c.controlId,
				c.hasDisplay
					? { row: c.row, column: c.column, stylePreset: DISPLAY_STYLE_PRESET }
					: { row: c.row, column: c.column },
			]),
		),
	}

	return { controls, surfaceLayout, signature: JSON.stringify(controls) }
}
