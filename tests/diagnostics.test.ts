// Checks local diagnostic retention, content privacy, and snapshot comparisons through the vault boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { App, TFile } from 'obsidian';
import { DiagnosticLog, DIAGNOSTIC_LIMIT, enableDiagnostics } from '../src/diagnostics.ts';
import { applySuggestions, readNote } from '../src/vault.ts';
import { DEFAULTS } from '../src/config.ts';

const build = '012345abcdef+';
const file: TFile = { path: 'Private note name.md', basename: 'Private note name' } as never;
function storage() {
  let value: unknown = null;
  return { loadLocalStorage: () => value, saveLocalStorage: (_key: string, data: unknown) => { value = data; } };
}
type Report = { storage: string; events: { action: string; noteId: string; changed: Record<string, boolean | null> }[] };
const report = (log: DiagnosticLog) => JSON.parse(log.export()) as Report;

test('diagnostics explain metadata-only applies and real conflicts without retaining note values', async () => {
  const saved = storage();
  const original = '---\nmodified: 2026-10-17T12:00\ndescription: private-description\n---\nprivate-note-text\n';
  let current = original;
  const app = { ...saved, metadataCache: { getFileCache: () => null }, vault: {
    read: async () => current,
    process: async (_file: TFile, transform: (value: string) => string) => { current = transform(current); return current; },
  } } as unknown as App;
  const log = enableDiagnostics(app, build);
  const captured = await readNote(app, file);
  current = original.replace('2026-10-17T12:00', '2026-10-18T12:00');
  const settings = { ...DEFAULTS, poolMode: 'specific' as const, onlyTags: 'private-tag', apiKey: 'private-key' };
  await applySuggestions(app, file, captured.snapshot, ['private-tag'], [], settings);
  assert.deepEqual(report(log).events.map(event => event.action), ['captured', 'applied']);
  assert.deepEqual(report(log).events[1]!.changed, { raw: true, body: false, description: false, tags: false, frontmatter: true });
  current += 'edited-body';
  await assert.rejects(applySuggestions(app, file, captured.snapshot, ['private-tag'], [], settings), /changed after analysis/);
  const events = report(log).events;
  assert.equal(events.at(-1)!.action, 'apply-failed');
  assert.equal(events.at(-1)!.changed.body, true);
  assert.equal(new Set(events.map(event => event.noteId)).size, 1);
  assert.doesNotMatch(log.export(), /Private note name|private-description|private-note-text|private-tag|private-key|edited-body|2026-10-17T12:00/);
});

test('diagnostics retain a bounded local history across reloads and discard unrecognized fields', () => {
  const saved = storage();
  const first = new DiagnosticLog(saved, build);
  for (let index = 0; index < DIAGNOSTIC_LIMIT + 5; index++) first.capture(file, 'Body');
  assert.equal(report(first).events.length, DIAGNOSTIC_LIMIT);
  const stored = saved.loadLocalStorage() as Record<string, unknown>[];
  stored.at(-1)!.privateText = 'must-not-export';
  stored.push({ path: 'Private note name.md', body: 'must-not-export' });
  const reloaded = new DiagnosticLog(saved, build);
  assert.equal(report(reloaded).events.length, DIAGNOSTIC_LIMIT - 1);
  assert.doesNotMatch(reloaded.export(), /must-not-export|Private note name/);
});

test('unavailable local storage cannot prevent tagging or mask a real conflict', async () => {
  let current = 'Body';
  const app = { loadLocalStorage: () => { throw new Error('Storage unavailable'); },
    saveLocalStorage: () => { throw new Error('Storage full'); }, metadataCache: { getFileCache: () => null }, vault: {
      read: async () => current,
      process: async (_file: TFile, transform: (value: string) => string) => { current = transform(current); return current; },
    } } as unknown as App;
  const log = enableDiagnostics(app, build);
  const captured = await readNote(app, file);
  const settings = { ...DEFAULTS, poolMode: 'specific' as const, onlyTags: 'design' };
  await applySuggestions(app, file, captured.snapshot, ['design'], [], settings);
  assert.equal(report(log).storage, 'memory-only');
  assert.match(current, /design/);
  const edited = current + '\nEdited';
  current = edited;
  await assert.rejects(applySuggestions(app, file, captured.snapshot, ['design'], [], settings), /changed after analysis/);
  assert.equal(current, edited);
});

test('invalid metadata produces bounded diagnostic flags without storing parsing errors or content', () => {
  const log = new DiagnosticLog(storage(), build);
  log.apply(file, 'Body', '---\ntags: [private-broken\n---\nBody', false);
  assert.deepEqual(report(log).events[0]!.changed, { raw: true, body: false, description: null, tags: null, frontmatter: true });
  assert.doesNotMatch(log.export(), /private-broken/);
});
