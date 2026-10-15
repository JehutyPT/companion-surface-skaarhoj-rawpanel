/**
 * Connection settings: the remote connection config fields (address, port, control positions).
 * They arrive before Companion opens the surface, so saving one reconnects (ADR 0005). Owns every
 * connection config field (id, label, tooltip, default, range), `checkConfigMatchesExpression`,
 * and reading one remote connection entry's config into valid connection settings or a rejection
 * (`parseConnectionSettings`).
 */
import type { SomeCompanionInputField } from '@companion-surface/base'
import { formatControlMap, parseControlMap, type ControlMap } from './control-map.js'

const DEFAULT_TCP_PORT = 9923

const PORT_RANGE = { min: 1, max: 65535 } as const

/** The remote connection config fields, in the order Companion shows them. */
export function connectionConfigFields(): SomeCompanionInputField[] {
	return [
		{
			id: 'address',
			type: 'textinput',
			label: 'IP Address',
			default: '',
		},
		{
			id: 'port',
			type: 'number',
			label: 'Port',
			default: DEFAULT_TCP_PORT,
			...PORT_RANGE,
		},
		{
			id: 'controlMap',
			type: 'textinput',
			label: 'Control positions',
			default: '',
			tooltip:
				'Optional. Move controls on the Companion grid: <HWC>=<row>/<column>, separated by commas, e.g. 37=1/5, 38=1/6. Rows and columns start at 0 (top left). Unlisted controls keep their automatic position. Saving reconnects the panel.',
		},
	]
}

/** Companion treats two connection entries with this address and port as the same panel. */
export const CONNECTION_CONFIG_MATCH_EXPRESSION = '$(objA:address) == $(objB:address) && $(objA:port) == $(objB:port)'

/** One remote connection entry's settings, or a rejection when its address or port is unusable. */
export type ConnectionSettings =
	| {
			valid: true
			/** Trimmed */
			address: string
			port: number
			controlMap: ControlMap
			/**
			 * The link's identity: `address:port`, plus the control map in canonical form when it has
			 * entries. Equal keys share one link; the layout is fixed when the surface opens, so a
			 * different map is a different link.
			 */
			linkKey: string
			/** One per skipped control-position entry */
			warnings: string[]
	  }
	| { valid: false }

/**
 * Read a remote connection entry's config. The address must be a non-empty string; a missing port
 * is `DEFAULT_TCP_PORT`, and a port must be a whole number (a numeric string is accepted) in
 * `PORT_RANGE`.
 */
export function parseConnectionSettings(config: Record<string, unknown>): ConnectionSettings {
	const address = typeof config.address === 'string' ? config.address.trim() : ''
	const port = Number(config.port ?? DEFAULT_TCP_PORT)
	if (!address || !Number.isInteger(port) || port < PORT_RANGE.min || port > PORT_RANGE.max) {
		return { valid: false }
	}

	const { map: controlMap, warnings } = parseControlMap(config.controlMap)
	const mapKey = formatControlMap(controlMap)
	const linkKey = mapKey ? `${address}:${port}|${mapKey}` : `${address}:${port}`
	return { valid: true, address, port, controlMap, linkKey, warnings }
}
