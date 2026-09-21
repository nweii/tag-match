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
