// Verifies review, explicit apply, quick apply, and stale-note protections with a mock transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULTS, type Config } from '../src/config.ts';
import { applyReviewPlan, parseReviewPlan, quickApplyFile, reviewFile } from '../scripts/cli/cli-workflow.ts';
import type { Transport } from '../src/client.ts';

const config = (values: Partial<Config> = {}): Config => ({ ...DEFAULTS, apiKey: 'test-key', poolMode: 'all', ...values });
const tags = [{ tag: 'design', count: 3 }, { tag: 'writing', count: 2 }, { tag: 'private', count: 1 }];
const transport: Transport = async request => ({ status: 200, json: {
  answers: Object.fromEntries(Object.keys(request.questions).map((key, index) =>
    [key, { type: 'noul', noul: index === 0 ? 0.9 : 0.6 }])),
  model: 'jev-latest', usage: { input_tokens: 10, output_tokens: 2 },
} });

async function fixture(content = '---\ntags: [existing]\n---\nDesign note\n') {
  const directory = await mkdtemp(join(tmpdir(), 'tag-match-workflow-'));
  const path = join(directory, 'note.md');
  await writeFile(path, content);
  return path;
}

test('review returns a non-writing plan and apply writes explicit reviewed tags', async () => {
  const path = await fixture();
  const before = await readFile(path, 'utf8');
  const plan = await reviewFile(path, tags, config(), transport, ['inline']);
  assert.equal(plan.status, 'review-ready');
  assert.deepEqual(plan.existingTags, ['existing', 'inline']);
  assert.deepEqual(plan.proposedTags.map(item => item.tag), ['design']);
  assert.equal(await readFile(path, 'utf8'), before);

  const result = await applyReviewPlan(plan, ['design'], config());
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.addedTags, ['design']);
  assert.match(await readFile(path, 'utf8'), /tags: \[ existing, design \]/);
});

test('apply parses only the validated fields it uses from a review plan', async () => {
  const path = await fixture();
  const plan = await reviewFile(path, tags, config(), transport);
  assert.deepEqual(parseReviewPlan(plan), {
    note: plan.note, existingTags: plan.existingTags, evaluatedTags: plan.evaluatedTags,
  });
  assert.throws(() => parseReviewPlan({ ...plan, evaluatedTags: ['design', 3] }), /review plan is invalid/);
  assert.throws(() => parseReviewPlan({ ...plan, result: null }), /review plan is invalid/);
});

test('apply refuses stale notes, invalid selections, exclusions, and excess tags', async () => {
  const path = await fixture();
  const plan = await reviewFile(path, tags, config(), transport);
  await assert.rejects(applyReviewPlan(plan, ['design', '#design'], config()), /must not contain duplicates/);
  await assert.rejects(applyReviewPlan(plan, ['unknown'], config()), /must come from this review plan/);
  await assert.rejects(applyReviewPlan(plan, ['private'], config({ excludedTags: 'private' })), /excluded/);
  await assert.rejects(applyReviewPlan(plan, ['design', 'writing'], config({ maxTagsToAdd: 1 })), /at most 1/);
  await writeFile(path, 'Changed elsewhere\n');
  await assert.rejects(applyReviewPlan(plan, ['design'], config()), /changed after analysis/);
  assert.equal(await readFile(path, 'utf8'), 'Changed elsewhere\n');
});

test('quick apply writes recommendations and reports no-op when none qualify', async () => {
  const appliedPath = await fixture('Body\n');
  const applied = await quickApplyFile(appliedPath, tags, config(), transport);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(applied.addedTags, ['design']);
  assert.match(await readFile(appliedPath, 'utf8'), /design/);

  const noOpPath = await fixture('Another body\n');
  const noOp = await quickApplyFile(noOpPath, tags, config({ minProbability: 0.95 }), transport);
  assert.equal(noOp.status, 'no-op');
  assert.deepEqual(noOp.addedTags, []);
  assert.equal(await readFile(noOpPath, 'utf8'), 'Another body\n');
});

test('quick apply does not write after incomplete analysis', async () => {
  const path = await fixture('Safe body\n');
  const manyTags = Array.from({ length: 100 }, (_, index) => ({ tag: `tag-${index}`, count: 100 - index }));
  const definitions = manyTags.map(({ tag }) => `${tag} = ${'meaning '.repeat(120)}`).join('\n');
  let call = 0;
  const partial: Transport = async request => {
    call++;
    if (call === 2) return { status: 401, json: {} };
    return { status: 200, json: { answers: Object.fromEntries(Object.keys(request.questions)
      .map(key => [key, { type: 'noul', noul: 0.9 }])) } };
  };
  await assert.rejects(quickApplyFile(path, manyTags, config({ definitions }), partial), /no partial suggestions/);
  assert.equal(await readFile(path, 'utf8'), 'Safe body\n');
});
