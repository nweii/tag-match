// Exercises publication failures that must block a manifest bump and the complete public release that permits it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { releaseFiles, verifyPublishedRelease } from '../scripts/check-release.ts';

const version = '0.4.2';
const assets = {
  'main.js': Buffer.from('// Tag Match release bundle\n'),
  'manifest.json': Buffer.from('{"id":"tag-match","name":"Tag Match","version":"0.4.2"}\n'),
  'styles.css': Buffer.from('.tag-match {}\n'),
};

function published() {
  return { tag_name: version, draft: false, prerelease: false,
    assets: releaseFiles.map(name => ({ name, state: 'uploaded', size: assets[name].length })) };
}

function requests(release: unknown = published(), downloads: Partial<Record<typeof releaseFiles[number], string | number>> = {}) {
  return async (url: string): Promise<Response> => {
    if (url.startsWith('https://api.github.com/')) {
      return typeof release === 'number' ? new Response('', { status: release }) : Response.json(release);
    }
    const name = releaseFiles.find(file => url === `https://github.com/nweii/tag-match/releases/download/${version}/${file}`);
    assert.ok(name, `Unexpected public download ${url}`);
    const content = downloads[name] ?? assets[name].toString();
    return typeof content === 'number' ? new Response('', { status: content }) : new Response(content);
  };
}

test('manifest promotion rejects a missing release, draft, prerelease, or mismatched tag', async () => {
  for (const release of [404, { ...published(), draft: true }, { ...published(), prerelease: true },
    { ...published(), tag_name: 'v0.4.2' }, null]) {
    await assert.rejects(verifyPublishedRelease(version, assets, requests(release)));
  }
});

test('manifest promotion requires all three uploaded Obsidian assets', async () => {
  for (const name of releaseFiles) {
    const release = published();
    release.assets = release.assets.filter(asset => asset.name !== name);
    await assert.rejects(verifyPublishedRelease(version, assets, requests(release)), new RegExp(name.replace('.', '\\.')));
  }
  const pending = published();
  pending.assets[0]!.state = 'open';
  await assert.rejects(verifyPublishedRelease(version, assets, requests(pending)), /main\.js/);
});

test('manifest promotion rejects assets that users cannot download or that differ from the candidate build', async () => {
  for (const name of releaseFiles) {
    await assert.rejects(verifyPublishedRelease(version, assets, requests(published(), { [name]: 404 })), /cannot serve/);
    await assert.rejects(verifyPublishedRelease(version, assets, requests(published(), { [name]: 'Wrong release content' })), /differs/);
  }
});

test('manifest promotion permits a public stable release with matching anonymous downloads', async () => {
  await verifyPublishedRelease(version, assets, requests());
});

test('manifest promotion fails closed when GitHub or the network is unavailable', async () => {
  await assert.rejects(verifyPublishedRelease(version, assets, requests(503)), /HTTP 503/);
  await assert.rejects(verifyPublishedRelease(version, assets, async () => { throw new Error('Offline'); }), /Offline/);
});

test('an unchanged manifest needs no build or network access, and an unknown base fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-release-check-'));
  await writeFile(join(directory, 'manifest.json'), assets['manifest.json']);
  execFileSync('git', ['init', '-q'], { cwd: directory });
  execFileSync('git', ['add', 'manifest.json'], { cwd: directory });
  execFileSync('git', ['-c', 'user.name=Release test', '-c', 'user.email=release-test@example.invalid', 'commit', '-qm', 'Fixture'], { cwd: directory });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim();
  const script = resolve('scripts/check-release.ts');
  const run = (ref: string) => spawnSync(process.execPath, ['--experimental-strip-types', script, ref], { cwd: directory, encoding: 'utf8' });
  const unchanged = run(base);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.match(unchanged.stdout, /unchanged/);
  const invalid = run('missing');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /base commit SHA/);
  assert.equal(run('0'.repeat(40)).status, 1);
});
