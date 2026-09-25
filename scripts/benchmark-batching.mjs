// Measures serial Jev batching at configurable byte caps with a fixed synthetic fixture.
// Makes paid API calls with synthetic content only; run with --config PATH. Never writes notes or settings.
import { readFile } from 'node:fs/promises';
import { normalizeConfig } from '../src/config.ts';
import { buildBatches, selectCandidates, parseJudgments } from '../src/core.ts';
import { evaluate } from '../src/client.ts';
import { fetchTransport } from '../src/cli.ts';
import { resolveProvider } from '../src/provider.ts';
import { resolveCliCredential } from '../src/credentials.ts';

const arg = process.argv.indexOf('--config');
if (arg < 0 || !process.argv[arg + 1]) throw new Error('Provide --config PATH (makes paid requests).');
const bodyArg = process.argv.indexOf('--body-chars');
const bodyChars = bodyArg < 0 ? undefined : Number(process.argv[bodyArg + 1]);
if (bodyArg >= 0 && (!Number.isInteger(bodyChars) || bodyChars < 1 || bodyChars > 24_000)) {
  throw new Error('Provide --body-chars as a whole number from 1 to 24000.');
}
const capsArg = process.argv.indexOf('--byte-caps');
const byteCaps = (capsArg < 0 ? '55000' : process.argv[capsArg + 1]).split(',').map(Number);
if (!byteCaps.length || byteCaps.some(cap => !Number.isInteger(cap) || cap < 1000 || cap > 500_000)) {
  throw new Error('Provide --byte-caps as comma-separated whole numbers from 1000 to 500000.');
}
const roundsArg = process.argv.indexOf('--rounds');
const rounds = roundsArg < 0 ? 2 : Number(process.argv[roundsArg + 1]);
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) {
  throw new Error('Provide --rounds as a whole number from 1 to 5.');
}
const configPath = process.argv[arg + 1];
const config = await resolveCliCredential(normalizeConfig({ ...JSON.parse(await readFile(configPath, 'utf8')),
  poolMode: 'all', excludedTags: '', guidance: '', definitions: '' }), configPath);
const provider = resolveProvider(config);
const fixtureBody = 'Design signup forms with visible labels, keyboard navigation, clear validation errors, and screen reader support. Test prototypes with people who use assistive technology. ';
const body = bodyChars === undefined ? fixtureBody.trim() : fixtureBody.repeat(Math.ceil(bodyChars / fixtureBody.length)).slice(0, bodyChars);
const note = { title: 'Accessible forms', existingTags: [], body };
const topics = ['accessibility', 'forms', 'design', 'keyboard', 'screen-readers', 'validation', 'cooking', 'gardening'];
const tags = Array.from({ length: 800 }, (_, i) => ({ tag: `${topics[i % topics.length]}/topic-${i}`, count: 1 }));
const prepared = buildBatches(note, selectCandidates(tags, [], config), config);
const entries = prepared.batches.flatMap(batch => batch.tags.map((tag, i) => ({ tag, question: batch.request.questions[`tag_${i}`] })));
const state = prepared.batches[0].request.state;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
function pack(byteCap) {
  const batches = [];
  let batch = { request: { model: provider.model, state, questions: {} }, tags: [] };
  for (const entry of entries) {
    const id = `tag_${batch.tags.length}`;
    if (batch.tags.length && bytes({ state, questions: { ...batch.request.questions, [id]: entry.question } }) > byteCap) {
      batches.push(batch);
      batch = { request: { model: provider.model, state, questions: {} }, tags: [] };
    }
    batch.request.questions[`tag_${batch.tags.length}`] = entry.question;
    batch.tags.push(entry.tag);
  }
  if (batch.tags.length) batches.push(batch);
  return batches;
}
const results = [];
const scores = new Map();
for (let round = 0; round < rounds; round++) {
  for (const byteCap of round % 2 ? [...byteCaps].reverse() : byteCaps) {
    const batches = pack(byteCap);
    let count = 0, inputTokens = 0, outputTokens = 0, failedRequests = 0, error;
    const judgments = [];
    const models = new Set();
    const started = performance.now();
    for (const batch of batches) {
      try {
        const response = await evaluate(batch.request, provider, fetchTransport);
        const parsed = parseJudgments(response, batch.tags);
        judgments.push(...parsed);
        count += parsed.length;
        models.add(response.model);
        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;
      } catch (cause) {
        failedRequests++;
        error = cause instanceof Error ? cause.message : String(cause);
        break;
      }
    }
    scores.set(`${round + 1}:${byteCap}`, new Map(judgments.map(item => [item.tag, item.probability])));
    const result = { round: round + 1, byteCap, elapsedMs: Math.round(performance.now() - started), answers: count,
      requestsPlanned: batches.length, failedRequests, maxRequestBytes: Math.max(...batches.map(b => bytes(b.request))),
      maxBatchTags: Math.max(...batches.map(b => b.tags.length)), models: [...models], inputTokens, outputTokens,
      ...(error ? { error } : {}) };
    results.push(result);
    console.error(JSON.stringify(result));
  }
}
const consistency = rounds < 2 ? [] : byteCaps.map(byteCap => {
  const first = scores.get(`1:${byteCap}`); const second = scores.get(`2:${byteCap}`);
  const diffs = [...first.keys()].filter(tag => second.has(tag)).map(tag => Math.abs(first.get(tag) - second.get(tag)));
  return { byteCap, compared: diffs.length,
    meanAbsoluteDifference: diffs.length ? diffs.reduce((sum, value) => sum + value, 0) / diffs.length : null,
    maxAbsoluteDifference: diffs.length ? Math.max(...diffs) : null };
});
process.stdout.write(JSON.stringify({ date: new Date().toISOString(), provider: config.provider,
  fixture: 'synthetic 800 tags; not an accuracy comparison', bodyChars: body.length, byteCaps, rounds, results, consistency }, null, 2) + '\n');
