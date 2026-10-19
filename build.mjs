// Builds the Obsidian plugin and companion CLI for release or an isolated development installation.
import { build } from 'esbuild';
import { chmod, mkdir, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
process.chdir(root);
const arguments_ = process.argv.slice(2);
if (arguments_.some(argument => argument !== '--dev') || arguments_.length > 1) {
  throw new Error('Usage: node build.mjs [--dev]');
}
const development = arguments_.includes('--dev');
let buildStamp = '';
if (development) {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== '';
    buildStamp = `${commit}${dirty ? '+' : ''}`;
  } catch {
    buildStamp = 'unknown';
  }
}
const output = development ? join('dist', 'tag-match-dev') : '.';
await mkdir(output, { recursive: true });
const yamlLicense = await readFile('node_modules/yaml/LICENSE', 'utf8');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const version = String(manifest.version);
const licenseFooter = `/*\nBundled dependency notice for yaml:\n${yamlLicense}\n*/`;
const channelDefinitions = {
  __TAG_MATCH_BUILD__: JSON.stringify(buildStamp),
  __TAG_MATCH_DEVELOPMENT__: JSON.stringify(development),
};
// A fixed version makes the CLI's content identity stable across plugin-only version bumps.
// The reference also excludes the build stamp so identical CLI code shares an identity between commits.
const reference = await build({ absWorkingDir: root, entryPoints: ['scripts/cli/cli.ts'], bundle: true, write: false,
  format: 'esm', platform: 'node', target: 'node22',
  define: { ...channelDefinitions, __TAG_MATCH_BUILD__: JSON.stringify(''), __TAG_MATCH_VERSION__: JSON.stringify('0.0.0') },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
  footer: { js: licenseFooter } });
const cliIdentity = `sha256:${createHash('sha256').update(reference.outputFiles[0].contents).digest('hex')}`;

await build({ absWorkingDir: root, entryPoints: ['src/main.ts'], outfile: join(output, 'main.js'), bundle: true,
  format: 'cjs', platform: 'browser', target: 'es2022', external: ['obsidian'], minifySyntax: true,
  define: { ...channelDefinitions, __TAG_MATCH_CLI_IDENTITY__: JSON.stringify(cliIdentity) },
  banner: { js: `// Tag Match: Obsidian interface for shared tag evaluation.${development ? ` Development build ${version} (${buildStamp}).` : ''}` },
  footer: { js: licenseFooter } });
const cliPath = development ? join(output, 'tag-match.mjs') : 'dist/tag-match.mjs';
await build({ absWorkingDir: root, entryPoints: ['scripts/cli/cli.ts'], outfile: cliPath, bundle: true,
  format: 'esm', platform: 'node', target: 'node22',
  define: { ...channelDefinitions, __TAG_MATCH_VERSION__: JSON.stringify(version) },
  banner: { js: `#!/usr/bin/env node\n// tag-match-cli-version: ${version}\n// tag-match-cli-identity: ${cliIdentity}\n${development ? `// tag-match-cli-build: ${buildStamp}\n` : ''}// Tag Match: command-line interface for shared tag evaluation.\nimport { createRequire } from "node:module"; const require = createRequire(import.meta.url);` },
  footer: { js: licenseFooter } });
await chmod(cliPath, 0o755);
if (development) {
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify({ ...manifest, id: 'tag-match-dev', name: 'Tag Match Dev' }, null, 2)}\n`);
  await copyFile('styles.css', join(output, 'styles.css'));
  await copyFile('docs/agent-cli.md', join(output, 'AGENT-CLI.md'));
  await writeFile(join(output, 'build-info.json'), `${JSON.stringify({ channel: 'development', version, build: buildStamp, cliIdentity }, null, 2)}\n`);
} else {
  await rm('dist/tag-match', { recursive: true, force: true });
  await rm('dist/tag-match-agent', { recursive: true, force: true });
  await mkdir('dist/tag-match', { recursive: true });
  await mkdir('dist/tag-match-agent', { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) {
    await copyFile(file, `dist/tag-match/${file}`);
  }
  await copyFile(cliPath, 'dist/tag-match-agent/tag-match.mjs');
  await chmod('dist/tag-match-agent/tag-match.mjs', 0o755);
  await copyFile('docs/agent-cli.md', 'dist/tag-match-agent/AGENT-CLI.md');
}
