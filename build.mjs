// Builds the Obsidian plugin and a CLI that share the same tagging implementation.
import { build } from 'esbuild';
import { chmod, mkdir, copyFile, readFile, rm } from 'node:fs/promises';

const yamlLicense = await readFile('node_modules/yaml/LICENSE', 'utf8');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const version = String(manifest.version);
const licenseFooter = `/*\nBundled dependency notice for yaml:\n${yamlLicense}\n*/`;

await build({ entryPoints: ['src/main.ts'], outfile: 'main.js', bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022', external: ['obsidian'],
  banner: { js: '// Tag Match: Obsidian interface for shared tag evaluation.' },
  footer: { js: licenseFooter } });
await build({ entryPoints: ['src/cli.ts'], outfile: 'dist/tag-match.mjs', bundle: true,
  format: 'esm', platform: 'node', target: 'node22',
  define: { __TAG_MATCH_VERSION__: JSON.stringify(version) },
  banner: { js: `#!/usr/bin/env node\n// tag-match-cli-version: ${version}\n// Tag Match: command-line interface for shared tag evaluation.\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);` },
  footer: { js: licenseFooter } });
await chmod('dist/tag-match.mjs', 0o755);
await rm('dist/tag-match', { recursive: true, force: true });
await rm('dist/tag-match-agent', { recursive: true, force: true });
await mkdir('dist/tag-match', { recursive: true });
await mkdir('dist/tag-match-agent', { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  await copyFile(file, `dist/tag-match/${file}`);
}
await copyFile('dist/tag-match.mjs', 'dist/tag-match-agent/tag-match.mjs');
await chmod('dist/tag-match-agent/tag-match.mjs', 0o755);
await copyFile('docs/agent-cli.md', 'dist/tag-match-agent/AGENT-CLI.md');
