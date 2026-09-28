// Verifies that the review preview, search, and analysis use one candidate and settings snapshot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, type Config } from '../src/config.ts';
import { TYPE_SAFE_ENDPOINT } from '../src/provider.ts';
import { ReviewModal } from '../src/review.ts';
import type { Transport } from '../src/client.ts';

interface TestControl { textContent: string; placeholder?: string; click?(): Promise<void>; change?(value: string): void }

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
  assert.match(content.textContent, /1 of 1 eligible tags/);

  counts = { '#design': 3, '#writing': 2 };
  const search = content.all('input').find(input => input.placeholder === 'Search tags or results');
  assert.ok(search);
  search.change?.('writing');
  assert.match(content.textContent, /No matching tags/);
  search.change?.('');

  plugin.settings = { ...plugin.settings, poolMode: 'minimum', minimumUses: 100, provider: 'openrouter' };
  secret = 'updated-key';
  const analyze = content.all('button').find(button => button.textContent === 'Analyze note');
  assert.ok(analyze);
  await analyze.click?.();
  assert.deepEqual(sent, { key: 'updated-key', endpoint: TYPE_SAFE_ENDPOINT, tags: ['tag_0'] });
  assert.match(content.textContent, /Evaluated 1 tags/);
});
