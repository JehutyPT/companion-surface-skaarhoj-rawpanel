/**
 * The panel's `_panelTopology_HWC` report: parsing, classifying controls and building the
 * Companion surface layout from their physical positions. Nothing here knows about a model or a
 * specific HWC id; everything comes from the report.
 */
import type { SurfaceInputVariable, SurfaceSchemaLayoutDefinition } from '@companion-surface/base'
import type { ControlMap } from './control-map.js'
import type { AnalogMode } from './protocol.js'

export type { AnalogMode } from './protocol.js'

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
	/** The type's `desc`, e.g. `4-Axis Joystick, Left-Right`; empty if none */
	description: string
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

/** An analog control axis, sent to Companion as an input transfer variable. */
export interface AnalogAxis {
	hwc: number
	/** Transfer variable id, e.g. `hwc_60` */
	variableId: string
	/** User-facing name, e.g. `4-Axis Joystick, Left-Right (HWC 60)` */
	name: string
	/** The custom variable name suggested to the user, e.g. `skaarhoj_lr` */
	suggestedVariable: string
	mode: AnalogMode
}

/** The Companion input transfer variable for an axis. */
export function axisTransferVariable(axis: AnalogAxis): SurfaceInputVariable {
	const range = axis.mode === 'Speed' ? '-500 to 500, 0 at rest' : '0 to 1000'
	return {
		id: axis.variableId,
		type: 'input',
		name: axis.name,
		description: `Value ${range}, scaled linearly by this axis's dead zone and saturation settings. The plugin can't create or preselect a variable here: create a custom variable once (suggested name: ${axis.suggestedVariable}, with "persist value" off) and pick it.`,
	}
}

export interface PanelLayout {
	controls: LayoutControl[]
	/** Analog axes, in HWC order; not part of the button layout */
	axes: AnalogAxis[]
	surfaceLayout: SurfaceSchemaLayoutDefinition
	/** A string that is equal for two layouts exactly when Companion would see the same surface */
	signature: string
	/** What applying the control map skipped or moved, for the log */
	mapNotes: string[]
}

/** Style presets by feedback: `default` is colour only (an LED, no display). */
export const DISPLAY_STYLE_PRESET = 'display'
export const TEXT_STYLE_PRESET = 'text'
export const NO_FEEDBACK_STYLE_PRESET = 'none'

const BUTTON_CODES = new Set(['b', 'b2h', 'b2v', 'b4'])
const ANALOG_CODES = new Set(['av', 'ah', 'ar', 'iv', 'ih', 'ir'])
const INTENSITY_CODES = new Set(['iv', 'ih', 'ir'])

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

type UsableControl = TopologyControl & { kind: LayoutControl['kind'] }

/** Buttons and encoders become Companion controls; nothing else does. */
function isUsable(control: TopologyControl): control is UsableControl {
	return control.kind === 'button' || control.kind === 'encoder' || control.kind === 'encoder-push'
}

/**
 * Parse the JSON of a `_panelTopology_HWC=` reply. Throws if it is not a usable topology: not
 * JSON, no `HWc` array, or no button or encoder to lay out.
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
			description: stringOrEmpty(typeDef.desc),
			kind: classify(input),
			typeKey: override ? `${type}+${JSON.stringify(override)}` : String(type),
			input,
			output: stringOrEmpty(typeDef.out),
			hasDisplay: asObject(typeDef.disp) !== undefined,
			w,
			h: numberOr0(typeDef.h) || w,
		})
	}
	if (!controls.some(isUsable)) throw new Error('Topology has no buttons or encoders')
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
 * 5. The control map, if any, then overrides positions (see `applyControlMap`).
 */
export function buildLayout(topology: Topology, controlMap: ControlMap = new Map()): PanelLayout {
	// One control per HWC id: the first one listed wins.
	const byHwc = new Map<number, UsableControl>()
	for (const control of topology.controls.filter(isUsable)) {
		if (!byHwc.has(control.hwc)) byHwc.set(control.hwc, control)
	}
	const usable = [...byHwc.values()].sort((a, b) => a.hwc - b.hwc)

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
	const mapNotes = applyControlMap(topology, usable, cells, controlMap)

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

	const axes = buildAxes(topology)
	return { controls, axes, surfaceLayout, signature: JSON.stringify({ controls, axes }), mapNotes }
}

/**
 * Put each mapped control on its cell, in map order. An entry for a HWC that is not a button or
 * encoder on this panel, or for a cell an earlier entry took, is skipped. Then every other control,
 * taken by row and column, keeps its cell if free or moves right to the next free column in its
 * row, so a control on a mapped cell pushes the ones after it along until a gap. Nothing is
 * dropped. Updates `cells` in place and returns notes for what was skipped or moved.
 */
function applyControlMap(
	topology: Topology,
	usable: UsableControl[],
	cells: { row: number; column: number }[],
	controlMap: ControlMap,
): string[] {
	const notes: string[] = []
	if (controlMap.size === 0) return notes

	const indexByHwc = new Map(usable.map((c, i) => [c.hwc, i]))
	const occupied = new Set<string>()
	const mapped = new Set<number>()
	for (const [hwc, cell] of controlMap) {
		const i = indexByHwc.get(hwc)
		if (i === undefined) {
			const control = topology.controls.find((c) => c.hwc === hwc)
			notes.push(
				!control
					? `Control positions: HWC ${hwc} is not on this panel; ignored`
					: control.kind === 'analog'
						? `Control positions: HWC ${hwc} (${control.label}) is an analog control, sent as a variable, not a button; ignored`
						: `Control positions: HWC ${hwc} (${control.label}) is not a button or encoder; ignored`,
			)
			continue
		}
		const key = `${cell.row}/${cell.column}`
		if (occupied.has(key)) {
			notes.push(
				`Control positions: row ${cell.row} column ${cell.column} is already taken; HWC ${hwc} keeps its position`,
			)
			continue
		}
		occupied.add(key)
		cells[i] = { ...cell }
		mapped.add(i)
	}

	const others = usable
		.map((_, i) => i)
		.filter((i) => !mapped.has(i))
		.sort((a, b) => cells[a].row - cells[b].row || cells[a].column - cells[b].column)
	for (const i of others) {
		const { row } = cells[i]
		let column = cells[i].column
		while (occupied.has(`${row}/${column}`)) column++
		if (column !== cells[i].column) {
			notes.push(`Control positions: HWC ${usable[i].hwc} moved to ${row}/${column} to make room for a mapped control`)
		}
		occupied.add(`${row}/${column}`)
		cells[i] = { row, column }
	}
	return notes
}

function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
}

/**
 * One axis per analog control (first listed wins per HWC). The suggested custom variable name is
 * `skaarhoj_<label>`, with `_<hwc>` added when the label is shared, or `skaarhoj_hwc_<hwc>` when
 * there is no label.
 */
function buildAxes(topology: Topology): AnalogAxis[] {
	const byHwc = new Map<number, TopologyControl>()
	for (const control of topology.controls) {
		if (control.kind === 'analog' && !byHwc.has(control.hwc)) byHwc.set(control.hwc, control)
	}
	const analog = [...byHwc.values()].sort((a, b) => a.hwc - b.hwc)
	const labelCounts = new Map<string, number>()
	for (const c of analog) {
		const label = slug(c.label)
		labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1)
	}

	return analog.map((c) => {
		const label = slug(c.label)
		const suggestion = !label ? `hwc_${c.hwc}` : (labelCounts.get(label) ?? 0) > 1 ? `${label}_${c.hwc}` : label
		const codes = c.input.split(',').map((code) => code.trim())
		return {
			hwc: c.hwc,
			variableId: `hwc_${c.hwc}`,
			name: `${c.description || c.label || 'Analog control'} (HWC ${c.hwc})`,
			suggestedVariable: `skaarhoj_${suggestion}`,
			mode: codes.some((code) => INTENSITY_CODES.has(code)) ? 'Speed' : 'Abs',
		}
	})
}

function stylePresetFor(control: LayoutControl): string | undefined {
	if (control.hasDisplay) return control.hasLed ? DISPLAY_STYLE_PRESET : TEXT_STYLE_PRESET
	return control.hasLed ? undefined : NO_FEEDBACK_STYLE_PRESET
}
