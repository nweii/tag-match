// Applies Obsidian's recommended plugin lint rules with Node globals for CLI and test code.
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
    files: ['src/cli.ts', 'src/cli-workflow.ts', 'src/credentials.ts', 'tests/**/*.ts', 'tests/fixtures/*.mjs', 'scripts/*.mjs', 'build.mjs', 'version-bump.mjs'],
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
    files: ['src/cli.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    files: ['src/client.ts'],
    // This module also runs in Node, where window does not exist.
    rules: { 'obsidianmd/prefer-window-timers': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off', 'obsidianmd/no-global-this': 'off' },
  },
]);
