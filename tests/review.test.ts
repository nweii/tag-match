// Verifies that the review preview, search, and analysis use one candidate and settings snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, type Config } from '../src/config.ts';
import { TYPE_SAFE_ENDPOINT } from '../src/provider.ts';
import { ReviewModal } from '../src/review.ts';
import type { Transport } from '../src/client.ts';

interface TestControl { textContent: string; placeholder?: string; hidden?: boolean; disabled?: boolean; checked?: boolean;
  click?(): Promise<void>; change?(value?: string): void; className?: string; all?(tag: string): TestControl[] }

test('review applies its explicit tag override and never offers to rescore that set', async () => {
  let written = 'Body';
  const app = { metadataCache: { getTags: () => ({ '#design': 10 }) },
    secretStorage: { getSecret: () => 'test-key' }, vault: {
      process: async (_file: unknown, transform: (content: string) => string) => { written = transform(written); return written; },
    } };
  const plugin = { settings: { ...DEFAULTS, poolMode: 'specific', poolCount: 1, onlyTags: 'global/tag',
    excludedTags: 'new/topic', typeSafeSecretId: 'saved-key' } as Config,
    transport: async () => ({ status: 200, json: { answers: { tag_0: { type: 'noul', noul: 0.9 } } } }),
    beginRun: () => true, endRun: () => {} };
  const saved = { ...plugin.settings };
  const modal = new ReviewModal(app as never, plugin as never, { path: 'note.md', basename: 'note' } as never,
    { title: 'Note', body: 'Body', existingTags: [] }, 'Body');
  modal.open();
  const content = modal.contentEl as unknown as { textContent: string; all(tag: string): TestControl[] };
  const fields = content.all('textarea');
  fields[0]!.change?.('new/topic');
  assert.equal(fields.length, 1);
  assert.match(content.textContent, /1 tag to score/);
  await content.all('button').find(button => button.textContent === 'Analyze note')!.click?.();
  assert.ok(!content.all('button').some(button => button.textContent.startsWith('Score ')));
  await content.all('button').find(button => button.textContent === 'Add 1 tag')!.click?.();
  assert.match(written, /new\/topic/);
  assert.deepEqual(plugin.settings, saved);
});

test('review keeps its previewed selection while refreshing the captured secret', async () => {
  let counts: Record<string, number> = { '#design': 3 };
  let secret = 'initial-key';
  let sent: { key: string; endpoint: string; tags: string[] } | undefined;
  const app = { metadataCache: { getTags: () => counts }, secretStorage: { getSecret: () => secret } };
  const transport: Transport = async (request, key, _signal, endpoint) => {
    sent = { key, endpoint, tags: Object.keys(request.questions) };
    return { status: 200, json: { answers: { tag_0: { type: 'noul', noul: 0.9 } } } };
  };
  const plugin = { settings: { ...DEFAULTS, poolMode: 'all', typeSafeSecretId: 'saved-key' } as Config,
    transport, beginRun: () => true, endRun: () => {} };
  const modal = new ReviewModal(app as never, plugin as never,
    { path: 'note.md', basename: 'note' } as never,
    { title: 'Note', body: 'Design work', existingTags: [] }, 'Design work');
  modal.open();
  const content = modal.contentEl as unknown as { textContent: string; all(tag: string): TestControl[] };
  assert.match(content.textContent, /1 tag to score of 1 available/);

  counts = { '#design': 3, '#writing': 2 };

  plugin.settings = { ...plugin.settings, poolMode: 'minimum', minimumUses: 100, provider: 'openrouter' };
  secret = 'updated-key';
  const analyze = content.all('button').find(button => button.textContent === 'Analyze note');
  assert.ok(analyze);
  await analyze.click?.();
  assert.deepEqual(sent, { key: 'updated-key', endpoint: TYPE_SAFE_ENDPOINT, tags: ['tag_0'] });
  assert.match(content.textContent, /Scored 1 tag\. 1 reached 75% and is preselected\./);
  assert.equal(content.all('details')[0]!.hidden, true);
  assert.equal(content.all('input').find(input => input.placeholder === 'Search all tags')?.hidden, undefined);
  assert.ok(content.all('button').some(button => button.textContent === 'Add 1 tag'));
});

test('review reveals ranked results after analysis and enables Add only for a selection', async () => {
  const app = { metadataCache: { getTags: () => ({ '#design': 3, '#excluded': 2 }) },
    secretStorage: { getSecret: () => 'test-key' } };
  const transport: Transport = async () => ({ status: 200,
    json: { answers: { tag_0: { type: 'noul', noul: 0.2 } } } });
  const plugin = { settings: { ...DEFAULTS, poolMode: 'all', excludedTags: 'excluded',
    typeSafeSecretId: 'saved-key' } as Config, transport, beginRun: () => true, endRun: () => {} };
  const modal = new ReviewModal(app as never, plugin as never,
    { path: 'note.md', basename: 'note' } as never,
    { title: 'Note', body: 'Design work', existingTags: [] }, 'Design work');
  modal.open();
  const content = modal.contentEl as unknown as { textContent: string; all(tag: string): TestControl[] };
  const analyze = content.all('button').find(button => button.textContent === 'Analyze note');
  const add = content.all('button').find(button => button.textContent === 'Add tags');
  assert.ok(analyze && add);
  assert.equal(add.disabled, true);
  await analyze.click?.();
  assert.match(content.textContent, /None reached 75%/);
  assert.equal(add.disabled, true);
  const results = content.all('div').find(element => element.className === 'tag-match-results-area');
  assert.ok(results);
  assert.equal(results.hidden, false);
  assert.match(results.textContent, /#design20%/);
  const checkbox = results.all?.('input').find(input => input.checked === false);
  assert.ok(checkbox);
  checkbox.checked = true;
  checkbox.change?.();
  assert.equal(add.disabled, false);
  assert.equal(add.textContent, 'Add 1 tag');
  const search = results.all?.('input').find(input => input.placeholder === 'Search all tags');
  search?.change?.('excluded');
  assert.match(results.textContent, /#excludedExcluded/);
  const excluded = results.all?.('label').find(label => label.textContent.includes('#excluded'));
  assert.equal(excluded?.all?.('input')[0]?.disabled, true);
});

test('review evaluates another sample without resending scored tags or losing manual selections', async () => {
  let writes = 0;
  const app = { metadataCache: { getTags: () => ({ '#alpha': 5, '#beta': 4, '#gamma': 3, '#delta': 2, '#epsilon': 1 }) },
    secretStorage: { getSecret: () => 'test-key' }, vault: { process: async () => { writes++; } } };
  const calls: string[][] = [];
  let releaseSecond: (() => void) | undefined;
  const transport: Transport = async request => {
    const batch = Object.values(request.questions).map(question => (question as { instructions: { tag: string } }).instructions.tag);
    calls.push(batch);
    if (calls.length === 2) await new Promise<void>(resolve => { releaseSecond = resolve; });
    return { status: 200, json: { answers: Object.fromEntries(Object.keys(request.questions)
      .map(key => [key, { type: 'noul', noul: 0.9 }])) } };
  };
  const plugin = { settings: { ...DEFAULTS, poolMode: 'count', poolCount: 2, mostUsedPercent: 50,
    maxTagsToAdd: 1, typeSafeSecretId: 'saved-key' } as Config,
    transport, beginRun: () => true, endRun: () => {} };
  const modal = new ReviewModal(app as never, plugin as never,
    { path: 'note.md', basename: 'note' } as never,
    { title: 'A very long note title about sampling', body: 'Design work', existingTags: [] }, 'Design work');
  modal.open();
  const content = modal.contentEl as unknown as { textContent: string; all(tag: string): TestControl[] };
  assert.equal((modal as unknown as { titleEl: TestControl }).titleEl.textContent, 'Review tags');
  assert.match(content.textContent, /A very long note title about sampling/);
  await content.all('button').find(button => button.textContent === 'Analyze note')?.click?.();
  const first = calls.flat();
  assert.equal(first.length, 2);
  const results = content.all('div').find(element => element.className === 'tag-match-results-area');
  assert.ok(results);
  const unchecked = results.all?.('input').find(input => input.checked === false);
  assert.ok(unchecked);
  unchecked.checked = true;
  unchecked.change?.();
  assert.equal(content.all('button').find(button => button.textContent.startsWith('Add '))?.textContent, 'Add 2 tags');
  assert.match(results.textContent, /90%/);
  // The first pool held one most-used and one sampled tag, so another sample draws one more at random.
  const another = content.all('button').find(button => button.textContent === 'Score 1 more tag');
  const add = content.all('button').find(button => button.textContent.startsWith('Add '));
  assert.ok(another);
  assert.ok(add);
  const rerun = another.click?.();
  assert.equal(add.disabled, true);
  await add.click?.();
  assert.equal(writes, 0);
  releaseSecond?.();
  await rerun;
  assert.equal(add.disabled, false);
  assert.equal(calls.flat().length, 3);
  assert.equal(new Set(calls.flat()).size, 3);
  assert.ok(!calls[1]!.includes('beta'), 'another sample skips the next most-used tag');
  assert.equal(content.all('button').find(button => button.textContent.startsWith('Add '))?.textContent, 'Add 2 tags');
  assert.match(content.textContent, /3 total/);
  assert.equal(results.all?.('input').filter(input => input.checked).length, 2);
});

test('review keeps a checked low score visible after higher ranked results exceed the display limit', async () => {
  const counts = Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`#tag${String(index).padStart(3, '0')}`, 200 - index]));
  const app = { metadataCache: { getTags: () => counts }, secretStorage: { getSecret: () => 'test-key' } };
  const transport: Transport = async request => ({ status: 200, json: { answers: Object.fromEntries(
    Object.entries(request.questions).map(([key, question]) => [key, { type: 'noul',
      noul: (question as { instructions: { tag: string } }).instructions.tag === 'tag000' ? 0.1 : 0.9 }])) } });
  const plugin = { settings: { ...DEFAULTS, poolMode: 'count', poolCount: 100, mostUsedPercent: 100,
    minProbability: 0.95, typeSafeSecretId: 'saved-key' } as Config,
    transport, beginRun: () => true, endRun: () => {} };
  const modal = new ReviewModal(app as never, plugin as never,
    { path: 'note.md', basename: 'note' } as never,
    { title: 'Note', body: 'Body', existingTags: [] }, 'Body');
  modal.open();
  const content = modal.contentEl as unknown as { all(tag: string): TestControl[] };
  await content.all('button').find(button => button.textContent === 'Analyze note')?.click?.();
  const results = content.all('div').find(element => element.className === 'tag-match-results-area');
  assert.ok(results);
  const low = results.all?.('label').find(label => label.textContent.includes('#tag000'));
  assert.ok(low);
  const checkbox = low.all?.('input')[0];
  assert.ok(checkbox);
  checkbox.checked = true;
  checkbox.change?.();
  await content.all('button').find(button => button.textContent === 'Score 100 more tags')?.click?.();
  const visible = results.all?.('label') ?? [];
  assert.equal(visible.length, 101);
  assert.match(visible.at(-1)!.textContent, /#tag000/);
  assert.equal(visible.at(-1)!.all?.('input')[0]?.checked, true);
  assert.equal(visible.filter(label => label.textContent.includes('#tag000')).length, 1);
  const search = results.all?.('input').find(input => input.placeholder === 'Search all tags');
  search?.change?.('tag199');
  assert.deepEqual(results.all?.('label').map(label => label.textContent.match(/#tag\d{3}/)?.[0]), ['#tag199']);
});

test('review lists reveal more rows on request instead of stopping at the first page', async () => {
  const counts = Object.fromEntries(Array.from({ length: 150 }, (_, index) => [`#tag${String(index).padStart(3, '0')}`, 150 - index]));
  const app = { metadataCache: { getTags: () => counts }, secretStorage: { getSecret: () => 'test-key' } };
  const transport: Transport = async request => ({ status: 200, json: { answers: Object.fromEntries(
    Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.5 }])) } });
  const plugin = { settings: { ...DEFAULTS, poolMode: 'all', typeSafeSecretId: 'saved-key' } as Config,
    transport, beginRun: () => true, endRun: () => {} };
  const modal = new ReviewModal(app as never, plugin as never,
    { path: 'note.md', basename: 'note' } as never,
    { title: 'Note', body: 'Body', existingTags: [] }, 'Body');
  modal.open();
  const content = modal.contentEl as unknown as { all(tag: string): TestControl[] };
  await content.all('button').find(button => button.textContent === 'Analyze note')?.click?.();
  const results = content.all('div').find(element => element.className === 'tag-match-results-area');
  assert.ok(results);
  assert.equal(results.all?.('label').length, 100);
  const more = results.all?.('button').find(button => button.textContent.startsWith('Show 50 more'));
  assert.ok(more);
  await more.click?.();
  assert.equal(results.all?.('label').length, 150);
  assert.equal(results.all?.('button').some(button => button.textContent.startsWith('Show ')), false);
});

test('review adjustments change this analysis without changing saved settings', async () => {
  const counts = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`#tag${String(index).padStart(2, '0')}`, 40 - index]));
  const app = { metadataCache: { getTags: () => counts }, secretStorage: { getSecret: () => 'test-key' } };
  const sent: string[] = [];
  const transport: Transport = async request => {
    sent.push(...Object.keys(request.questions));
    return { status: 200, json: { answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.5 }])) } };
  };
  const plugin = { settings: { ...DEFAULTS, poolMode: 'count', poolCount: 10, typeSafeSecretId: 'saved-key' } as Config,
    transport, beginRun: () => true, endRun: () => {} };
  const modal = new ReviewModal(app as never, plugin as never,
    { path: 'note.md', basename: 'note' } as never,
    { title: 'Note', body: 'Body', existingTags: [] }, 'Body');
  modal.open();
  const content = modal.contentEl as unknown as { textContent: string; all(tag: string): TestControl[] };
  assert.match(content.textContent, /10 tags to score of 40 available/);
  const mode = content.all('select')[0];
  assert.ok(mode);
  mode.change?.('percent');
  assert.match(content.textContent, /8 tags to score of 40 available/);
  mode.change?.('all');
  assert.match(content.textContent, /40 tags to score of 40 available/);
  assert.match(content.textContent, /Every available tag/);
  await content.all('button').find(button => button.textContent === 'Analyze note')?.click?.();
  assert.equal(sent.length, 40);
  assert.equal(plugin.settings.poolMode, 'count');
  assert.equal(plugin.settings.poolCount, 10);
});
