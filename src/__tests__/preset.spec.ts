/**
 * The PTZ Extreme preset page: the exported page in the repo, and the surface setting that links to it.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { PRESET_PAGE_PATH, PRESET_PAGE_URL, surfaceConfigFields } from '../settings.js'

const repoFile = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url))

describe('preset page setting', () => {
	test('is a static-text field, first in the surface settings, linking to the preset on GitHub', () => {
		const fields = surfaceConfigFields([])
		const field = fields[0]

		expect(field).toMatchObject({ id: 'presetPage', type: 'static-text' })
		if (field.type !== 'static-text') throw new Error('not static-text')
		expect(PRESET_PAGE_URL).toBe(
			`https://github.com/JehutyPT/companion-surface-skaarhoj-rawpanel/blob/main/${PRESET_PAGE_PATH}`,
		)
		expect(field.value).toContain(`](${PRESET_PAGE_URL})`)
		expect(field.value).toMatch(/Import \/ Export/)
	})
})

describe('preset page file', () => {
	const preset = JSON.parse(readFileSync(repoFile(PRESET_PAGE_PATH), 'utf8'))
	const text = JSON.stringify(preset)

	test('is a single-page Companion export named for the PTZ Extreme', () => {
		expect(preset.type).toBe('page')
		expect(preset.page.name).toBe('SKAARHOJ PTZ Extreme')
	})

	test('uses only internal actions and feedbacks: no connections, no images', () => {
		expect(preset.instances).toEqual({})
		expect(preset.connectionCollections).toEqual([])
		expect(preset.imageLibrary).toEqual([])
		const connectionIds = new Set([...text.matchAll(/"connectionId":"([^"]*)"/g)].map((m) => m[1]))
		expect([...connectionIds]).toEqual(['internal'])
	})

	test('every custom variable it uses is listed in HELP.md', () => {
		const help = readFileSync(repoFile('companion/HELP.md'), 'utf8')
		const fromText = [...text.matchAll(/\$\(custom:([A-Za-z0-9_-]+)\)/g)].map((m) => m[1])
		const fromActions = [...text.matchAll(/"name":\{"value":"([A-Za-z0-9_-]+)"/g)].map((m) => m[1])
		const used = [...new Set([...fromText, ...fromActions])].sort()

		expect(used).toContain('skaarhoj_zoom')
		for (const name of used) expect(help).toContain(`\`${name}\``)
	})
})
