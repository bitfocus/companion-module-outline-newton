import { generateEslintConfig } from '@companion-module/tools/eslint/config.mjs'

export default [
	...(await generateEslintConfig({
		enableTypescript: true,
	})),
	{
		// Protocol tests deliberately import the compiled module. `dist/` is
		// generated and gitignored, so checking these paths before a build would
		// make the documented standalone lint command depend on build artifacts.
		files: ['tests/**/*.mjs'],
		rules: {
			'n/no-missing-import': 'off',
		},
	},
]
