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
	/** The control has an LED (its topology `out` is set); controls without one get no LED commands */
	hasLed: boolean
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

/** Style presets by feedback: `default` is colour only (an LED, no display). */
export const DISPLAY_STYLE_PRESET = 'display'
export const TEXT_STYLE_PRESET = 'text'
export const NO_FEEDBACK_STYLE_PRESET = 'none'

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

/** Size assumed, in 1/10 mm, for a control the topology gives no size for. */
const DEFAULT_SIZE = 100

/**
 * Group positions on one axis into ranks. Each item has a centre and a size along the axis. Items
 * are taken in order of centre; an item joins the current group when its centre lies within half
 * the larger of its own size and the size of the group's first item (equivalently, their extents
 * overlap by at least half the smaller size), otherwise it starts a new group. Comparing with the
 * group's first item, not the previous one, keeps a staggered run from merging into one group.
 * Returns each item's group index, in input order.
 */
function rank(items: { centre: number; size: number }[]): number[] {
	const order = items.map((_, i) => i).sort((a, b) => items[a].centre - items[b].centre)
	const result = new Array<number>(items.length)
	let group = -1
	let anchor: { centre: number; size: number } | undefined
	for (const i of order) {
		const item = items[i]
		if (!anchor || item.centre - anchor.centre > Math.max(item.size, anchor.size) / 2) {
			group++
			anchor = item
		}
		result[i] = group
	}
	return result
}

/**
 * Build the Companion layout from the topology. Buttons and encoders become controls; analog,
 * input-less and unknown controls are left out. Columns and rows mirror the physical panel: x and
 * y are ranked, with controls whose physical extents mostly overlap on an axis sharing a column or
 * row (see `rank`). A control that lands on an occupied cell moves right to the next free column.
 */
export function buildLayout(topology: Topology): PanelLayout {
	const usable = topology.controls
		.filter(
			(c): c is TopologyControl & { kind: LayoutControl['kind'] } =>
				c.kind === 'button' || c.kind === 'encoder' || c.kind === 'encoder-push',
		)
		.sort((a, b) => a.hwc - b.hwc)

	const columns = rank(usable.map((c) => ({ centre: c.x, size: c.w || DEFAULT_SIZE })))
	const rows = rank(usable.map((c) => ({ centre: c.y, size: c.h || DEFAULT_SIZE })))

	const occupied = new Set<string>()
	const seen = new Set<number>()
	const controls: LayoutControl[] = []
	usable.forEach((c, i) => {
		if (seen.has(c.hwc)) return
		seen.add(c.hwc)
		const row = rows[i]
		let column = columns[i]
		while (occupied.has(`${row}/${column}`)) column++
		occupied.add(`${row}/${column}`)
		controls.push({
			controlId: `hwc/${c.hwc}`,
			hwc: c.hwc,
			kind: c.kind,
			hasLed: c.output !== '',
			hasDisplay: c.hasDisplay,
			row,
			column,
		})
	})

	const surfaceLayout: SurfaceSchemaLayoutDefinition = {
		stylePresets: {
			default: { colors: 'hex' },
			[DISPLAY_STYLE_PRESET]: { colors: 'hex', text: true },
			[TEXT_STYLE_PRESET]: { text: true },
			[NO_FEEDBACK_STYLE_PRESET]: {},
		},
		controls: Object.fromEntries(
			controls.map((c) => {
				const preset = stylePresetFor(c)
				return [
					c.controlId,
					preset ? { row: c.row, column: c.column, stylePreset: preset } : { row: c.row, column: c.column },
				]
			}),
		),
	}

	return { controls, surfaceLayout, signature: JSON.stringify(controls) }
}

function stylePresetFor(control: LayoutControl): string | undefined {
	if (control.hasDisplay) return control.hasLed ? DISPLAY_STYLE_PRESET : TEXT_STYLE_PRESET
	return control.hasLed ? undefined : NO_FEEDBACK_STYLE_PRESET
}
