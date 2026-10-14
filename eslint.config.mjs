import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

const baseConfig = await generateEslintConfig({
	enableTypescript: true,
})

const customConfig = [
	...baseConfig,

	{
		// Tests import devDependencies such as vitest
		files: ['**/__tests__/**/*'],
		rules: {
			'n/no-unpublished-import': 'off',
		},
	},
]

export default customConfig
