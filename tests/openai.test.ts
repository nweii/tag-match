// Checks native predicate requests, strict answer matching, credential isolation, and shared bulk writes and undo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, normalizeConfig, persistedConfig, type Config } from '../src/config.ts';
import { buildBatches, selectCandidates } from '../src/core.ts';
import { parseOpenAiJudgments } from '../src/decision-protocol.ts';
import { suggest, evaluate, type Transport } from '../src/client.ts';
import { OPEN_AI_ENDPOINT, resolveProvider } from '../src/provider.ts';
import { hydrateCredentials } from '../src/secret-storage.ts';
import { resolveCliCredential } from '../scripts/cli/credentials.ts';
import { withOverrides } from '../scripts/cli/cli-overrides.ts';
import { bulkTargets, runCliBulk, undoCliBulk } from '../scripts/cli/cli-bulk.ts';

const config = (patch: Partial<Config> = {}): Config => ({ ...DEFAULTS, provider: 'openai', openAiApiKey: 'synthetic-openai-key',
  apiKey: 'do-not-send-typesafe', openRouterApiKey: 'do-not-send-router', poolMode: 'specific', onlyTags: 'design, testing', ...patch });
const note = { title: 'Design testing', description: 'Synthetic fixture', body: 'Testing a design system.', existingTags: [] };
const success: Transport = async (request, key, _signal, endpoint) => {
  assert.equal(endpoint, OPEN_AI_ENDPOINT); assert.equal(key, 'synthetic-openai-key');
  assert.ok('input' in request); assert.equal('state' in request, false);
  assert.equal(request.model, 'gpt-6-luna');
  return { status: 200, json: { model: request.model, answers: request.questions.map(question => ({
    type: 'predicate', name: question.name, probability: 0.9,
  })).reverse(), usage: { input_tokens: 42, output_tokens: 0 } } };
};

test('OpenAI sends native predicates with note context, definitions and guidance and retains shared ranking', async () => {
  const settings = config({ guidance: 'Prefer substantive topics.', definitions: 'design = Visual systems' });
  const result = await suggest(note, [], settings, async (request, ...args) => {
    assert.ok('input' in request);
    assert.match(request.input, /Synthetic fixture/); assert.match(request.input, /Prefer substantive topics/);
    assert.ok(request.questions.every(question => question.type === 'predicate'));
    assert.match(request.questions[0]!.instructions, /Visual systems/);
    assert.doesNotMatch(JSON.stringify(request), /synthetic-openai-key|do-not-send/);
    return success(request, ...args);
  });
  assert.deepEqual(result.recommended.map(item => item.tag), ['design', 'testing']);
  assert.deepEqual(result.usage, { inputTokens: 42, outputTokens: 0, complete: true });
});

test('OpenAI batches bound serialized payloads and fail the whole note on a later refusal', async () => {
  const settings = config({ poolMode: 'all' });
  const tags = Array.from({ length: 250 }, (_, i) => ({ tag: `topic-${i}`, count: 1 }));
  const prepared = buildBatches(note, selectCandidates(tags, [], settings), settings);
  assert.ok(prepared.batches.length > 1);
  assert.equal(prepared.batches.flatMap(batch => batch.tags).length, tags.length);
  for (const batch of prepared.batches) assert.ok(Buffer.byteLength(JSON.stringify(batch.request)) <= 55000);
  let calls = 0;
  await assert.rejects(suggest(note, tags, settings, async (request, ...args) => {
    const response = await success(request, ...args);
    if (++calls === 2) {
      assert.ok('input' in request);
      return { status: 200, json: { answers: request.questions.map(question => ({ name: question.name, type: 'refusal' })) } };
    }
    return response;
  }), /declined.*no partial suggestions/s);
  assert.equal(calls, 2);
});

test('OpenAI rejects missing, duplicate, foreign, refused and invalid answers without misassigning scores', () => {
  const valid = { type: 'predicate', name: 'tag_0', probability: 0.8 };
  for (const response of [{}, { answers: [] }, { answers: [valid, valid] },
    { answers: [{ ...valid, name: 'foreign' }] }, { answers: [{ ...valid, type: 'refusal' }] },
    ...[NaN, Infinity, -1, 1.1, '0.8'].map(probability => ({ answers: [{ ...valid, probability }] })),
    { answers: [{ ...valid, type: 'choice' }] }]) assert.throws(() => parseOpenAiJudgments(response, ['design']), /OpenAI/);
  assert.throws(() => parseOpenAiJudgments({ answers: [valid, valid] }, ['design', 'testing']), /answer names/);
  assert.deepEqual(parseOpenAiJudgments({ answers: [{ ...valid, name: 'tag_1', probability: 0 }, valid] }, ['design', 'testing']),
    [{ tag: 'design', probability: 0.8 }, { tag: 'testing', probability: 0 }]);
});

test('OpenAI credentials hydrate independently, never persist, and support CLI environment and overrides', async () => {
  const settings = normalizeConfig({ ...config(), openAiSecretId: 'dev-openai', openAiModel: '  gpt-6-luna  ' });
  assert.equal(settings.openAiModel, 'gpt-6-luna');
  assert.equal(hydrateCredentials(settings, { getSecret: id => id === 'dev-openai' ? 'selected-key' : null }).openAiApiKey, 'selected-key');
  assert.equal(hydrateCredentials(settings, { getSecret: () => null }).openAiApiKey, '');
  assert.equal('openAiApiKey' in persistedConfig(settings), false);
  assert.equal('openAiApiKey' in persistedConfig(config()), false);
  const resolved = await resolveCliCredential(config({ openAiApiKey: '' }), '/tmp/data.json', { OPENAI_API_KEY: 'env-key' });
  assert.equal(resolved.openAiApiKey, 'env-key');
  await assert.rejects(resolveCliCredential(config({ openAiApiKey: '' }), '/tmp/data.json', { TYPESAFE_API_KEY: 'wrong' }), /OPENAI_API_KEY/);
  const overridden = withOverrides(DEFAULTS, { provider: 'openai', openAiModel: 'gpt-6-luna' });
  assert.equal(overridden.provider, 'openai');
  assert.throws(() => withOverrides(DEFAULTS, { openAiApiKey: 'forbidden' }), /Credentials/);
  let calls = 0;
  await assert.rejects(suggest(note, [], config({ openAiApiKey: '' }), async () => { calls++; throw new Error('Unexpected'); }), /OpenAI API key/);
  assert.equal(calls, 0);
});

test('OpenAI retries rate limits, preserves aborts, and reports provider errors without response secrets', async () => {
  const settings = config(); const provider = resolveProvider(settings);
  const request = buildBatches(note, selectCandidates([], [], settings), settings).batches[0]!.request;
  let calls = 0; const waits: number[] = [];
  await evaluate(request, provider, async (...args) => ++calls === 1
    ? { status: 429, json: {}, retryAfter: '1' } : success(...args), undefined, async ms => { waits.push(ms); });
  assert.equal(calls, 2); assert.deepEqual(waits, [1000]);
  for (const status of [400, 401, 403, 404]) await assert.rejects(evaluate(request, provider, async () => ({ status, json: { secret: 'hidden-value' } })),
    error => error instanceof Error && error.message.includes('OpenAI') && !error.message.includes('hidden-value'));
  const controller = new AbortController();
  await assert.rejects(suggest(note, [], settings, async (...args) => { controller.abort(); return success(...args); }, controller.signal), /abort/i);
});

test('OpenAI bulk dry run, apply and undo share behavior without leaking credentials in reports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tag-match-openai-'));
  const paths = [join(dir, 'One.md'), join(dir, 'Two.md')]; const original = '# Synthetic note\nDesign systems.';
  await Promise.all(paths.map(path => writeFile(path, original)));
  const targets = await bulkTargets({ notes: paths }, 'alphabetical', false);
  const settings = config({ openAiSecretId: 'private-reference' });
  const base = { concurrency: 2, signal: new AbortController().signal };
  const preview = await runCliBulk(targets, [], settings, async () => { throw new Error('Unexpected network'); }, { ...base, mode: 'dry-run' });
  assert.equal(preview.summary.previewed, 2);
  const recoveryPath = join(dir, 'undo.jsonl');
  const applied = await runCliBulk(targets, [], settings, success, { ...base, mode: 'apply', recoveryPath });
  assert.equal(applied.summary.applied, 2);
  assert.doesNotMatch(JSON.stringify(applied), /synthetic-openai-key|do-not-send|private-reference/);
  assert.match(await readFile(paths[0]!, 'utf8'), /design/);
  await undoCliBulk(recoveryPath, true, base.signal);
  for (const path of paths) assert.equal(await readFile(path, 'utf8'), original);
});
