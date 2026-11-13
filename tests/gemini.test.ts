// Checks Gemini's text-encoded noul requests, API key header, usage mapping, safety errors and credential isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, normalizeConfig, persistedConfig, type Config } from '../src/config.ts';
import { buildBatches, selectCandidates } from '../src/core.ts';
import { suggest, evaluate, type Transport } from '../src/client.ts';
import { GEMINI_ENDPOINT, resolveProvider } from '../src/provider.ts';
import { hydrateCredentials } from '../src/secret-storage.ts';
import { resolveCliCredential } from '../scripts/cli/credentials.ts';
import { withOverrides } from '../scripts/cli/cli-overrides.ts';
import { bulkTargets, runCliBulk } from '../scripts/cli/cli-bulk.ts';

const config = (patch: Partial<Config> = {}): Config => ({ ...DEFAULTS, provider: 'gemini', geminiApiKey: 'synthetic-gemini-key',
  apiKey: 'do-not-send-typesafe', openRouterApiKey: 'do-not-send-router', openAiApiKey: 'do-not-send-openai',
  poolMode: 'specific', onlyTags: 'design, testing', ...patch });
const note = { title: 'Design testing', description: 'Synthetic fixture', body: 'Testing a design system.', existingTags: [] };
const success: Transport = async (request, headers, _signal, endpoint) => {
  assert.equal(endpoint, GEMINI_ENDPOINT);
  assert.deepEqual(headers, { 'x-goog-api-key': 'synthetic-gemini-key' });
  assert.ok('input' in request && !Array.isArray(request.questions));
  assert.equal(request.model, 'gemini-decision-1');
  return { status: 200, json: { answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.9, confidence: 0.9 }])),
    usage: { total_input_tokens: 120, total_output_tokens: 0, total_tokens: 120 } } };
};

test('Gemini sends the note as text input and each tag as a text noul with described criteria', async () => {
  const settings = config({ guidance: 'Prefer substantive topics.', definitions: 'design = Visual systems' });
  const result = await suggest(note, [], settings, async (request, ...args) => {
    assert.ok('input' in request && !Array.isArray(request.questions));
    assert.equal(typeof request.input, 'string');
    assert.match(request.input, /Synthetic fixture/); assert.match(request.input, /Prefer substantive topics/);
    const questions = Object.values(request.questions);
    assert.ok(questions.every(question => question.type === 'noul' && typeof question.instructions === 'string'
      && question.criteria.true_description && question.criteria.false_description));
    assert.match(questions[0]!.instructions, /Tag: "design"\nDefinition: Visual systems/);
    assert.doesNotMatch(JSON.stringify(request), /synthetic-gemini-key|do-not-send/);
    return success(request, ...args);
  });
  assert.deepEqual(result.recommended.map(item => item.tag), ['design', 'testing']);
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 0, complete: true });
  assert.equal(resolveProvider(settings).attribution, 'Using gemini-decision-1 · Gemini');
});

test('Gemini names itself when answers are malformed and reports safety blocks plainly', async () => {
  const settings = config(); const provider = resolveProvider(settings);
  await assert.rejects(suggest(note, [], settings, async () => ({ status: 200, json: { answers: { tag_0: { type: 'noul', noul: 2 } } } })),
    /Gemini returned/);
  const request = buildBatches(note, selectCandidates([], [], settings), settings).batches[0]!.request;
  await assert.rejects(evaluate(request, provider, async () => ({ status: 400,
    json: { error: { code: 'safety', message: 'Request blocked due to safety violations (harmful content).' } } })),
    /Gemini declined this note under its safety filters/);
  await assert.rejects(evaluate(request, provider, async () => ({ status: 400, json: { error: { code: 400, status: 'INVALID_ARGUMENT',
    message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID', domain: 'googleapis.com' }] } } })),
    /Gemini rejected the API key/);
  await assert.rejects(evaluate(request, provider, async () => ({ status: 400, json: { error: { code: 'invalid', message: 'secret-detail' } } })),
    error => error instanceof Error && /Gemini rejected the request/.test(error.message) && !error.message.includes('secret-detail'));
});

test('Gemini credentials hydrate independently, never persist, and support CLI environment and overrides', async () => {
  const settings = normalizeConfig({ ...config(), geminiSecretId: 'dev-gemini', geminiModel: '  ' });
  assert.equal(settings.provider, 'gemini');
  assert.equal(settings.geminiModel, 'gemini-decision-1');
  assert.equal(hydrateCredentials(settings, { getSecret: id => id === 'dev-gemini' ? 'selected-key' : null }).geminiApiKey, 'selected-key');
  assert.equal('geminiApiKey' in persistedConfig(settings), false);
  const resolved = await resolveCliCredential(config({ geminiApiKey: '' }), '/tmp/data.json', { GEMINI_API_KEY: 'env-key' });
  assert.equal(resolved.geminiApiKey, 'env-key');
  await assert.rejects(resolveCliCredential(config({ geminiApiKey: '' }), '/tmp/data.json', { OPENAI_API_KEY: 'wrong' }), /GEMINI_API_KEY/);
  assert.equal(withOverrides(DEFAULTS, { provider: 'gemini', geminiModel: 'gemini-decision-1' }).provider, 'gemini');
  assert.throws(() => withOverrides(DEFAULTS, { geminiApiKey: 'forbidden' }), /Credentials/);
  await assert.rejects(suggest(note, [], config({ geminiApiKey: '' }), async () => { throw new Error('Unexpected'); }), /Gemini API key/);
});

test('Gemini bulk reports omit every provider credential and secret reference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tag-match-gemini-'));
  const path = join(dir, 'One.md'); await writeFile(path, '# Synthetic note\nDesign systems.');
  const targets = await bulkTargets({ notes: [path] }, 'alphabetical', false);
  const report = await runCliBulk(targets, [], config({ geminiSecretId: 'private-reference' }), success,
    { concurrency: 1, signal: new AbortController().signal, mode: 'suggest' });
  assert.equal(report.provider, 'Gemini');
  assert.doesNotMatch(JSON.stringify(report), /synthetic-gemini-key|do-not-send|private-reference/);
});
