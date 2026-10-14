import { describe, expect, test } from 'vitest'
import RawPanelPlugin from '../main.js'

describe('RawPanelPlugin', () => {
	test('exposes a remote with address, port and control map config fields', () => {
		const fields = RawPanelPlugin.remote?.configFields ?? []
		expect(fields.map((f) => f.id)).toEqual(['address', 'port', 'controlMap'])
		expect(fields.find((f) => f.id === 'port')).toMatchObject({ default: 9923, min: 1, max: 65535 })
	})
})
