import { describe, expect, test } from 'vitest'
import type { SurfaceContext } from '@companion-surface/base'
import RawPanelPlugin from '../main.js'

describe('RawPanelPlugin', () => {
	test('exposes a remote with address and port config fields', () => {
		const fields = RawPanelPlugin.remote?.configFields ?? []
		expect(fields.map((f) => f.id)).toEqual(['address', 'port'])
		expect(fields.find((f) => f.id === 'port')).toMatchObject({ default: 9923, min: 1, max: 65535 })
	})

	test('openSurface is not implemented yet', async () => {
		await expect(
			RawPanelPlugin.openSurface('rawpanel:test', { address: '', port: 9923 }, {} as SurfaceContext),
		).rejects.toThrow('Not implemented')
	})
})
