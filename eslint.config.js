const eslint = require('@eslint/js');
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');
const globals = require('globals');

module.exports = [
	{
		ignores: ['out/', 'node_modules/']
	},
	{
		linterOptions: {
			reportUnusedDisableDirectives: false
		},
		languageOptions: {
			globals: {
				...globals.node
			}
		}
	},
	eslint.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsparser,
			parserOptions: {
				ecmaVersion: 2022,
				sourceType: 'module'
			},
			globals: {
				...globals.node
			}
		},
		plugins: {
			'@typescript-eslint': tseslint
		},
		rules: {
			'no-control-regex': 'off',
			'no-useless-assignment': 'off',
			'preserve-caught-error': 'off',
			'no-unused-vars': 'off',
			'no-undef': 'off',
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
		}
	}
];
