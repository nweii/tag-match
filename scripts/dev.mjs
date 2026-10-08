#!/usr/bin/env node
// Builds and installs Tag Match Dev without changing the stable plugin or either plugin's settings.
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = 'Usage: node scripts/dev.mjs --vault PATH [--config-dir .obsidian]\n       node scripts/dev.mjs --build-only';
const files = ['main.js', 'manifest.json', 'styles.css', 'tag-match.mjs', 'AGENT-CLI.md', 'build-info.json'];

async function existing(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function inside(parent, path) {
  const suffix = relative(parent, path);
  return suffix === '' || (!suffix.startsWith('..') && !isAbsolute(suffix));
}

async function install(vaultArgument, configDirectory) {
  const vault = await realpath(resolve(vaultArgument));
  if (!(await lstat(vault)).isDirectory()) throw new Error('The vault path must be a directory.');
  if (isAbsolute(configDirectory) || !inside(vault, resolve(vault, configDirectory))) {
    throw new Error('--config-dir must be a relative directory inside the vault.');
  }
  const config = resolve(vault, configDirectory);
  if (config === vault) throw new Error('--config-dir must name a configuration directory, not the vault root.');
  if (relative(vault, config).split(/[\\/]/).some((part, index, parts) => part === 'tag-match' && parts[index - 1] === 'plugins')) {
    throw new Error('The configuration directory must not be inside the stable plugin.');
  }
  const plugins = join(config, 'plugins');
  const destination = join(plugins, 'tag-match-dev');
  // Resolve each existing component before creating anything, including configuration-directory aliases.
  let component = config;
  while (inside(vault, component) && component !== vault) {
    if (await existing(component)) {
      if (!inside(vault, await realpath(component))) throw new Error('The development target must stay inside the vault.');
    }
    component = dirname(component);
  }
  for (const directory of [config, plugins, destination]) {
    const status = await existing(directory);
    if (status?.isSymbolicLink()) throw new Error('The development installation directories must not be symbolic links.');
    if (status && !status.isDirectory()) throw new Error('The development installation target must be a directory.');
  }
  const installedManifest = join(destination, 'manifest.json');
  if (await existing(installedManifest)) {
    const manifest = JSON.parse(await readFile(installedManifest, 'utf8'));
    if (manifest.id !== 'tag-match-dev') throw new Error('Refusing to replace a plugin whose identity is not tag-match-dev.');
  }
  for (const file of files) {
    const status = await existing(join(destination, file));
    if (status && (!status.isFile() || status.isSymbolicLink())) {
      throw new Error(`Refusing to replace an unsafe development artifact: ${file}.`);
    }
  }
  const result = spawnSync(process.execPath, [join(root, 'build.mjs'), '--dev'], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Development build failed. No installed artifacts were changed.');
  const source = join(root, 'dist', 'tag-match-dev');
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  if (manifest.id !== 'tag-match-dev') throw new Error('Refusing to install a build whose identity is not tag-match-dev.');
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    // Rename replaces hard links rather than modifying their contents through another plugin's path.
    const temporary = join(destination, `.tag-match-dev-${randomUUID()}`);
    await copyFile(join(source, file), temporary);
    await chmod(temporary, file === 'tag-match.mjs' ? 0o755 : 0o644);
    await rename(temporary, join(destination, file));
  }
  console.log(`Installed Tag Match Dev ${manifest.version} in ${destination}.`);
}

try {
  const args = process.argv.slice(2);
  let vault; let configDirectory = '.obsidian'; let buildOnly = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') { console.log(help); process.exit(0); }
    if (argument === '--build-only') { buildOnly = true; continue; }
    if ((argument === '--vault' || argument === '--config-dir') && args[index + 1] && !args[index + 1].startsWith('--')) {
      const value = args[++index];
      if (argument === '--vault') vault = value; else configDirectory = value;
      continue;
    }
    throw new Error(help);
  }
  if (buildOnly && !vault) {
    const result = spawnSync(process.execPath, [join(root, 'build.mjs'), '--dev'], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }
  if (!vault || buildOnly) throw new Error(help);
  await install(vault, configDirectory);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
