// Verifies Markdown frontmatter preservation, safe tag additions, and stale-note protection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addTags, noteMetadata } from '../src/document.ts';

test('reads string and sequence tag metadata', () => {
  assert.deepEqual(noteMetadata('---\ntags: one two\ndescription: Hello\n---\nBody'), {
    body: 'Body', tags: ['one', 'two'], description: 'Hello',
  });
  assert.deepEqual(noteMetadata('---\ntags: [one, two]\n---\nBody').tags, ['one', 'two']);
});

test('adds tags while preserving comments and unrelated YAML', () => {
  const source = '---\n# owner comment\ntitle: Example\ntags:\n  - one # tag comment\naliases: [Alias]\n---\nBody\n';
  const result = addTags(source, source, ['two', '#ONE'], ['one']);
  assert.match(result, /# owner comment/);
  assert.match(result, /- one # tag comment/);
  assert.match(result, /- two/);
  assert.match(result, /aliases: \[ Alias \]/);
  assert.equal(noteMetadata(result).tags.filter(tag => tag.toLowerCase() === 'one').length, 1);
});

test('creates frontmatter for a plain note and preserves CRLF', () => {
  const source = 'Body\r\nSecond line\r\n';
  const result = addTags(source, source, ['new-tag'], []);
  assert.equal(result.includes('\r\n'), true);
  assert.deepEqual(noteMetadata(result).tags, ['new-tag']);
  assert.match(result, /Body\r\nSecond line/);
});

test('refuses stale content and invalid tag properties', () => {
  assert.throws(() => addTags('changed', 'original', ['tag'], []), /changed after analysis/);
  assert.throws(() => noteMetadata('---\ntags: { bad: true }\n---\nBody'), /must contain text tags/);
});

test('applies after a delayed timestamp and frontmatter rewrite without losing current metadata', () => {
  const analyzed = '---\nmodified: 2026-10-17T12:00\naliases: [Example]\n---\nDesign system notes.\n';
  const current = '---\nmodified: 2026-10-18T12:00\naliases:\n  - Example\n---\nDesign system notes.\n';
  const written = addTags(current, analyzed, ['design'], []);
  assert.match(written, /modified: 2026-10-18T12:00/);
  assert.match(written, /aliases:\n {2}- Example/);
  assert.deepEqual(noteMetadata(written), { body: 'Design system notes.\n', description: '', tags: ['design'] });
});

test('preserves intervening properties and comments that were not used for analysis', () => {
  const analyzed = '---\ndescription: Design notes\ntags: [existing]\n---\nBody\n';
  const current = '---\n# Keep this comment\ndescription: Design notes\ntags:\n  - existing\nstatus: reviewed\n---\nBody\n';
  const written = addTags(current, analyzed, ['design'], ['existing']);
  assert.match(written, /# Keep this comment/);
  assert.match(written, /status: reviewed/);
  assert.deepEqual(noteMetadata(written).tags, ['existing', 'design']);
  assert.equal(addTags(current, analyzed, ['existing'], ['existing']), current);
});

test('still refuses changes to the analyzed body, description, or tags', () => {
  const analyzed = '---\ndescription: Design notes\ntags: [existing]\n---\nBody\n';
  for (const current of [
    analyzed.replace('Body', 'Edited body'),
    analyzed.replace('Design notes', 'Edited description'),
    analyzed.replace('[existing]', '[existing, added]'),
    analyzed.replace('[existing]', '[]'),
    analyzed.replace('Body\n', 'Body'),
  ]) assert.throws(() => addTags(current, analyzed, ['design'], ['existing']), /changed after analysis/);
});
