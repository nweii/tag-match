// Exercises candidate selection, independent Noul batching, response validation, retries, and cancellation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig, type Config } from '../src/config.ts';
import { buildBatches, parseJudgments, recommendations, selectCandidates, parseOnlyTags } from '../src/core.ts';
import { BatchEvaluationError, evaluate, suggest, type Transport } from '../src/client.ts';
import { OPEN_ROUTER_ENDPOINT, resolveProvider, TYPE_SAFE_ENDPOINT } from '../src/provider.ts';

const config = (values: Partial<Config> = {}): Config => ({ ...DEFAULTS, apiKey: 'test-key', ...values });
const note = { title: 'A note', body: 'Design systems and typography.', existingTags: ['existing'] };

test('provider and malformed-response failures give recovery actions without exposing credentials', async () => {
  const request = buildBatches(note, selectCandidates([{ tag: 'design', count: 1 }], [], config()), config()).batches[0]!.request;
  for (const provider of ['typesafe', 'openrouter'] as const) {
    const settings = config({ provider, apiKey: 'private-key', openRouterApiKey: 'private-router-key' });
    for (const [status, remedy] of [[401, /API key in Tag Match settings/], [402, /Add credits/],
      [403, /Check model access/], [500, /Try again/]] as const) {
      await assert.rejects(evaluate(request, resolveProvider(settings), async () => ({ status, json: {} })), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, remedy);
        assert.doesNotMatch(error.message, /private-key|private-router-key/);
        return true;
      });
    }
  }
  for (const response of [{}, { answers: {} }, { answers: { tag_0: { type: 'noul', noul: 2 } } }]) {
    assert.throws(() => parseJudgments(response, ['design']), /Try analyzing this note again/);
  }
});

test('explicit tag sets override vault selection and exclusions while skipping existing tags', () => {
  for (const poolCount of [1, 999]) {
    const pool = selectCandidates([{ tag: 'design', count: 30 }, { tag: 'unlisted', count: 100 }], ['existing'],
      config({ poolMode: 'specific', poolCount, minimumUses: 999, poolPercent: 1,
        onlyTags: '#Design, design\nnew/topic, another, blocked/child, existing', excludedTags: 'blocked/*' }));
    assert.deepEqual(pool.tags.map(item => item.tag), ['Design', 'another', 'blocked/child', 'new/topic']);
    assert.equal(pool.tags.find(item => item.tag === 'new/topic')?.count, 0);
    assert.equal(pool.excluded, 0);
    assert.equal(pool.existing, 1);
    assert.equal(pool.discovery, 0);
  }
  assert.deepEqual(parseOnlyTags('#écriture, 2026-plan, 👩‍💻'), ['écriture', '2026-plan', '👩‍💻']);
  assert.equal(normalizeConfig({ onlyTags: 'new/topic' }).onlyTags, 'new/topic');
  assert.equal(normalizeConfig({}).onlyTags, '');
});

test('malformed explicit tags fail before transport instead of falling back to the vault', async () => {
  for (const onlyTags of ['two words', '123', '##tag', 'work/*', ', ,', 'tag:one']) {
    assert.throws(() => parseOnlyTags(onlyTags), /tag/i);
    let calls = 0;
    await assert.rejects(suggest(note, [{ tag: 'design', count: 1 }], config({ poolMode: 'specific', onlyTags }),
      async () => { calls++; throw new Error('Unexpected transport'); }, new AbortController().signal), /tag/i);
    assert.equal(calls, 0);
  }
  assert.deepEqual(parseOnlyTags(' \n '), []);
  assert.equal(selectCandidates([{ tag: 'design', count: 1 }], [], config({ poolMode: 'specific' })).tags.length, 0);
  assert.equal(selectCandidates([{ tag: 'design', count: 1 }], [], config({ onlyTags: 'two words' })).tags.length, 1);
});

test('specific tags all get scored while recommendation score and addition limits still apply', async () => {
  const sent: string[] = [];
  const transport: Transport = async request => {
    sent.push(...Object.values(request.questions).map(value => (value as { instructions: { tag: string } }).instructions.tag));
    return { status: 200, json: { answers: Object.fromEntries(Object.keys(request.questions)
      .map(key => [key, { type: 'noul', noul: 0.9 }])) } };
  };
  const settings = config({ poolMode: 'specific', onlyTags: 'new/topic, second', maxTagsToAdd: 1, minProbability: 0.95 });
  assert.deepEqual((await suggest(note, [], settings, transport)).recommended, []);
  assert.deepEqual(sent, ['new/topic', 'second']);
  assert.equal((await suggest(note, [], { ...settings, minProbability: 0.75 }, transport)).recommended.length, 1);
});

test('automatic mode checks all small pools, then at least 250 or the top 20 percent', () => {
  const size = (eligible: number) => selectCandidates(
    Array.from({ length: eligible }, (_, index) => ({ tag: `tag-${index}`, count: eligible - index })),
    [], config({ poolMode: 'auto' }),
  ).tags.length;
  assert.deepEqual([size(0), size(1), size(250), size(251), size(1250), size(1251), size(2452)],
    [0, 1, 250, 250, 250, 251, 491]);
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
  assert.equal(pool.frequent, 343);
  assert.equal(pool.discovery, 147);
  assert.ok(pool.tags.some(item => item.reason === 'discovery' && item.count < 2000));
  assert.equal(pool.excluded, 1);
  assert.equal(pool.existing, 1);
});

test('count and all modes sort, merge, and apply exact and branch exclusions', () => {
  const inventory = [
    { tag: '#work', count: 10 }, { tag: 'work/project', count: 9 }, { tag: 'working', count: 8 },
    { tag: 'Topic', count: 2 }, { tag: '#topic', count: 3 }, { tag: 'rare', count: 1 },
  ];
  const counted = selectCandidates(inventory, [], config({ poolMode: 'count', poolCount: 1, excludedTags: 'work/*' }));
  assert.deepEqual(counted.tags, [{ tag: 'working', count: 8, reason: 'discovery' }]);
  const all = selectCandidates(inventory, [], config({ poolMode: 'all', excludedTags: 'work/*' }));
  assert.deepEqual(all.tags, [
    { tag: 'working', count: 8, reason: 'all' }, { tag: 'Topic', count: 5, reason: 'all' },
    { tag: 'rare', count: 1, reason: 'all' },
  ]);
});

test('minimum-use mode includes the cutoff and removes exclusions and existing tags', () => {
  const inventory = [
    { tag: 'above', count: 3 }, { tag: 'at-cutoff', count: 2 }, { tag: 'below', count: 1 },
    { tag: 'excluded', count: 5 }, { tag: 'existing', count: 4 },
  ];
  const pool = selectCandidates(inventory, ['existing'], config({
    poolMode: 'minimum', minimumUses: 2, excludedTags: 'excluded',
  }));
  assert.deepEqual(pool.tags, [
    { tag: 'above', count: 3, reason: 'minimum' }, { tag: 'at-cutoff', count: 2, reason: 'minimum' },
  ]);
  assert.equal(pool.excluded, 1);
  assert.equal(pool.existing, 1);
  assert.equal(pool.eligible, 3);
});

test('mixed shortlist is stable for one note and explores different less-used tags for another', () => {
  const inventory = Array.from({ length: 100 }, (_, index) => ({ tag: `tag-${index}`, count: 100 - index }));
  const first = selectCandidates(inventory, [], config({ poolMode: 'count', poolCount: 10 }), 'note-a');
  const repeated = selectCandidates(inventory, [], config({ poolMode: 'count', poolCount: 10 }), 'note-a');
  const other = selectCandidates(inventory, [], config({ poolMode: 'count', poolCount: 10 }), 'note-b');
  assert.deepEqual(first.tags, repeated.tags);
  assert.equal(first.frequent, 7);
  assert.equal(first.discovery, 3);
  assert.deepEqual(first.tags.slice(0, 7).map(item => item.tag), inventory.slice(0, 7).map(item => item.tag));
  assert.ok(first.tags.slice(7).some(item => item.count <= 31));
  assert.notDeepEqual(first.tags.slice(7).map(item => item.tag), other.tags.slice(7).map(item => item.tag));
  assert.equal(new Set(first.tags.map(item => item.tag)).size, first.tags.length);
});

test('most-used share supports fully sampled, mixed, and fully usage-ranked selections', () => {
  const inventory = Array.from({ length: 100 }, (_, index) => ({ tag: `tag-${index}`, count: 100 - index }));
  const selected = (mostUsedPercent: number) => selectCandidates(inventory, [],
    config({ poolMode: 'count', poolCount: 10, mostUsedPercent }), 'note');
  assert.deepEqual([0, 70, 100].map(share => {
    const pool = selected(share);
    return [pool.frequent, pool.discovery];
  }), [[0, 10], [7, 3], [10, 0]]);
});

test('candidate inspection explains exclusions, existing tags, and tags outside the shortlist', () => {
  const pool = selectCandidates([
    { tag: 'excluded', count: 5 }, { tag: 'existing', count: 4 }, { tag: 'included', count: 3 },
    { tag: 'outside', count: 2 },
  ], ['existing'], config({ poolMode: 'count', poolCount: 1, excludedTags: 'excluded' }), 'note');
  assert.deepEqual(Object.fromEntries(pool.inspected.map(item => [item.tag, item.status])), {
    excluded: 'excluded', existing: 'already-present', included: 'included', outside: 'outside-pool',
  });
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
  assert.equal(normalizeConfig({}).mostUsedPercent, 70);
  assert.equal(normalizeConfig({ mostUsedPercent: -20 }).mostUsedPercent, 0);
  assert.equal(normalizeConfig({ mostUsedPercent: 120 }).mostUsedPercent, 100);
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
