// Runs the source CLI as a subprocess to verify JSON-only output and preview coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { record } from '../src/config.ts';

type CliOutput = { status: string; mode: string; total: number; summary: Record<string, number>;
  pool: { tags: { tag: string }[] }; recommended: { tag: string }[]; addedTags: string[]; results: { status: string }[] };
const output = (text: string) => JSON.parse(text) as CliOutput;

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

test('specific sets and invocation overrides work across preview, suggest, review, apply, and quick apply', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-cli-overrides-'));
  const configPath = join(directory, 'data.json');
  const notePath = join(directory, 'note.md');
  const saved = JSON.stringify({ apiKey: 'test-key', poolMode: 'all', excludedTags: 'new/*', maxTagsToAdd: 5 });
  await writeFile(configPath, saved); await writeFile(notePath, 'Synthetic note\n');
  const overrides = { poolMode: 'specific', onlyTags: 'new/topic, other', maxTagsToAdd: 2 };
  const preview = await cli(['preview', '--config', configPath], JSON.stringify({ overrides,
    note: { title: 'Note', body: 'Body', existingTags: [] } }));
  assert.equal(preview.code, 0, preview.stderr);
  assert.deepEqual(output(preview.stdout).pool.tags.map(item => item.tag), ['new/topic', 'other']);
  const suggested = await cli(['suggest', '--config', configPath, '--only-tags', 'new/topic', '--max-tags', '1'],
    JSON.stringify({ overrides, note: { title: 'Note', body: 'Body', existingTags: [] } }), true);
  assert.equal(suggested.code, 0, suggested.stderr);
  assert.deepEqual(output(suggested.stdout).recommended.map(item => item.tag), ['new/topic']);
  const review = await cli(['review', '--config', configPath, '--note', notePath, '--only-tags', 'new/topic'], '{}', true);
  assert.equal(review.code, 0, review.stderr);
  const applied = await cli(['apply', '--config', configPath], JSON.stringify({ overrides, plan: JSON.parse(review.stdout) as unknown, selectedTags: ['new/topic'] }));
  assert.equal(applied.code, 0, applied.stderr);
  assert.deepEqual(output(applied.stdout).addedTags, ['new/topic']);
  const quick = await cli(['quick-apply', '--config', configPath, '--note', notePath, '--only-tags', 'new/topic, another', '--min-score', '0.8'], '{}', true);
  assert.equal(quick.code, 0, quick.stderr);
  assert.deepEqual(output(quick.stdout).addedTags, ['another']);
  assert.equal(await readFile(configPath, 'utf8'), saved);
});

test('bulk defaults to an offline dry run, applies with recovery, filters reports, and supports offline undo', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-cli-bulk-command-'));
  const configPath = join(directory, 'data.json'); const recovery = join(directory, 'undo.jsonl');
  const paths = [join(directory, 'one.md'), join(directory, 'two.md')];
  await writeFile(configPath, JSON.stringify({ poolMode: 'all' }));
  await Promise.all(paths.map(path => writeFile(path, 'Synthetic note\n')));
  const input = JSON.stringify({ notes: paths, overrides: { poolMode: 'specific', onlyTags: 'new/topic' } });
  const preview = await cli(['bulk', '--config', configPath, '--quiet'], input);
  assert.equal(preview.code, 0, preview.stderr); assert.equal(preview.stderr, '');
  assert.equal(output(preview.stdout).mode, 'dry-run'); assert.equal(output(preview.stdout).summary.previewed, 2);
  await writeFile(configPath, JSON.stringify({ apiKey: 'synthetic-key', poolMode: 'all' }));
  const applied = await cli(['bulk', '--config', configPath, '--apply', '--recovery', recovery, '--quiet', '--filter', 'applied'], input, true);
  assert.equal(applied.code, 0, applied.stderr); assert.equal(applied.stderr, '');
  assert.equal(output(applied.stdout).summary.applied, 2); assert.equal(output(applied.stdout).results.length, 2);
  const previewUndo = await cli(['bulk-undo', '--recovery', recovery]);
  assert.equal(previewUndo.code, 0, previewUndo.stderr); assert.equal(output(previewUndo.stdout).results[0]!.status, 'ready');
  const undo = await cli(['bulk-undo', '--recovery', recovery, '--apply']);
  assert.equal(undo.code, 0, undo.stderr);
  assert.equal(await readFile(paths[0]!, 'utf8'), 'Synthetic note\n');
});

test('bulk partial outcomes remain valid JSON with nonzero exit and summaries retain filtered notes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-cli-bulk-partial-'));
  const configPath = join(directory, 'data.json'); const recovery = join(directory, 'undo.jsonl');
  const good = join(directory, 'good.md'); const broken = join(directory, 'broken.md');
  await writeFile(configPath, JSON.stringify({ apiKey: 'synthetic-key', poolMode: 'specific', onlyTags: 'design' }));
  await writeFile(good, 'Good'); await writeFile(broken, '---\ntags: [broken\n---\nBody');
  const result = await cli(['bulk', '--config', configPath, '--apply', '--recovery', recovery, '--filter', 'failed'], JSON.stringify({ notes: [good, broken] }), true);
  assert.equal(result.code, 1); const report = output(result.stdout);
  assert.equal(report.summary.applied, 1); assert.equal(report.summary.failed, 1); assert.equal(report.total, 2);
  assert.deepEqual(report.results.map(item => item.status), ['failed']);
  assert.ok(result.stderr.split('\n').filter(Boolean).every(line => record(JSON.parse(line))));
});

test('invalid bulk modes, flags, and overrides fail before network or note writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-cli-bulk-invalid-'));
  const configPath = join(directory, 'data.json'); const note = join(directory, 'note.md');
  await writeFile(configPath, '{}'); await writeFile(note, 'Unchanged');
  for (const flags of [['--apply'], ['--dry-run', '--apply'], ['--concurrency', '4'], ['--sort', 'wrong'], ['--max-tags', '1.5'], ['--min-score', '2'], ['--unknown', 'x']]) {
    const result = await cli(['bulk', '--config', configPath, ...flags], JSON.stringify({ notes: [note], tags: [] }));
    assert.equal(result.code, 1); assert.equal(result.stdout, '');
  }
  const invalid = await cli(['preview', '--config', configPath], JSON.stringify({ overrides: { apiKey: 'must-not-be-accepted' } }));
  assert.equal(invalid.code, 1); assert.match(invalid.stderr, /Unknown override/);
  assert.equal(await readFile(note, 'utf8'), 'Unchanged');
});

test('SIGINT returns a cancelled bulk report and preserves undo for completed writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-cli-bulk-signal-'));
  const configPath = join(directory, 'data.json'); const recovery = join(directory, 'undo.jsonl');
  const paths = [join(directory, 'one.md'), join(directory, 'two.md'), join(directory, 'three.md')];
  await writeFile(configPath, JSON.stringify({ apiKey: 'synthetic-key', poolMode: 'specific', onlyTags: 'design' }));
  await Promise.all(paths.map(path => writeFile(path, 'Body')));
  const result = await new Promise<{ code: number; stdout: string }>((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--import', './tests/fixtures/bulk-fetch-stub.mjs', '--experimental-strip-types', 'scripts/cli/cli.ts',
      'bulk', '--config', configPath, '--apply', '--recovery', recovery, '--concurrency', '1'], { cwd: process.cwd() });
    let stdout = ''; let stderr = ''; let cancelled = false;
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk;
      if (!cancelled && stderr.includes('"status":"applied"')) { cancelled = true; child.kill('SIGINT'); }
    });
    child.on('error', reject); child.on('close', code => resolveRun({ code: code ?? -1, stdout }));
    child.stdin.end(JSON.stringify({ notes: paths }));
  });
  assert.equal(result.code, 130);
  const report = output(result.stdout);
  assert.equal(report.status, 'cancelled'); assert.ok(report.summary.applied! >= 1); assert.ok(report.summary.cancelled! >= 1);
  const undo = await cli(['bulk-undo', '--recovery', recovery, '--apply']);
  assert.equal(undo.code, 0, undo.stderr);
  for (const path of paths) assert.equal(await readFile(path, 'utf8'), 'Body');
});
