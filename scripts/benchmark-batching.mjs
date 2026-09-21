// Compares sequential 40-tag requests with byte-bounded packing and bounded concurrency.
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
function pack(limit) {
  const batches = [];
  let batch = { request: { model: provider.model, state, questions: {} }, tags: [] };
  for (const entry of entries) {
    const id = `tag_${batch.tags.length}`;
    if (batch.tags.length && (batch.tags.length >= limit || bytes({ state, questions: { ...batch.request.questions, [id]: entry.question } }) > 55000)) {
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
const modes = [{ name: '40 tags sequential', size: 40, concurrency: 1 }, { name: 'byte bounded sequential', size: Infinity, concurrency: 1 }, { name: 'byte bounded parallel', size: Infinity, concurrency: 3 }];
for (let round = 0; round < 2; round++) {
  for (const mode of round ? [...modes].reverse() : modes) {
    const batches = pack(mode.size);
    let next = 0, count = 0, inputTokens = 0, outputTokens = 0;
    const models = new Set();
    const started = performance.now();
    await Promise.all(Array.from({ length: Math.min(mode.concurrency, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const response = await evaluate(batch.request, provider, fetchTransport);
        count += parseJudgments(response, batch.tags).length;
        models.add(response.model);
        inputTokens += response.usage.input_tokens;
        outputTokens += response.usage.output_tokens;
      }
    }));
    const result = { round: round + 1, mode: mode.name, elapsedMs: Math.round(performance.now() - started), candidates: count,
      batches: batches.length, maxBatchTags: Math.max(...batches.map(b => b.tags.length)), models: [...models], inputTokens, outputTokens };
    results.push(result);
    console.error(JSON.stringify(result));
  }
}
process.stdout.write(JSON.stringify({ date: new Date().toISOString(), provider: config.provider,
  fixture: 'synthetic 800 tags; not an accuracy comparison', bodyChars: body.length, results }, null, 2) + '\n');
