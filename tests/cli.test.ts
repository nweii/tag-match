// Runs the source CLI as a subprocess to verify JSON-only output and preview coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { record } from '../src/config.ts';

async function cli(args: string[], input = '', mockNetwork = false): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const preload = mockNetwork ? ['--import', './tests/fixtures/fetch-stub.mjs'] : [];
    const child = spawn(process.execPath, [...preload, '--experimental-strip-types', 'scripts/cli/cli.ts', ...args], { cwd: process.cwd() });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('help writes prose to stdout without needing config', async () => {
  const result = await cli(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: tag-match/);
  assert.equal(result.stderr, '');
});

test('preview preserves a saved literal percentage after exclusions and existing tags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-test-'));
  const configPath = join(directory, 'data.json');
  await writeFile(configPath, JSON.stringify({ poolMode: 'percent', poolPercent: 50, excludedTags: 'private/*' }));
  const input = JSON.stringify({ note: { title: 'Example', body: 'Body', existingTags: ['existing'] }, tags: [
    { tag: 'popular', count: 10 }, { tag: 'existing', count: 9 }, { tag: 'private/one', count: 8 },
    { tag: 'middle', count: 5 }, { tag: 'rare', count: 1 },
  ] });
  const result = await cli(['preview', '--config', configPath], input);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const output: unknown = JSON.parse(result.stdout);
  assert.ok(record(output) && record(output.pool) && Array.isArray(output.pool.tags));
  const poolTags = output.pool.tags as unknown[];
  assert.equal(poolTags.length, 2);
  const frequent: unknown = poolTags[0];
  const discovery: unknown = poolTags[1];
  assert.ok(record(frequent) && frequent.tag === 'popular' && frequent.reason === 'frequent');
  assert.ok(record(discovery) && discovery.reason === 'discovery');
  assert.ok(Array.isArray(output.pool.inspected));
  const inspected = output.pool.inspected as unknown[];
  assert.deepEqual(Object.fromEntries(inspected.map(item => record(item) ? [item.tag, item.status] : [])), {
    popular: 'included', existing: 'already-present', 'private/one': 'excluded',
    middle: discovery.tag === 'middle' ? 'included' : 'outside-pool',
    rare: discovery.tag === 'rare' ? 'included' : 'outside-pool',
  });
  assert.equal(output.pool.eligible, 3);
  assert.equal(output.batches, 1);
});

test('preview checks every eligible tag below the automatic 250-tag floor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-auto-'));
  const configPath = join(directory, 'data.json');
  await writeFile(configPath, JSON.stringify({ poolMode: 'auto', excludedTags: 'excluded' }));
  const tags = [
    { tag: 'excluded', count: 200 }, { tag: 'existing', count: 199 },
    ...Array.from({ length: 101 }, (_, index) => ({ tag: `eligible-${index}`, count: 101 - index })),
  ];
  const result = await cli(['preview', '--config', configPath], JSON.stringify({
    note: { title: 'Example', body: 'Body', existingTags: ['existing'] }, tags,
  }));
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout) as { pool: { eligible: number; tags: unknown[] } };
  assert.equal(output.pool.eligible, 101);
  assert.equal(output.pool.tags.length, 101);
});

test('CLI review and apply form a snapshot-bound non-network write workflow', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-cli-review-'));
  const configPath = join(directory, 'data.json');
  const notePath = join(directory, 'note.md');
  await writeFile(configPath, JSON.stringify({ apiKey: 'test-key', poolMode: 'all' }));
  await writeFile(notePath, '---\ntags: [existing]\n---\nDesign note\n');
  const input = JSON.stringify({ tags: [{ tag: 'design', count: 3 }, { tag: 'writing', count: 2 }] });
  const reviewed = await cli(['review', '--note', notePath, '--config', configPath], input, true);
  assert.equal(reviewed.code, 0);
  const plan = JSON.parse(reviewed.stdout) as { status: string; proposedTags: { tag: string }[] };
  assert.equal(plan.status, 'review-ready');
  assert.deepEqual(plan.proposedTags.map(item => item.tag), ['design']);
  assert.doesNotMatch(await readFile(notePath, 'utf8'), /design/);
  const original = await readFile(notePath, 'utf8');
  await writeFile(notePath, `${original}Changed after review\n`);
  const stale = await cli(['apply', '--config', configPath], JSON.stringify({ plan, selectedTags: ['design'] }));
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /changed after analysis/);
  assert.equal(await readFile(notePath, 'utf8'), `${original}Changed after review\n`);
  await writeFile(notePath, original);
  const applied = await cli(['apply', '--config', configPath], JSON.stringify({ plan, selectedTags: ['design'] }));
  assert.equal(applied.code, 0);
  assert.deepEqual(JSON.parse(applied.stdout), { status: 'applied', path: await realpath(notePath), addedTags: ['design'] });
  assert.match(await readFile(notePath, 'utf8'), /tags: \[\sexisting, design\s\]/);
});

test('CLI quick apply writes only complete mocked recommendations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-cli-quick-'));
  const configPath = join(directory, 'data.json');
  const notePath = join(directory, 'note.md');
  await writeFile(configPath, JSON.stringify({ apiKey: 'test-key', poolMode: 'all' }));
  await writeFile(notePath, 'Design note\n');
  const input = JSON.stringify({ tags: [{ tag: 'design', count: 3 }, { tag: 'writing', count: 2 }] });
  const result = await cli(['quick-apply', '--note', notePath, '--config', configPath], input, true);
  assert.equal(result.code, 0);
  const output = JSON.parse(result.stdout) as { status: string; path: string; addedTags: string[] };
  assert.deepEqual({ status: output.status, path: output.path, addedTags: output.addedTags },
    { status: 'applied', path: await realpath(notePath), addedTags: ['design'] });
  assert.match(await readFile(notePath, 'utf8'), /tags:\n\s{2}- design/);
});

test('errors use stderr and leave stdout empty', async () => {
  const result = await cli(['preview', '--config', '/missing/config.json'], '{}');
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Could not read config/);
});
