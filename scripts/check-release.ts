// Blocks a public manifest version change until users can download the matching release assets.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const releaseFiles = ['main.js', 'manifest.json', 'styles.css'] as const;
type ReleaseAssets = Record<typeof releaseFiles[number], Uint8Array>;
type Request = (url: string) => Promise<Response>;

export async function verifyPublishedRelease(version: string, assets: ReleaseAssets,
  request: Request = url => fetch(url, { signal: AbortSignal.timeout(30_000) })): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('The public manifest must use a stable release version.');
  const repository = 'https://github.com/nweii/tag-match';
  const response = await request(`https://api.github.com/repos/nweii/tag-match/releases/tags/${version}`);
  if (!response.ok) throw new Error(`Publish release ${version} with its assets before merging the manifest bump (HTTP ${response.status}).`);
  const release = await response.json() as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown } | null;
  if (!release || release.tag_name !== version || release.draft !== false || release.prerelease !== false) {
    throw new Error(`Release ${version} must be public, stable, and tagged exactly ${version}.`);
  }
  if (!Array.isArray(release.assets)) throw new Error(`Release ${version} has no asset list.`);
  const uploaded: unknown[] = release.assets;
  for (const name of releaseFiles) {
    if (!uploaded.some(asset => {
      if (!asset || typeof asset !== 'object') return false;
      const item = asset as { name?: unknown; state?: unknown; size?: unknown };
      return item.name === name && item.state === 'uploaded' && typeof item.size === 'number' && item.size > 0;
    })) {
      throw new Error(`Release ${version} is missing the uploaded ${name} asset.`);
    }
    // Anonymous downloads exercise the same public URLs used by Obsidian, including their availability.
    const download = await request(`${repository}/releases/download/${version}/${name}`);
    if (!download.ok) throw new Error(`Release ${version} cannot serve ${name} (HTTP ${download.status}).`);
    if (!Buffer.from(await download.arrayBuffer()).equals(assets[name])) {
      throw new Error(`Release ${version} ${name} differs from this branch. Publish the matching assets before merging.`);
    }
  }
}

async function main(): Promise<void> {
  const base = process.argv[2];
  if (process.argv.length !== 3 || !base || !/^[a-f0-9]{40,64}$/.test(base)) {
    throw new Error('Usage: npm run check:release -- <base commit SHA>');
  }
  const manifest = JSON.parse(await readFile('manifest.json', 'utf8')) as { id: string; name: string; version: string };
  const previous = JSON.parse(execFileSync('git', ['show', `${base}:manifest.json`], { encoding: 'utf8' })) as { version: string };
  if (manifest.id !== 'tag-match' || manifest.name !== 'Tag Match') throw new Error('The public manifest must identify Tag Match.');
  if (manifest.version === previous.version) {
    console.log(`Manifest version ${manifest.version} is unchanged; no release publication is required.`);
    return;
  }
  execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });
  const assets = {
    'main.js': await readFile('main.js'),
    'manifest.json': await readFile('manifest.json'),
    'styles.css': await readFile('styles.css'),
  };
  await verifyPublishedRelease(manifest.version, assets);
  console.log(`Release ${manifest.version} is public and its Obsidian assets match this branch.`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
