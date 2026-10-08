// Verifies development packaging and installation preserve stable artifacts and private settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, link, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = ['main.js', 'manifest.json', 'styles.css', 'tag-match.mjs', 'AGENT-CLI.md', 'build-info.json'];
type BuildInfo = { channel: string; version: string; build: string; cliIdentity: string };

function command(executable: string, args: string[], cwd: string) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  assert.ifError(result.error);
  return { code: result.status, output: result.stdout, error: result.stderr };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-development-'));
  const root = join(directory, 'repo with spaces');
  await mkdir(root);
  for (const file of ['build.mjs', 'manifest.json', 'styles.css', 'src', 'scripts/cli', 'scripts/dev.mjs', 'docs/agent-cli.md']) {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(repository, file), target, { recursive: true });
  }
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
  await writeFile(join(root, '.gitignore'), 'node_modules/\ndist/\nmain.js\n');
  assert.equal(command('git', ['init', '-q'], root).code, 0);
  assert.equal(command('git', ['add', '.'], root).code, 0);
  assert.equal(command('git', ['-c', 'user.name=Build test', '-c', 'user.email=build-test@example.invalid', 'commit', '-qm', 'Fixture'], root).code, 0);
  return { directory, root };
}

async function info(root: string): Promise<BuildInfo> {
  return JSON.parse(await readFile(join(root, 'dist', 'tag-match-dev', 'build-info.json'), 'utf8')) as BuildInfo;
}

function run(root: string, args: string[], cwd = root) {
  return command(process.execPath, [join(root, 'scripts', 'dev.mjs'), ...args], cwd);
}

test('development build isolates release artifacts and identifies the canonical version and checkout', async () => {
  const { root, directory } = await fixture();
  const released = command(process.execPath, [join(root, 'build.mjs')], directory);
  assert.equal(released.code, 0, released.error);
  const releaseFiles = ['main.js', 'manifest.json', 'dist/tag-match.mjs', 'dist/tag-match/main.js', 'dist/tag-match-agent/tag-match.mjs'];
  const snapshots = await Promise.all(releaseFiles.map(file => readFile(join(root, file))));
  const built = run(root, ['--build-only'], directory);
  assert.equal(built.code, 0, built.error);
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as { id: string; version: string };
  const devManifest = JSON.parse(await readFile(join(root, 'dist', 'tag-match-dev', 'manifest.json'), 'utf8')) as { id: string; name: string; version: string };
  assert.deepEqual({ id: devManifest.id, name: devManifest.name, version: devManifest.version },
    { id: 'tag-match-dev', name: 'Tag Match Dev', version: manifest.version });
  const metadata = await info(root);
  assert.equal(metadata.channel, 'development');
  assert.equal(metadata.build, command('git', ['rev-parse', '--short=12', 'HEAD'], root).output.trim());
  const cli = await readFile(join(root, 'dist', 'tag-match-dev', 'tag-match.mjs'), 'utf8');
  const plugin = await readFile(join(root, 'dist', 'tag-match-dev', 'main.js'), 'utf8');
  assert.ok(cli.includes(`// tag-match-cli-version: ${manifest.version}`));
  assert.ok(cli.includes(`// tag-match-cli-build: ${metadata.build}`));
  assert.ok(cli.includes(`// tag-match-cli-identity: ${metadata.cliIdentity}`));
  assert.ok(plugin.includes(metadata.cliIdentity));
  assert.ok(plugin.includes(metadata.build));
  const devVersion = command(process.execPath, [join(root, 'dist', 'tag-match-dev', 'tag-match.mjs'), '--version'], directory);
  assert.equal(devVersion.code, 0, devVersion.error);
  assert.equal(devVersion.output.trim(), `${manifest.version} (development build ${metadata.build})`);
  const devHelp = command(process.execPath, [join(root, 'dist', 'tag-match-dev', 'tag-match.mjs'), '--help'], directory);
  assert.match(devHelp.output, /plugins\/tag-match-dev\/data\.json/);
  const releaseVersion = command(process.execPath, [join(root, 'dist', 'tag-match.mjs'), '--version'], directory);
  assert.equal(releaseVersion.output.trim(), manifest.version);
  assert.doesNotMatch(await readFile(join(root, 'dist', 'tag-match.mjs'), 'utf8'), /tag-match-cli-build:/);
  assert.equal((await stat(join(root, 'dist', 'tag-match-dev', 'tag-match.mjs'))).mode & 0o777, 0o755);
  assert.deepEqual(await Promise.all(releaseFiles.map(file => readFile(join(root, file)))), snapshots);
  await writeFile(join(root, 'uncommitted.txt'), 'Local change\n');
  const dirty = run(root, ['--build-only']);
  assert.equal(dirty.code, 0, dirty.error);
  assert.equal((await info(root)).build, `${metadata.build}+`);
  assert.equal((await info(root)).cliIdentity, metadata.cliIdentity);
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ ...manifest, version: '9.8.7' }));
  const versioned = run(root, ['--build-only']);
  assert.equal(versioned.code, 0, versioned.error);
  assert.equal((await info(root)).version, '9.8.7');
  assert.equal((await info(root)).cliIdentity, metadata.cliIdentity);
});

test('development installs update only their artifacts and preserve settings across repeated installs', async () => {
  const { root, directory } = await fixture();
  const vault = join(directory, 'vault');
  const stable = join(vault, '.obsidian', 'plugins', 'tag-match');
  const development = join(vault, '.obsidian', 'plugins', 'tag-match-dev');
  await mkdir(stable, { recursive: true });
  await mkdir(development, { recursive: true });
  const privateFiles = [join(development, 'data.json'), join(development, 'custom-config.json'), join(vault, '.obsidian', 'secrets.json')];
  for (const file of privateFiles) await writeFile(file, 'Private configuration must remain unchanged\n');
  for (const file of artifacts) await writeFile(join(stable, file), `Stable ${file}\n`);
  const stableBefore = await Promise.all(artifacts.map(file => readFile(join(stable, file))));
  await link(join(stable, 'main.js'), join(development, 'main.js'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const installed = run(root, ['--vault', vault], directory);
    assert.equal(installed.code, 0, installed.error);
    assert.deepEqual(await Promise.all(artifacts.map(file => readFile(join(stable, file)))), stableBefore);
    assert.deepEqual(await Promise.all(privateFiles.map(file => readFile(file, 'utf8'))), privateFiles.map(() => 'Private configuration must remain unchanged\n'));
    for (const file of artifacts) assert.deepEqual(await readFile(join(development, file)), await readFile(join(root, 'dist', 'tag-match-dev', file)));
    assert.equal((await stat(join(development, 'tag-match.mjs'))).mode & 0o777, 0o755);
  }
  assert.equal(await readFile(join(development, 'AGENT-CLI.md'), 'utf8'), await readFile(join(root, 'docs', 'agent-cli.md'), 'utf8'));
  const custom = run(root, ['--vault', vault, '--config-dir', '.obsidian-testing']);
  assert.equal(custom.code, 0, custom.error);
  const customManifest = JSON.parse(await readFile(join(vault, '.obsidian-testing', 'plugins', 'tag-match-dev', 'manifest.json'), 'utf8')) as { id: string };
  assert.equal(customManifest.id, 'tag-match-dev');
});

test('installer refuses another plugin identity, stable-directory aliases, and paths outside the vault', async () => {
  const { root, directory } = await fixture();
  const vault = join(directory, 'vault');
  const development = join(vault, '.obsidian', 'plugins', 'tag-match-dev');
  await mkdir(development, { recursive: true });
  await writeFile(join(development, 'manifest.json'), JSON.stringify({ id: 'tag-match', version: '0.4.0' }));
  const refused = run(root, ['--vault', vault]);
  assert.equal(refused.code, 1);
  assert.match(refused.error, /identity is not tag-match-dev/);
  const unchanged = JSON.parse(await readFile(join(development, 'manifest.json'), 'utf8')) as { id: string };
  assert.equal(unchanged.id, 'tag-match');
  const rootConfig = run(root, ['--vault', vault, '--config-dir', '.']);
  assert.equal(rootConfig.code, 1);
  assert.match(rootConfig.error, /not the vault root/);
  const stableConfig = run(root, ['--vault', vault, '--config-dir', '.obsidian/plugins/tag-match']);
  assert.equal(stableConfig.code, 1);
  assert.match(stableConfig.error, /inside the stable plugin/);
  const outside = run(root, ['--vault', vault, '--config-dir', '../outside']);
  assert.equal(outside.code, 1);
  assert.match(outside.error, /inside the vault/);
  const stable = join(vault, '.stable', 'plugins', 'tag-match');
  await mkdir(stable, { recursive: true });
  await symlink(stable, join(vault, '.stable', 'plugins', 'tag-match-dev'), 'dir');
  const alias = run(root, ['--vault', vault, '--config-dir', '.stable']);
  assert.equal(alias.code, 1);
  assert.match(alias.error, /symbolic links/);
});
