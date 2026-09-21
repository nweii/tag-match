// Exercises candidate selection, independent Noul batching, response validation, retries, and cancellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig, type Config } from '../src/config.ts';
import { buildBatches, parseJudgments, recommendations, selectCandidates } from '../src/core.ts';
import { BatchEvaluationError, evaluate, suggest, type Transport } from '../src/client.ts';
import { OPEN_ROUTER_ENDPOINT, resolveProvider, TYPE_SAFE_ENDPOINT } from '../src/provider.ts';

const config = (values: Partial<Config> = {}): Config => ({ ...DEFAULTS, apiKey: 'test-key', ...values });
const note = { title: 'A note', body: 'Design systems and typography.', existingTags: ['existing'] };

test('automatic mode checks all small pools, then at least 100 or the top 20 percent', () => {
  const size = (eligible: number) => selectCandidates(
    Array.from({ length: eligible }, (_, index) => ({ tag: `tag-${index}`, count: eligible - index })),
    [], config({ poolMode: 'auto' }),
  ).tags.length;
  assert.deepEqual([size(0), size(1), size(100), size(101), size(500), size(501), size(2452)],
    [0, 1, 100, 100, 100, 101, 491]);
});

test('automatic mode calculates its floor after exclusions and existing tags', () => {
  const inventory = Array.from({ length: 103 }, (_, index) => ({ tag: `tag-${index}`, count: 103 - index }));
  const pool = selectCandidates(inventory, ['tag-1'], config({ poolMode: 'auto', excludedTags: 'tag-0\ntag-2' }));
  assert.equal(pool.eligible, 100);
  assert.equal(pool.tags.length, 100);
  assert.equal(pool.excluded, 2);
  assert.equal(pool.existing, 1);
});

test('percentage uses eligible distinct tags and scales beyond 25', () => {
  const inventory = Array.from({ length: 2452 }, (_, index) => ({ tag: `tag-${index}`, count: 2452 - index }));
  inventory[0] = { tag: 'private', count: 3000 };
  inventory[1] = { tag: 'existing', count: 2999 };
  const pool = selectCandidates(inventory, note.existingTags, config({ poolPercent: 20, excludedTags: 'private' }));
  assert.equal(pool.eligible, 2450);
  assert.equal(pool.tags.length, 490);
  assert.equal(pool.excluded, 1);
  assert.equal(pool.existing, 1);
});

test('count and all modes sort, merge, and apply exact and branch exclusions', () => {
  const inventory = [
    { tag: '#work', count: 10 }, { tag: 'work/project', count: 9 }, { tag: 'working', count: 8 },
    { tag: 'Topic', count: 2 }, { tag: '#topic', count: 3 }, { tag: 'rare', count: 1 },
  ];
  const counted = selectCandidates(inventory, [], config({ poolMode: 'count', poolCount: 1, excludedTags: 'work/*' }));
  assert.deepEqual(counted.tags, [{ tag: 'working', count: 8 }]);
  const all = selectCandidates(inventory, [], config({ poolMode: 'all', excludedTags: 'work/*' }));
  assert.deepEqual(all.tags, [{ tag: 'working', count: 8 }, { tag: 'Topic', count: 5 }, { tag: 'rare', count: 1 }]);
});

test('minimum-use mode includes the cutoff and removes exclusions and existing tags', () => {
  const inventory = [
    { tag: 'above', count: 3 }, { tag: 'at-cutoff', count: 2 }, { tag: 'below', count: 1 },
    { tag: 'excluded', count: 5 }, { tag: 'existing', count: 4 },
  ];
  const pool = selectCandidates(inventory, ['existing'], config({
    poolMode: 'minimum', minimumUses: 2, excludedTags: 'excluded',
  }));
  assert.deepEqual(pool.tags, [{ tag: 'above', count: 3 }, { tag: 'at-cutoff', count: 2 }]);
  assert.equal(pool.excluded, 1);
  assert.equal(pool.existing, 1);
  assert.equal(pool.eligible, 3);
});

test('batches pack independent Noul questions up to the byte budget', () => {
  const inventory = Array.from({ length: 120 }, (_, index) => ({ tag: `tag-${index}`, count: 120 - index }));
  const pool = selectCandidates(inventory, [], config({ poolMode: 'all' }));
  const ordinary = buildBatches(note, pool, config({ poolMode: 'all' }));
  assert.ok(ordinary.batches[0]!.tags.length > 40);
  assert.equal(ordinary.batches.flatMap(batch => batch.tags).length, 120);
  const definitions = inventory.map(({ tag }) => `${tag} = ${'meaning '.repeat(120)}`).join('\n');
  const prepared = buildBatches(note, pool, config({ poolMode: 'all', definitions }));
  assert.ok(prepared.batches.length > 1);
  assert.equal(prepared.batches.flatMap(batch => batch.tags).length, 120);
  for (const batch of prepared.batches) {
    assert.ok(Buffer.byteLength(JSON.stringify({ state: batch.request.state, questions: batch.request.questions })) <= 55_000);
  }
  const first = prepared.batches[0]!;
  const question = first.request.questions.tag_0 as { type: string; instructions: { definition: string } };
  assert.equal(question.type, 'noul');
  assert.equal(question.instructions.definition, 'meaning '.repeat(120).trim());
  assert.equal(Object.keys(first.request.questions).length, first.tags.length);
});

test('threshold and max-add cap are independent from candidate count', () => {
  const judgments = [
    { tag: 'a', probability: 0.9 }, { tag: 'b', probability: 0.8 }, { tag: 'c', probability: 0.7 },
  ];
  assert.deepEqual(recommendations(judgments, config({ minProbability: 0.75, maxTagsToAdd: 1 })), [judgments[0]]);
});

test('malformed API answers are rejected', () => {
  assert.throws(() => parseJudgments({ answers: {} }, ['a']), /unexpected number/);
  assert.throws(() => parseJudgments({ answers: { tag_0: { type: 'choice', noul: 0.8 } } }, ['a']), /invalid probability/);
  assert.throws(() => parseJudgments({ answers: { tag_0: { type: 'noul', noul: 2 } } }, ['a']), /invalid probability/);
});

test('transient failures retry and honor Retry-After', async () => {
  let calls = 0;
  const waits: number[] = [];
  const transport: Transport = async () => ++calls < 3
    ? { status: 429, json: {}, retryAfter: '0' }
    : { status: 200, json: { answers: {} } };
  const result = await evaluate({ model: 'jev-latest', state: {}, questions: {} }, resolveProvider(config({ apiKey: 'key' })), transport,
    new AbortController().signal, async ms => { waits.push(ms); });
  assert.deepEqual(result, { answers: {} });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [0, 0]);
});

test('cancellation prevents transport', async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(evaluate({ model: 'jev-latest', state: {}, questions: {} }, resolveProvider(config({ apiKey: 'key' })), async () => {
    called = true; return { status: 200, json: {} };
  }, controller.signal), { name: 'AbortError' });
  assert.equal(called, false);
});

test('existing configuration migrates to TypeSafe without changing its key or model', () => {
  const migrated = normalizeConfig({ apiKey: ' type-safe-key ', model: 'jev-custom' });
  assert.equal(migrated.provider, 'typesafe');
  assert.equal(migrated.apiKey, 'type-safe-key');
  assert.equal(migrated.model, 'jev-custom');
  assert.equal(migrated.openRouterApiKey, '');
  assert.equal(migrated.openRouterModel, 'typesafe/jev-1.13');
  assert.equal(resolveProvider(migrated).endpoint, TYPE_SAFE_ENDPOINT);
  assert.equal(resolveProvider(migrated).attribution, 'Using jev-custom · TypeSafe');
});

test('normalization defaults new configs to automatic and preserves every explicit saved mode', () => {
  assert.equal(normalizeConfig({}).poolMode, 'auto');
  for (const poolMode of ['auto', 'percent', 'count', 'minimum', 'all'] as const) {
    assert.equal(normalizeConfig({ poolMode }).poolMode, poolMode);
  }
});

test('OpenRouter routing uses only its key, endpoint, and pinned Decisions model', async () => {
  const seen: { keys: string[]; endpoints: string[]; models: string[] } = { keys: [], endpoints: [], models: [] };
  const openRouter = config({ provider: 'openrouter', apiKey: 'must-not-send',
    openRouterApiKey: 'open-router-key', openRouterModel: 'typesafe/jev-1.13', poolMode: 'all' });
  assert.equal(resolveProvider(openRouter).attribution, 'Using typesafe/jev-1.13 · OpenRouter');
  const inventory = Array.from({ length: 41 }, (_, index) => ({ tag: `design-${index}`, count: 41 - index }));
  const result = await suggest(note, inventory, openRouter,
    async (request, key, _signal, endpoint) => {
      seen.keys.push(key); seen.endpoints.push(endpoint); seen.models.push(request.model);
      // Changing the live object after the first batch must not switch provider details mid-analysis.
      openRouter.provider = 'typesafe'; openRouter.openRouterApiKey = 'changed-after-start';
      return { status: 200, json: { id: 'decision-1', provider: 'OpenRouter', model: request.model,
        answers: Object.fromEntries(Object.keys(request.questions).map(keyName => [keyName, { type: 'noul', noul: 0.88 }])),
        usage: { input_tokens: 12, output_tokens: 3, cost: 0.001 } } };
    });
  assert.deepEqual(seen.keys, ['open-router-key']);
  assert.deepEqual(seen.endpoints, [OPEN_ROUTER_ENDPOINT]);
  assert.deepEqual(seen.models, ['typesafe/jev-1.13']);
  assert.equal(result.recommended.length, openRouter.maxTagsToAdd);
});

test('OpenRouter never falls back to the TypeSafe key', async () => {
  let called = false;
  const openRouter = config({ provider: 'openrouter', apiKey: 'type-safe-key', openRouterApiKey: '',
    poolMode: 'count', poolCount: 1 });
  await assert.rejects(suggest(note, [{ tag: 'design', count: 1 }], openRouter, async () => {
    called = true; return { status: 200, json: {} };
  }), /Add your OpenRouter API key/);
  assert.equal(called, false);
});

test('later batch failure reports completed coverage and returns no partial result', async () => {
  let batch = 0;
  const transport: Transport = async request => {
    batch++;
    if (batch === 2) return { status: 401, json: {} };
    return { status: 200, json: { answers: Object.fromEntries(Object.keys(request.questions)
      .map(key => [key, { type: 'noul', noul: 0.9 }])) } };
  };
  const tags = Array.from({ length: 100 }, (_, index) => ({ tag: `tag-${index}`, count: 100 - index }));
  const definitions = tags.map(({ tag }) => `${tag} = ${'meaning '.repeat(120)}`).join('\n');
  const firstBatchSize = buildBatches(note, selectCandidates(tags, [], config({ poolMode: 'all' })),
    config({ poolMode: 'all', definitions })).batches[0]!.tags.length;
  await assert.rejects(suggest(note, tags, config({ poolMode: 'all', definitions }), transport), error => {
    assert.ok(error instanceof BatchEvaluationError);
    assert.equal(error.complete, firstBatchSize);
    assert.equal(error.total, 100);
    assert.match(error.message, /no partial suggestions were returned/);
    return true;
  });
});
