// Scores matching quality on labeled synthetic notes, comparing question wordings with and without the note's current tags.
// This makes paid API requests unless --dry-run is passed; it sends only scripts/eval-fixtures.json and never modifies notes.
// Run: node --experimental-strip-types scripts/eval-quality.mjs --config /path/to/data.json [--dry-run] [--out results.json]
// Only the TypeSafe and OpenRouter protocols are supported, because variants rewrite their structured question objects.
import { readFile, writeFile } from 'node:fs/promises';
import { normalizeConfig } from '../src/config.ts';
import { suggest } from '../src/client.ts';
import { fetchTransport } from './cli/cli.ts';
import { resolveCliCredential } from './cli/credentials.ts';

const flag = name => process.argv.includes(name);
const option = name => flag(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const configPath = option('--config');
const dryRun = flag('--dry-run');
if (!configPath && !dryRun) {
  throw new Error('Usage: node --experimental-strip-types scripts/eval-quality.mjs --config PATH [--dry-run] [--out PATH] (makes paid API requests)');
}

const fixtures = JSON.parse(await readFile(new URL('./eval-fixtures.json', import.meta.url), 'utf8'));
const saved = configPath ? JSON.parse(await readFile(configPath, 'utf8')) : { provider: 'typesafe', apiKey: 'dry-run' };
const base = normalizeConfig({ ...saved, poolMode: 'specific', onlyTags: fixtures.vocabulary.join(', '),
  excludedTags: '', guidance: fixtures.guidance, definitions: fixtures.definitions, maxTagsToAdd: 1000 });
const config = dryRun ? base : await resolveCliCredential(base, configPath);
const threshold = config.minProbability;

const WORDINGS = {
  current: undefined,
  evidence: {
    question: 'Is the topic or function named by `tag` a substantial subject of `note`, under `tagging_guidance` and the tag `definition`? Judge this tag on its own; several tags can apply.',
    criteria: {
      true: 'The note discusses this topic or serves this function in a substantial way, beyond a passing mention.',
      false: 'The topic appears only in passing, is suggested only by the title, or is ruled out by the guidance or definition.',
    },
  },
};
const VARIANTS = Object.keys(WORDINGS).flatMap(wording => [true, false].map(existing => ({
  name: `${wording}${existing ? '' : ' · no existing tags'}`, wording, existing })));

function rewrite(request, variant) {
  if (!request.state || typeof request.questions !== 'object' || Array.isArray(request.questions)) {
    throw new Error('The evaluation supports the TypeSafe and OpenRouter providers only.');
  }
  const state = structuredClone(request.state);
  if (!variant.existing) state.note.existing_tags = [];
  const wording = WORDINGS[variant.wording];
  const questions = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key, wording ? {
    ...question, instructions: { ...question.instructions, question: wording.question }, criteria: wording.criteria,
  } : question]));
  return { ...request, state, questions };
}

const offline = async request => ({ status: 200, json: { model: 'dry-run', answers: Object.fromEntries(
  Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.5 }])) } });

const results = [];
for (const variant of VARIANTS) {
  const transport = (request, ...rest) => (dryRun ? offline : fetchTransport)(rewrite(request, variant), ...rest);
  const scored = [];
  const models = new Set();
  for (const fixture of fixtures.notes) {
    const note = { title: fixture.title, body: fixture.body, existingTags: fixture.existingTags };
    const result = await suggest(note, [], config, transport);
    for (const model of result.models) models.add(model);
    const probability = new Map(result.judgments.map(item => [item.tag, item.probability]));
    for (const [label, tags] of [['yes', fixture.yes], ['no', fixture.no]]) {
      for (const tag of tags) scored.push({ note: fixture.id, tag, label, probability: probability.get(tag) });
    }
  }
  const positive = scored.filter(item => item.label === 'yes');
  const negative = scored.filter(item => item.label === 'no');
  const hits = positive.filter(item => item.probability >= threshold).length;
  const falseHits = negative.filter(item => item.probability >= threshold);
  const misses = positive.filter(item => item.probability < threshold);
  const mean = items => items.reduce((sum, item) => sum + item.probability, 0) / items.length;
  const round = value => Math.round(value * 1000) / 1000;
  results.push({
    variant: variant.name, models: [...models],
    precision: round(hits / (hits + falseHits.length || 1)), recall: round(hits / positive.length),
    meanYes: round(mean(positive)), meanNo: round(mean(negative)),
    falseTags: falseHits.map(item => `${item.note} #${item.tag} ${round(item.probability)}`),
    missedTags: misses.map(item => `${item.note} #${item.tag} ${round(item.probability)}`),
    scores: scored,
  });
}

const report = { date: new Date().toISOString(), provider: config.provider, dryRun, threshold,
  notes: fixtures.notes.length, labeledTags: results[0]?.scores.length ?? 0, results };
const out = option('--out');
if (out) await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...report, results: results.map(({ scores: _scores, ...summary }) => summary) }, null, 2)}\n`);
