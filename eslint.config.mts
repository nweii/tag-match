// Applies Obsidian's plugin rules and production TypeScript checks, with Node globals for CLI and tests.
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';

export default defineConfig([
  { ignores: ['main.js', 'dist/**', 'node_modules/**'] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      globals: globals.browser,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
        },
        extraFileExtensions: ['.json'],
      },
    },
    rules: {
      'obsidianmd/ui/sentence-case': ['warn', { brands: ['Jev', 'Markdown', 'Nathan Cheng', 'Tag Match', 'TypeSafe'], acronyms: ['API', 'CLI'] }],
    },
  },
  {
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'error',
      'no-restricted-syntax': ['error', {
        selector: 'TSAsExpression[expression.type="TSAsExpression"]',
        message: 'Validate the input or use a single justified type assertion instead of a chained assertion.',
      }],
    },
  },
  {
    files: ['scripts/cli/**/*.ts', 'tests/**/*.ts', 'tests/fixtures/*.mjs', 'scripts/*.mjs', 'build.mjs', 'version-bump.mjs'],
    languageOptions: { globals: globals.node },
    rules: {
      'obsidianmd/no-nodejs-modules': 'off',
      'obsidianmd/prefer-window-timers': 'off',
      'obsidianmd/no-global-this': 'off',
      'obsidianmd/rule-custom-message': 'off',
      'no-restricted-globals': 'off',
    },
  },
  {
    files: ['scripts/cli/cli.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off', 'obsidianmd/no-global-this': 'off' },
  },
]);
