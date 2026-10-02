// Exercises CLI batches through temporary Markdown files and mocked providers, including durable undo and interruption.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, utimes, symlink, rename, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, type Config } from '../src/config.ts';
import type { Transport } from '../src/client.ts';
import { bulkTargets, runCliBulk, undoCliBulk, type BulkOptions } from '../scripts/cli/cli-bulk.ts';
import { applyReviewPlan } from '../scripts/cli/cli-workflow.ts';
import { withOverrides } from '../scripts/cli/cli-overrides.ts';
import { MAX_BULK_RECOVERY_CHARACTERS } from '../src/bulk-queue.ts';

const config = (patch: Partial<Config> = {}): Config => ({ ...DEFAULTS, apiKey: 'synthetic-key', poolMode: 'specific', onlyTags: 'new/topic, existing', ...patch });
const signal = () => new AbortController().signal;
const success: Transport = async request => ({ status: 200, json: { answers: Object.fromEntries(
  Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.9 }])) } });
const options = (patch: Partial<BulkOptions> = {}): BulkOptions => ({ mode: 'dry-run', concurrency: 3, signal: signal(), ...patch });

async function fixture(count = 3) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tag-match-cli-bulk-')));
  const paths = Array.from({ length: count }, (_, index) => join(directory, `${index + 1}.md`));
  const original = '\uFEFF---\r\ntags: [existing]\r\n---\r\nPrivate synthetic body\r\n';
  await Promise.all(paths.map(path => writeFile(path, original)));
  const targets = await bulkTargets({ notes: paths }, 'alphabetical', false);
  return { directory, paths, targets, original, recoveryPath: join(directory, 'recovery.jsonl') };
}

test('bulk discovery deduplicates files and folders, preserves inline tags, filters selection, and sorts', async () => {
  const f = await fixture();
  const nested = join(f.directory, 'Projects'); await mkdir(nested);
  const child = join(nested, 'Alpha.md'); await writeFile(child, 'Child');
  await symlink(f.directory, join(nested, 'loop'));
  await symlink(f.paths[0]!, join(f.directory, 'alias.md'));
  await utimes(f.paths[0]!, 10, 10); await utimes(f.paths[1]!, 20, 20);
  const items = await bulkTargets({ folders: [f.directory], notes: [{ path: f.paths[0], existingTags: ['inline'] }, join(f.directory, 'alias.md')],
    excludeNotes: [f.paths[2], child] }, 'modified', false);
  assert.deepEqual(items.map(item => item.path), [f.paths[1], f.paths[0]]);
  assert.deepEqual(items[1]!.existingTags, ['inline']);
  assert.deepEqual((await bulkTargets({ folders: [f.directory] }, 'alphabetical', true, 'Projects')).map(item => item.path), [child]);
  assert.equal((await bulkTargets({ notes: f.paths }, 'created', false)).length, 3);
  await assert.rejects(bulkTargets({ notes: f.paths }, 'modified', false, 'missing'), /No Markdown notes/);
});

test('dry run needs no credentials, makes no requests or writes, and reports the specific set', async () => {
  const f = await fixture(); let calls = 0;
  const output = await runCliBulk(f.targets, [{ tag: 'ignored', count: 50 }], config({ apiKey: '', excludedTags: 'new/*' }),
    () => { calls++; throw new Error('Must not request'); }, options());
  assert.equal(calls, 0); assert.equal(output.estimatedRequests, 3);
  assert.deepEqual(output.results.map(item => item.status), ['previewed', 'previewed', 'previewed']);
  assert.deepEqual(output.results[0]!.preview!.candidateTags, ['new/topic']);
  assert.equal(await readFile(f.paths[0]!, 'utf8'), f.original);
  assert.ok(!JSON.stringify(output).includes('Private synthetic body'));
});

test('suggest runs at most three notes concurrently and returns usable review plans without writing', async () => {
  const f = await fixture(5); let active = 0; let peak = 0;
  const transport: Transport = async (request, key, workSignal, endpoint) => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return success(request, key, workSignal, endpoint);
  };
  const output = await runCliBulk(f.targets, [], config(), transport, options({ mode: 'suggest', concurrency: 99 }));
  assert.equal(peak, 3); assert.equal(output.summary.ready, 5);
  assert.equal(await readFile(f.paths[0]!, 'utf8'), f.original);
  const plan = output.results[0]!.plan!;
  assert.deepEqual((await applyReviewPlan(plan, ['new/topic'], config())).addedTags, ['new/topic']);
});

test('apply saves private undo before writes; undo previews, skips edits, and restores exact originals', async () => {
  const f = await fixture();
  const output = await runCliBulk(f.targets, [], config({ excludedTags: 'new/*' }), success,
    options({ mode: 'apply', recoveryPath: f.recoveryPath }));
  assert.equal(output.summary.applied, 3);
  assert.equal((await stat(f.recoveryPath)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(output).includes('synthetic-key'));
  assert.ok(!JSON.stringify(output).includes('Private synthetic body'));
  const tagged = await readFile(f.paths[0]!, 'utf8');
  assert.match(tagged, /new\/topic/);
  const preview = await undoCliBulk(f.recoveryPath, false, signal());
  assert.deepEqual(preview.results.map(item => item.status), ['ready', 'ready', 'ready']);
  assert.equal(await readFile(f.paths[0]!, 'utf8'), tagged);
  await writeFile(f.paths[1]!, `${tagged}Later edit`);
  const undone = await undoCliBulk(f.recoveryPath, true, signal());
  assert.deepEqual(f.paths.map(path => undone.results.find(item => item.path === path)!.status), ['undone', 'skipped', 'undone']);
  assert.equal(await readFile(f.paths[0]!, 'utf8'), f.original);
  assert.match(await readFile(f.paths[1]!, 'utf8'), /Later edit/);
  const repeated = await undoCliBulk(f.recoveryPath, true, signal());
  assert.deepEqual(f.paths.map(path => repeated.results.find(item => item.path === path)!.status), ['unchanged', 'skipped', 'unchanged']);
  await assert.rejects(runCliBulk(f.targets, [], config(), success, options({ mode: 'apply', recoveryPath: f.recoveryPath })), /EEXIST/);
});

test('stale and malformed notes do not block valid notes or enter undo', async () => {
  const f = await fixture();
  await writeFile(f.paths[1]!, '---\ntags: [broken\n---\nBody');
  let calls = 0;
  const transport: Transport = async (request, key, workSignal, endpoint) => {
    if (++calls === 1) await writeFile(f.paths[0]!, 'Edited during analysis');
    return success(request, key, workSignal, endpoint);
  };
  const output = await runCliBulk(f.targets, [], config(), transport, options({ mode: 'apply', recoveryPath: f.recoveryPath, concurrency: 1 }));
  assert.deepEqual(output.results.map(item => item.status), ['skipped', 'failed', 'applied']);
  assert.equal(calls, 2);
  assert.equal((await undoCliBulk(f.recoveryPath, false, signal())).total, 1);
});

test('provider-wide failures abort in-flight work and skip queued notes without writes', async () => {
  const f = await fixture(5); let calls = 0;
  const transport: Transport = async (_request, _key, workSignal) => {
    if (++calls === 1) return { status: 401, json: {} };
    await new Promise(resolve => setTimeout(resolve, 10));
    workSignal.throwIfAborted(); return { status: 200, json: {} };
  };
  const output = await runCliBulk(f.targets, [], config(), transport, options({ mode: 'apply', recoveryPath: f.recoveryPath }));
  assert.equal(output.summary.failed, 1); assert.equal(output.summary.skipped, 4); assert.ok(calls <= 3);
  assert.equal(await readFile(f.paths[0]!, 'utf8'), f.original);
});

test('cancellation preserves completed additions and durable undo while cancelling remaining notes', async () => {
  const f = await fixture(); const controller = new AbortController(); let calls = 0;
  const transport: Transport = async (request, key, workSignal, endpoint) => {
    if (++calls === 2) controller.abort();
    return success(request, key, workSignal, endpoint);
  };
  const output = await runCliBulk(f.targets, [], config(), transport,
    options({ mode: 'apply', recoveryPath: f.recoveryPath, concurrency: 1, signal: controller.signal }));
  assert.equal(output.status, 'cancelled');
  assert.deepEqual(output.results.map(item => item.status), ['applied', 'cancelled', 'cancelled']);
  assert.equal((await undoCliBulk(f.recoveryPath, true, signal())).results[0]!.status, 'undone');
  assert.equal(await readFile(f.paths[0]!, 'utf8'), f.original);
});

test('note-specific rejection and incomplete candidate batches return no partial additions', async () => {
  const f = await fixture(2); let calls = 0;
  const tags = Array.from({ length: 100 }, (_, index) => ({ tag: `tag-${index}`, count: 100 - index }));
  const transport: Transport = async (request, key, workSignal, endpoint) => ++calls === 2
    ? { status: 422, json: {} } : success(request, key, workSignal, endpoint);
  const output = await runCliBulk(f.targets, tags, config({ poolMode: 'all', definitions: tags.map(({ tag }) => `${tag} = ${'meaning '.repeat(120)}`).join('\n') }),
    transport, options({ mode: 'apply', recoveryPath: f.recoveryPath, concurrency: 1 }));
  assert.deepEqual(output.results.map(item => item.status), ['failed', 'applied']);
  assert.equal(await readFile(f.paths[0]!, 'utf8'), f.original);
  assert.match(output.results[0]!.message!, /no partial suggestions/);
});

test('settings and vocabulary snapshots stay fixed across requests and per-run overrides validate strictly', async () => {
  const f = await fixture(2); const settings = config({ poolMode: 'all', maxTagsToAdd: 1 });
  const tags = [{ tag: 'design', count: 3 }, { tag: 'writing', count: 2 }];
  const seen: string[][] = [];
  const transport: Transport = async (request, key, workSignal, endpoint) => {
    seen.push(Object.values(request.questions).map(question => (question as { instructions: { tag: string } }).instructions.tag));
    settings.maxTagsToAdd = 2; settings.excludedTags = 'design'; tags[0]!.tag = 'mutated';
    return success(request, key, workSignal, endpoint);
  };
  const output = await runCliBulk(f.targets, tags, settings, transport, options({ mode: 'apply', recoveryPath: f.recoveryPath, concurrency: 1 }));
  assert.deepEqual(seen, [['design', 'writing'], ['design', 'writing']]);
  assert.deepEqual(output.results.map(item => item.addedTags), [['design'], ['design']]);
  assert.equal(withOverrides(DEFAULTS, { poolMode: 'specific', onlyTags: 'one, two' }).onlyTags, 'one, two');
  for (const overrides of [{ apiKey: 'secret' }, { maxTagsToAdd: 1.2 }, { minProbability: 2 }, { onlyTags: [] }, { poolMode: 'other' }]) {
    assert.throws(() => withOverrides(DEFAULTS, overrides));
  }
  assert.equal(DEFAULTS.onlyTags, '');
});

test('undo can read a journal with an interrupted tail and never follows changed symlink targets', async () => {
  const f = await fixture(2);
  await runCliBulk(f.targets, [], config(), success, options({ mode: 'apply', recoveryPath: f.recoveryPath }));
  await writeFile(f.recoveryPath, `${await readFile(f.recoveryPath, 'utf8')}{"path":`);
  const moved = join(f.directory, 'moved.md'); await rename(f.paths[1]!, moved);
  const outside = join(f.directory, 'outside.md'); await writeFile(outside, f.original);
  await symlink(outside, f.paths[1]!);
  const undone = await undoCliBulk(f.recoveryPath, true, signal());
  assert.deepEqual(f.paths.map(path => undone.results.find(item => item.path === path)!.status), ['undone', 'skipped']);
  assert.equal(await readFile(outside, 'utf8'), f.original);
});

test('recovery capacity stops before requesting an oversized note or writing any additions', async () => {
  const f = await fixture(2); let calls = 0;
  await writeFile(f.paths[0]!, 'x'.repeat(MAX_BULK_RECOVERY_CHARACTERS / 2 + 1));
  const output = await runCliBulk(f.targets, [], config(), () => { calls++; throw new Error('Must not request'); },
    options({ mode: 'apply', recoveryPath: f.recoveryPath, concurrency: 1 }));
  assert.equal(calls, 0);
  assert.deepEqual(output.results.map(item => item.status), ['failed', 'skipped']);
  assert.match(output.results[0]!.message!, /Undo storage limit/);
  assert.equal((await undoCliBulk(f.recoveryPath, false, signal())).total, 0);
});
