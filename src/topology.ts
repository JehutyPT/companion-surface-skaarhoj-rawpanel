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
	/**
	 * Identifies the control's topology type: its `type` id, plus its `typeOverride` when it has
	 * one (an overridden control is a type of its own). Equal for controls of the same type.
	 */
	typeKey: string
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

function numberOr0(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function stringOrEmpty(value: unknown): string {
	return typeof value === 'string' ? value : ''
}

/**
 * Overlay a per-HWC `typeOverride` on its `typeIndex` entry, field by field: only non-zero and
 * non-empty override fields win (SKAARHOJ/rawpanel-lib `GetTypeDefWithOverride`).
 */
function mergeTypeDef(base: RawTypeDef, override: RawTypeDef | undefined): RawTypeDef {
	if (!override) return base
	const merged = { ...base }
	if (numberOr0(override.w) > 0) merged.w = override.w
	if (numberOr0(override.h) > 0) merged.h = override.h
	if (stringOrEmpty(override.in)) merged.in = override.in
	if (stringOrEmpty(override.out)) merged.out = override.out
	if (stringOrEmpty(override.desc)) merged.desc = override.desc
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
		const id = numberOr0(hwc.id)
		if (!Number.isInteger(id) || id <= 0) continue
		const type = numberOr0(hwc.type)
		const override = asObject(hwc.typeOverride)
		const typeDef = mergeTypeDef(asObject(typeIndex[String(type)]) ?? {}, override)
		const input = type === 0 ? '' : stringOrEmpty(typeDef.in)
		const w = numberOr0(typeDef.w)
		controls.push({
			hwc: id,
			x: numberOr0(hwc.x),
			y: numberOr0(hwc.y),
			label: stringOrEmpty(hwc.txt),
			kind: classify(input),
			typeKey: override ? `${type}+${JSON.stringify(override)}` : String(type),
			input,
			output: stringOrEmpty(typeDef.out),
			hasDisplay: asObject(typeDef.disp) !== undefined,
			w,
			h: numberOr0(typeDef.h) || w,
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

type UsableControl = TopologyControl & { kind: LayoutControl['kind'] }

/**
 * Move each control that is alone in its row into the nearest row holding more than one control:
 * the row whose mean centre is closest to the control's centre (the upper row on a tie). With no
 * such row, nothing moves. Returns each item's row, renumbered to be contiguous, and the indexes
 * of the controls that moved.
 */
function mergeLoneRows(centres: number[], rows: number[]): { rows: number[]; moved: Set<number> } {
	const members = new Map<number, number[]>()
	rows.forEach((row, i) => members.set(row, [...(members.get(row) ?? []), i]))
	const targets = [...members]
		.filter(([, items]) => items.length > 1)
		.map(([row, items]) => ({ row, centre: items.reduce((sum, i) => sum + centres[i], 0) / items.length }))
		.sort((a, b) => a.row - b.row)

	const merged = [...rows]
	const moved = new Set<number>()
	if (targets.length > 0) {
		for (const items of members.values()) {
			if (items.length !== 1) continue
			const i = items[0]
			let nearest = targets[0]
			for (const target of targets) {
				if (Math.abs(centres[i] - target.centre) < Math.abs(centres[i] - nearest.centre)) nearest = target
			}
			merged[i] = nearest.row
			moved.add(i)
		}
	}
	const order = [...new Set(merged)].sort((a, b) => a - b)
	return { rows: merged.map((row) => order.indexOf(row)), moved }
}

/** The free column nearest `column` in `row`, trying right before left at equal distance. */
function nearestFreeColumn(occupied: Set<string>, row: number, column: number): number {
	for (let distance = 0; ; distance++) {
		if (!occupied.has(`${row}/${column + distance}`)) return column + distance
		if (column - distance >= 0 && !occupied.has(`${row}/${column - distance}`)) return column - distance
	}
}

/**
 * Build the Companion layout from the topology. Buttons and encoders become controls; analog,
 * input-less and unknown controls are left out. Columns and rows mirror the physical panel:
 *
 * 1. x and y are ranked, with controls whose physical extents mostly overlap on an axis sharing a
 *    column or row (see `rank`).
 * 2. A control alone in its row joins the nearest row with more than one control (see
 *    `mergeLoneRows`).
 * 3. Controls take their ranked column; one that lands on an occupied cell moves right to the next
 *    free column. Controls that joined another row are placed last, on the nearest free column.
 * 4. Within a row, neighbours of the same topology type close up: each takes the column right after
 *    the previous one when that is its neighbour. This only moves controls left and past no other
 *    control, so it cannot collide.
 */
export function buildLayout(topology: Topology): PanelLayout {
	const seen = new Set<number>()
	const usable = topology.controls
		.filter((c): c is UsableControl => c.kind === 'button' || c.kind === 'encoder' || c.kind === 'encoder-push')
		.sort((a, b) => a.hwc - b.hwc)
		.filter((c) => !seen.has(c.hwc) && seen.add(c.hwc))

	const columns = rank(usable.map((c) => ({ centre: c.x, size: c.w || DEFAULT_SIZE })))
	const { rows, moved } = mergeLoneRows(
		usable.map((c) => c.y),
		rank(usable.map((c) => ({ centre: c.y, size: c.h || DEFAULT_SIZE }))),
	)

	const occupied = new Set<string>()
	const cells = new Array<{ row: number; column: number }>(usable.length)
	const place = (i: number, column: number) => {
		occupied.add(`${rows[i]}/${column}`)
		cells[i] = { row: rows[i], column }
	}
	usable.forEach((_, i) => {
		if (moved.has(i)) return
		let column = columns[i]
		while (occupied.has(`${rows[i]}/${column}`)) column++
		place(i, column)
	})
	for (const i of moved) place(i, nearestFreeColumn(occupied, rows[i], columns[i]))

	const byCell = usable
		.map((_, i) => i)
		.sort((a, b) => cells[a].row - cells[b].row || cells[a].column - cells[b].column)
	byCell.forEach((i, n) => {
		const previous = byCell[n - 1]
		if (previous === undefined || cells[previous].row !== cells[i].row) return
		if (usable[previous].typeKey === usable[i].typeKey) cells[i].column = cells[previous].column + 1
	})

	const controls: LayoutControl[] = usable.map((c, i) => ({
		controlId: `hwc/${c.hwc}`,
		hwc: c.hwc,
		kind: c.kind,
		hasLed: c.output !== '',
		hasDisplay: c.hasDisplay,
		row: cells[i].row,
		column: cells[i].column,
	}))

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
