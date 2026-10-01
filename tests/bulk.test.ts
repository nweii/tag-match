// Exercises bulk tagging, cancellation, provider failures, and exact-content undo through the vault boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { App, TFile } from 'obsidian';
import { analyzeBulkItems, applyBulkItem, createBulkItems, undoBulkItem, bulkReport, MAX_BULK_RECOVERY_CHARACTERS } from '../src/bulk.ts';
import { DEFAULTS, type Config } from '../src/config.ts';
import type { Transport } from '../src/client.ts';
import type { TagCount } from '../src/core.ts';
import { applySuggestions } from '../src/vault.ts';

const config = (values: Partial<Config> = {}): Config => ({ ...DEFAULTS, apiKey: 'test-key', poolMode: 'all', ...values });
const tags = (): TagCount[] => [{ tag: 'design', count: 3 }, { tag: 'writing', count: 2 }];
const success: Transport = async request => ({ status: 200, json: { answers: Object.fromEntries(
  Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.9 }])) } });

function vaultFixture(contents: Record<string, string>, counts: TagCount[] = tags()) {
  const files: TFile[] = Object.keys(contents).map(path => ({ path, basename: path.replace(/\.md$/, ''), extension: path.split('.').at(-1) } as never));
  const data = new Map(Object.entries(contents));
  const writes: string[] = [];
  const app = {
    vault: {
      read: (file: TFile) => Promise.resolve(data.get(file.path)!),
      process: (file: TFile, change: (content: string) => string) => {
        const written = change(data.get(file.path)!);
        data.set(file.path, written); writes.push(file.path);
        return Promise.resolve(written);
      },
    },
    metadataCache: { getFileCache: () => null,
      getTags: () => Object.fromEntries(counts.map(item => [`#${item.tag}`, item.count])) },
  };
  return { app: app as unknown as App, boundary: app, files, data, writes };
}

test('explicit new tags write only within the allowed set and retain guarded undo', async () => {
  const fixture = vaultFixture({ 'one.md': 'One', 'two.md': 'Two' }, []);
  const settings = config({ poolMode: 'specific', onlyTags: 'new/topic, second', excludedTags: 'new/topic' });
  const items = createBulkItems(fixture.files);
  await analyzeBulkItems(fixture.app, items, settings, [], success, new AbortController().signal, true, () => {}, () => {}, 3);
  assert.deepEqual(items.map(item => item.status), ['applied', 'applied']);
  assert.deepEqual([...items[0]!.selected], ['new/topic', 'second']);
  await undoBulkItem(fixture.app, items[0]!);
  assert.equal(fixture.data.get('one.md'), 'One');
  for (const [selected, overrides] of [
    [['unlisted'], settings], [['new/topic'], config()],
  ] as const) {
    await assert.rejects(applySuggestions(fixture.app, fixture.files[0]!, 'One', [...selected], [], overrides), /vocabulary or exclusions/);
  }
  fixture.data.set('one.md', 'Edited');
  await assert.rejects(applySuggestions(fixture.app, fixture.files[0]!, 'One', ['new/topic'], [], settings), /note changed/);
});

test('bulk scope deduplicates Markdown files by path and excludes attachments', () => {
  const fixture = vaultFixture({ 'one.md': 'One', 'two.md': 'Two', 'image.png': 'Image' });
  assert.deepEqual(createBulkItems([...fixture.files, ...fixture.files]).map(item => item.file.path), ['one.md', 'two.md']);
});

test('review completes analysis and preselects recommended tags without writing notes', async () => {
  const fixture = vaultFixture({ 'one.md': 'Design', 'two.md': 'Writing' });
  const items = createBulkItems(fixture.files);
  const progress: number[] = [];
  await analyzeBulkItems(fixture.app, items, config(), tags(), success, new AbortController().signal, false,
    (_item, complete) => { progress.push(complete); });
  assert.deepEqual(items.map(item => item.status), ['ready', 'ready']);
  assert.deepEqual([...items[0]!.selected], ['design', 'writing']);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(progress, [1, 2]);
});

test('direct bulk keeps settings, credentials, and inventory fixed across earlier writes', async () => {
  const fixture = vaultFixture({ 'one.md': 'Design', 'two.md': 'Writing' });
  const items = createBulkItems(fixture.files);
  const liveConfig = config({ maxTagsToAdd: 1 });
  const liveTags = tags();
  const seen: { key: string; model: string; candidates: string[] }[] = [];
  const transport: Transport = async (request, key, signal, endpoint) => {
    seen.push({ key, model: request.model, candidates: Object.values(request.questions)
      .map(question => (question as { instructions: { tag: string } }).instructions.tag) });
    liveConfig.apiKey = 'changed'; liveConfig.model = 'changed'; liveConfig.excludedTags = 'design';
    liveConfig.maxTagsToAdd = 2; liveTags[0]!.tag = 'changed'; liveTags[1]!.count = 999;
    liveTags.push({ tag: 'added', count: 1000 });
    return success(request, key, signal, endpoint);
  };
  await analyzeBulkItems(fixture.app, items, liveConfig, liveTags, transport, new AbortController().signal, true, () => {});
  assert.deepEqual(items.map(item => item.status), ['applied', 'applied']);
  assert.deepEqual(seen, Array.from({ length: 2 }, () => ({ key: 'test-key', model: 'jev-latest', candidates: ['design', 'writing'] })));
  for (const item of items) {
    assert.equal(item.selected.size, 1);
    assert.match(fixture.data.get(item.file.path)!, /tags:\n {2}- design/);
  }
});

test('changed notes are skipped while independent notes still receive additions', async () => {
  const fixture = vaultFixture({ 'one.md': 'Design', 'two.md': 'Writing' });
  const items = createBulkItems(fixture.files);
  let calls = 0;
  const transport: Transport = async (request, key, signal, endpoint) => {
    if (++calls === 1) fixture.data.set('one.md', 'Edited after analysis started');
    return success(request, key, signal, endpoint);
  };
  await analyzeBulkItems(fixture.app, items, config(), tags(), transport, new AbortController().signal, true, () => {});
  assert.deepEqual(items.map(item => item.status), ['skipped', 'applied']);
  assert.match(items[0]!.message!, /note changed after analysis/);
  assert.equal(fixture.data.get('one.md'), 'Edited after analysis started');
  assert.deepEqual(fixture.writes, ['two.md']);
});

test('invalid note metadata is isolated without charging a request for that note', async () => {
  const fixture = vaultFixture({ 'one.md': '---\ntags: [broken\n---\nDesign', 'two.md': 'Writing' });
  const items = createBulkItems(fixture.files);
  let calls = 0;
  const transport: Transport = async (request, key, signal, endpoint) => {
    calls++; return success(request, key, signal, endpoint);
  };
  await analyzeBulkItems(fixture.app, items, config(), tags(), transport, new AbortController().signal, true, () => {});
  assert.deepEqual(items.map(item => item.status), ['failed', 'applied']);
  assert.equal(calls, 1);
  assert.deepEqual(fixture.writes, ['two.md']);
});

test('cancellation retains completed notes and prevents late responses from writing', async () => {
  const fixture = vaultFixture({ 'one.md': 'One', 'two.md': 'Two', 'three.md': 'Three' });
  const items = createBulkItems(fixture.files);
  const controller = new AbortController();
  let calls = 0;
  const transport: Transport = async (request, key, signal, endpoint) => {
    if (++calls === 2) controller.abort();
    return success(request, key, signal, endpoint);
  };
  await analyzeBulkItems(fixture.app, items, config(), tags(), transport, controller.signal, true, () => {});
  assert.deepEqual(items.map(item => item.status), ['applied', 'cancelled', 'cancelled']);
  assert.equal(calls, 2);
  assert.deepEqual(fixture.writes, ['one.md']);
});

test('cancellation inside a delayed atomic process prevents its write', async () => {
  const fixture = vaultFixture({ 'one.md': 'One', 'two.md': 'Two' });
  const items = createBulkItems(fixture.files);
  const controller = new AbortController();
  const process = fixture.boundary.vault.process;
  fixture.boundary.vault.process = (file, change) => {
    controller.abort();
    return process(file, change);
  };
  await analyzeBulkItems(fixture.app, items, config(), tags(), success, controller.signal, true, () => {});
  assert.deepEqual(items.map(item => item.status), ['cancelled', 'cancelled']);
  assert.deepEqual(fixture.writes, []);
});

test('later candidate-batch failure never writes partial suggestions and does not block independent notes', async () => {
  const manyTags = Array.from({ length: 100 }, (_, index) => ({ tag: `tag-${index}`, count: 100 - index }));
  const settings = config({ definitions: manyTags.map(({ tag }) => `${tag} = ${'meaning '.repeat(120)}`).join('\n') });
  const fixture = vaultFixture({ 'one.md': 'One', 'two.md': 'Two' }, manyTags);
  const items = createBulkItems(fixture.files);
  let calls = 0;
  const transport: Transport = async (request, key, signal, endpoint) => {
    if (++calls === 2) return { status: 422, json: {} };
    return success(request, key, signal, endpoint);
  };
  await analyzeBulkItems(fixture.app, items, settings, manyTags, transport, new AbortController().signal, true, () => {});
  assert.deepEqual(items.map(item => item.status), ['failed', 'applied']);
  assert.match(items[0]!.message!, /no partial suggestions were returned/);
  assert.equal(items[0]!.result, undefined);
  assert.equal(items[0]!.selected.size, 0);
  assert.deepEqual(fixture.writes, ['two.md']);
});

test('provider-wide failures stop future requests and preserve earlier completed notes', async () => {
  for (const status of [401, 402, 403, 404, 429, 503]) {
    const fixture = vaultFixture({ 'one.md': 'One', 'two.md': 'Two', 'three.md': 'Three' });
    const items = createBulkItems(fixture.files);
    let calls = 0;
    const transport: Transport = async (request, key, signal, endpoint) => {
      if (++calls === 1) return success(request, key, signal, endpoint);
      return { status, json: {}, retryAfter: '60' };
    };
    await analyzeBulkItems(fixture.app, items, config(), tags(), transport, new AbortController().signal, true, () => {});
    assert.deepEqual(items.map(item => item.status), ['applied', 'failed', 'skipped']);
    assert.equal(calls, 2);
    assert.match(items[2]!.message!, /run stopped/);
    assert.deepEqual(fixture.writes, ['one.md']);
  }
});

test('lost provider connection stops further note requests', async () => {
  const fixture = vaultFixture({ 'one.md': 'One', 'two.md': 'Two' });
  const items = createBulkItems(fixture.files);
  let calls = 0;
  await analyzeBulkItems(fixture.app, items, config(), tags(), () => {
    calls++; return Promise.reject(new Error('Network unavailable'));
  }, new AbortController().signal, true, () => {});
  assert.deepEqual(items.map(item => item.status), ['failed', 'skipped']);
  assert.equal(calls, 1);
  assert.deepEqual(fixture.writes, []);
});

test('missing credentials stop the bulk run before reading notes or calling the provider', async () => {
  const fixture = vaultFixture({ 'one.md': 'One', 'two.md': 'Two' });
  const items = createBulkItems(fixture.files);
  let reads = 0;
  let calls = 0;
  fixture.boundary.vault.read = () => { reads++; return Promise.resolve('One'); };
  await analyzeBulkItems(fixture.app, items, config({ apiKey: '' }), tags(), () => {
    calls++; return Promise.reject(new Error('Must not be called'));
  }, new AbortController().signal, true, () => {});
  assert.deepEqual(items.map(item => item.status), ['failed', 'skipped']);
  assert.match(items[0]!.message!, /Add your TypeSafe API key/);
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test('no recommendations or selections leave a note unchanged and applied notes cannot be applied twice', async () => {
  const fixture = vaultFixture({ 'one.md': 'One', 'two.md': 'Two' });
  const items = createBulkItems(fixture.files);
  const signal = new AbortController().signal;
  await analyzeBulkItems(fixture.app, items, config(), tags(), success, signal, false, () => {});
  items[0]!.selected.clear();
  await applyBulkItem(fixture.app, items[0]!, config(), signal);
  assert.equal(items[0]!.status, 'unchanged');
  await applyBulkItem(fixture.app, items[1]!, config(), signal);
  await applyBulkItem(fixture.app, items[1]!, config(), signal);
  assert.deepEqual(fixture.writes, ['two.md']);
  const other = createBulkItems(fixture.files);
  await analyzeBulkItems(fixture.app, other, config({ minProbability: 1 }), tags(), success, signal, true, () => {});
  assert.deepEqual(other.map(item => item.status), ['unchanged', 'unchanged']);
  assert.deepEqual(fixture.writes, ['two.md']);
});

test('undo restores the exact original note once and preserves intervening edits', async () => {
  const original = '\uFEFF---\r\ntitle: "Original" # Keep this\r\n---\r\nBody';
  const fixture = vaultFixture({ 'one.md': original, 'two.md': 'Two' });
  const items = createBulkItems(fixture.files);
  const signal = new AbortController().signal;
  await analyzeBulkItems(fixture.app, items, config(), tags(), success, signal, true, () => {});
  assert.equal(items[0]!.appliedSnapshot, fixture.data.get('one.md'));
  await undoBulkItem(fixture.app, items[0]!);
  await undoBulkItem(fixture.app, items[0]!);
  assert.equal(items[0]!.status, 'undone');
  assert.equal(fixture.data.get('one.md'), original);
  const edited = fixture.data.get('two.md')! + '\nUser edit';
  fixture.data.set('two.md', edited);
  await undoBulkItem(fixture.app, items[1]!);
  assert.equal(items[1]!.status, 'skipped');
  assert.match(items[1]!.message!, /Undo was skipped/);
  assert.equal(fixture.data.get('two.md'), edited);
  assert.deepEqual(fixture.writes, ['one.md', 'two.md', 'one.md']);
});

test('stopping undo inside an atomic write keeps the recovery snapshot and allows continuation', async () => {
  const fixture = vaultFixture({ 'one.md': 'One' });
  const items = createBulkItems(fixture.files);
  await analyzeBulkItems(fixture.app, items, config(), tags(), success, new AbortController().signal, true, () => {});
  const controller = new AbortController();
  const process = fixture.boundary.vault.process;
  fixture.boundary.vault.process = (file, change) => { controller.abort(); return process(file, change); };
  await undoBulkItem(fixture.app, items[0]!, controller.signal);
  assert.equal(items[0]!.status, 'applied');
  assert.equal(fixture.writes.length, 1);
  fixture.boundary.vault.process = process;
  await undoBulkItem(fixture.app, items[0]!, new AbortController().signal);
  assert.equal(items[0]!.status, 'undone');
  assert.equal(fixture.data.get('one.md'), 'One');
});

test('copyable bulk report includes outcomes and settings without secrets, content, or recovery snapshots', async () => {
  const fixture = vaultFixture({ 'one.md': 'Private note body' });
  const items = createBulkItems(fixture.files);
  const settings = config({ apiKey: 'private-credential', guidance: 'Private guidance', definitions: 'design = Private definition' });
  await analyzeBulkItems(fixture.app, items, settings, tags(), success, new AbortController().signal, true, () => {});
  const output = bulkReport(items, settings);
  assert.doesNotMatch(output, /private-credential|Private note body|Private guidance|Private definition|snapshot|apiKey/i);
  const report = JSON.parse(output) as { results: { path: string; status: string; addedTags: string[] }[]; settings: { minProbability: number } };
  assert.equal(report.results[0]!.path, 'one.md');
  assert.equal(report.results[0]!.status, 'applied');
  assert.deepEqual(report.results[0]!.addedTags, ['design', 'writing']);
  assert.equal(report.settings.minProbability, settings.minProbability);
});

test('recovery memory limit stops a broad run before another paid request and keeps earlier undo', async () => {
  const fixture = vaultFixture({ 'one.md': 'One', 'large.md': 'x'.repeat(MAX_BULK_RECOVERY_CHARACTERS / 2), 'three.md': 'Three' });
  const items = createBulkItems(fixture.files);
  let calls = 0;
  const transport: Transport = (request, key, signal, endpoint) => { calls++; return success(request, key, signal, endpoint); };
  await analyzeBulkItems(fixture.app, items, config(), tags(), transport, new AbortController().signal, true, () => {});
  assert.deepEqual(items.map(item => item.status), ['applied', 'failed', 'skipped']);
  assert.equal(calls, 1);
  assert.match(items[1]!.message!, /Undo storage limit reached/);
  assert.deepEqual(fixture.writes, ['one.md']);
  await undoBulkItem(fixture.app, items[0]!);
  assert.equal(fixture.data.get('one.md'), 'One');
});

test('temporary undo write failure retains recovery data and can be retried', async () => {
  const fixture = vaultFixture({ 'one.md': 'One' });
  const items = createBulkItems(fixture.files);
  await analyzeBulkItems(fixture.app, items, config(), tags(), success, new AbortController().signal, true, () => {});
  const process = fixture.boundary.vault.process;
  fixture.boundary.vault.process = () => { throw new Error('Read-only folder'); };
  await undoBulkItem(fixture.app, items[0]!);
  assert.equal(items[0]!.status, 'applied');
  assert.match(items[0]!.message!, /try Undo additions again/);
  fixture.boundary.vault.process = process;
  await undoBulkItem(fixture.app, items[0]!);
  assert.equal(items[0]!.status, 'undone');
  assert.equal(fixture.data.get('one.md'), 'One');
});

test('parallel workers overlap note requests within a bound and keep each context separate', async () => {
  const fixture = vaultFixture(Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`${index}.md`, `Note ${index}`])));
  const items = createBulkItems(fixture.files);
  let active = 0;
  let maximum = 0;
  const contexts = new Set<string>();
  const progress: number[] = [];
  const transport: Transport = async (request, key, signal, endpoint) => {
    contexts.add((request.state as { note: { body: string } }).note.body);
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return success(request, key, signal, endpoint);
  };
  await analyzeBulkItems(fixture.app, items, config(), tags(), transport, new AbortController().signal, true,
    (_item, complete) => progress.push(complete), () => {}, 3);
  assert.equal(maximum, 3);
  assert.equal(contexts.size, 7);
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(items.every(item => item.status === 'applied'));
});

test('provider-wide failure stops queued notes and prevents late parallel responses from writing', async () => {
  const fixture = vaultFixture(Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`${index}.md`, `Note ${index}`])));
  const items = createBulkItems(fixture.files);
  let calls = 0;
  const transport: Transport = async (request, key, signal, endpoint) => {
    const call = ++calls;
    if (call === 1) return { status: 401, json: {} };
    await new Promise(resolve => setTimeout(resolve, 5));
    return success(request, key, signal, endpoint);
  };
  await analyzeBulkItems(fixture.app, items, config(), tags(), transport, new AbortController().signal, true, () => {}, () => {}, 3);
  assert.equal(calls, 3);
  assert.equal(items.filter(item => item.status === 'failed').length, 1);
  assert.equal(items.filter(item => item.status === 'skipped').length, 7);
  assert.deepEqual(fixture.writes, []);
});

test('parallel recovery reservations stop the queue before exceeding its snapshot budget', async () => {
  const size = Math.floor(MAX_BULK_RECOVERY_CHARACTERS / 4);
  const fixture = vaultFixture({ 'one.md': 'x'.repeat(size), 'two.md': 'x'.repeat(size), 'three.md': 'Small', 'four.md': 'Small' });
  const items = createBulkItems(fixture.files);
  let calls = 0;
  const transport: Transport = async (request, key, signal, endpoint) => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return success(request, key, signal, endpoint);
  };
  await analyzeBulkItems(fixture.app, items, config(), tags(), transport, new AbortController().signal, true, () => {}, () => {}, 3);
  assert.equal(calls, 2);
  assert.equal(items[2]!.status, 'failed');
  assert.match(items[2]!.message!, /Undo storage limit reached/);
  assert.deepEqual(fixture.writes, []);
});
