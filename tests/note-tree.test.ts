// Exercises hierarchy sorting, filtered selection, folder checkbox states, and expansion without note writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { type TFile } from 'obsidian';
import { buildNoteTree, filterNoteTree, sortedNoteChildren, NoteTree } from '../src/note-tree.ts';
import { BulkTagModal } from '../src/bulk-modal.ts';
import { DEFAULTS } from '../src/config.ts';

interface Control {
  textContent: string; checked?: boolean; indeterminate?: boolean; title?: string; value?: string; hidden?: boolean; disabled?: boolean;
  'aria-label'?: string; 'aria-expanded'?: string; parentElement?: Control;
  click?(): Promise<void>; change?(value: string): void;
}
interface Elements { textContent: string; all(tag: string): Control[] }

const note = (path: string, mtime = 0, ctime = 0) => ({ path, basename: path.split('/').at(-1)!.slice(0, -3),
  extension: 'md', stat: { mtime, ctime, size: 0 } }) as TFile;

test('tree sorts folders and notes by names and descendant dates without mixing their levels', () => {
  const root = buildNoteTree([
    note('Alpha/old.md', 1, 50), note('Alpha/new.md', 90, 60),
    note('Beta/nested/middle.md', 40, 2), note('Beta/last.md', 80, 100),
    note('zebra.md', 100, 10), note('apple.md', 2, 80),
  ]);
  const names = (order: string) => sortedNoteChildren(root, order).map(entry => entry.name);
  assert.deepEqual(names('modified-desc'), ['Alpha', 'Beta', 'zebra', 'apple']);
  assert.deepEqual(names('modified-asc'), ['Alpha', 'Beta', 'apple', 'zebra']);
  assert.deepEqual(names('created-desc'), ['Beta', 'Alpha', 'apple', 'zebra']);
  assert.deepEqual(names('created-asc'), ['Beta', 'Alpha', 'zebra', 'apple']);
  assert.deepEqual(names('name-asc'), ['Alpha', 'Beta', 'apple', 'zebra']);
  assert.deepEqual(names('name-desc'), ['Beta', 'Alpha', 'zebra', 'apple']);
  const alpha = root.children.find(entry => entry.kind === 'folder' && entry.name === 'Alpha')!;
  assert.equal(alpha.kind, 'folder');
  if (alpha.kind !== 'folder') throw new Error('Expected folder');
  assert.deepEqual(sortedNoteChildren(alpha, 'modified-desc').map(entry => entry.name), ['new', 'old']);
  const filtered = filterNoteTree(root, 'old');
  assert.deepEqual(filtered.files.map(file => file.path), ['Alpha/old.md']);
  assert.deepEqual(filtered.children.map(entry => entry.name), ['Alpha']);
  assert.equal(filtered.children[0]!.kind, 'folder');
  assert.equal(filterNoteTree(root, 'beta/').files.length, 2);
  assert.equal(filterNoteTree(root, 'missing').files.length, 0);
});

function fixture(selected: TFile[] = []) {
  const files = [note('Inbox/first.md'), note('Inbox/nested/second.md'), note('Elsewhere/third.md')];
  const app = { vault: { getMarkdownFiles: () => files } };
  const plugin = { settings: { ...DEFAULTS } };
  const modal = new BulkTagModal(app as never, plugin as never, selected);
  modal.open();
  const ui = modal.contentEl as unknown as Elements;
  const folder = (path: string) => ui.all('input').find(input => input['aria-label']?.startsWith(`${path}, `))!;
  const file = (name: string) => ui.all('input').find(input => input['aria-label']?.startsWith(`${name} · `))!;
  const expand = (path: string) => ui.all('button').find(button => button.title === path)!.click!();
  const check = (input: Control, value: boolean) => { input.checked = value; input.change?.(''); };
  const search = (value: string) => ui.all('input').find(input => input['aria-label'] === 'Search notes by title or folder')!.change!(value);
  return { modal, files, ui, folder, file, expand, check, search };
}

test('folder selection is additive and individual exclusions leave mixed ancestors and mounted controls', async () => {
  const { modal, ui, folder, file, expand, check } = fixture();
  check(folder('Elsewhere'), true);
  check(folder('Inbox'), true);
  assert.match(ui.textContent, /3 notes selected/);
  assert.equal(folder('All notes').checked, true);
  await expand('Inbox'); await expand('Inbox/nested');
  const second = file('second');
  assert.equal(second.checked, true);
  check(second, false);
  assert.strictEqual(file('second'), second);
  assert.equal(folder('Inbox').indeterminate, true);
  assert.equal(folder('Inbox').checked, false);
  assert.equal(folder('All notes').indeterminate, true);
  assert.equal(folder('Elsewhere').checked, true);
  assert.match(ui.textContent, /2 notes selected/);
  check(folder('Inbox'), false);
  assert.match(ui.textContent, /1 note selected/);
  assert.equal(folder('Elsewhere').checked, true);
  await ui.all('button').find(button => button.textContent === 'Clear selection')!.click!();
  assert.equal(folder('Elsewhere').checked, false);
  assert.equal(folder('All notes').indeterminate, false);
  modal.close();
});

test('search selects matching descendants only, preserves hidden selection, and restores expansion', async () => {
  const { modal, ui, folder, file, expand, check, search } = fixture();
  await expand('Inbox');
  check(folder('Elsewhere'), true);
  search('second');
  assert.equal(file('second').checked, false);
  assert.equal(ui.all('input').some(input => input['aria-label']?.startsWith('first · ')), false);
  check(folder('Inbox'), true);
  assert.match(ui.textContent, /2 notes selected/);
  search('missing');
  assert.match(ui.textContent, /No matching notes/);
  search('');
  assert.equal(ui.all('button').find(button => button.title === 'Inbox')!['aria-expanded'], 'true');
  assert.equal(ui.all('button').find(button => button.title === 'Inbox/nested')!['aria-expanded'], 'false');
  assert.equal(file('first').checked, false);
  assert.equal(folder('Inbox').indeterminate, true);
  assert.equal(folder('Elsewhere').checked, true);
  await expand('Inbox/nested');
  assert.equal(file('second').checked, true);
  modal.close();
});

test('sidebar presets expose their checked notes and folder pagination preserves selection', async () => {
  const selected = note('Inbox/nested/second.md');
  const { modal, ui, file } = fixture([selected]);
  assert.equal(file('second').checked, true);
  assert.equal(ui.all('button').find(button => button.title === 'Inbox/nested')!['aria-expanded'], 'true');
  modal.close();
  const container = modal.contentEl.createDiv() as HTMLElement;
  const files = Array.from({ length: 101 }, (_, index) => note(`${index}.md`));
  let selection = files.slice(100);
  const tree = new NoteTree(container, files, () => selection, (scope, checked) => {
    selection = checked ? scope : [];
  });
  tree.setSort('name-asc');
  const elements = container as unknown as Elements;
  assert.equal(elements.all('input').some(input => input['aria-label']?.startsWith('100 · ')), false);
  await elements.all('button').find(button => button.textContent === 'Show more items')!.click!();
  assert.equal(elements.all('input').find(input => input['aria-label']?.startsWith('100 · '))!.checked, true);
  assert.equal(selection.length, 1);
});

test('selected view reveals scattered notes without changing selection and combines with search', async () => {
  const { modal, ui, folder, file, expand, check, search } = fixture();
  await expand('Inbox');
  check(file('first'), true);
  check(folder('Elsewhere'), true);
  await ui.all('button').find(button => button.textContent === 'Show selected')!.click!();
  assert.equal(file('first').checked, true);
  assert.equal(file('third').checked, true);
  assert.equal(ui.all('input').some(input => input['aria-label']?.startsWith('second · ')), false);
  assert.match(ui.textContent, /2 notes selected/);
  search('third');
  assert.equal(ui.all('input').some(input => input['aria-label']?.startsWith('first · ')), false);
  check(file('third'), false);
  assert.match(ui.textContent, /1 note selected/);
  assert.match(ui.textContent, /No matching notes/);
  search('');
  assert.equal(file('first').checked, true);
  assert.equal(ui.all('input').some(input => input['aria-label']?.startsWith('third · ')), false);
  await ui.all('button').find(button => button.textContent === 'Show all notes')!.click!();
  assert.equal(file('first').checked, true);
  assert.equal(folder('Elsewhere').checked, false);
  assert.equal(ui.all('button').find(button => button.title === 'Inbox/nested')!['aria-expanded'], 'false');
  modal.close();
});

test('sidebar presets start filtered and users can add outside notes or recover from an empty selection', async () => {
  const { modal, ui, file, folder, check } = fixture([note('Inbox/nested/second.md')]);
  assert.equal(file('second').checked, true);
  assert.equal(ui.all('input').some(input => input['aria-label']?.startsWith('first · ')), false);
  await ui.all('button').find(button => button.textContent === 'Show all notes')!.click!();
  check(folder('Elsewhere'), true);
  assert.match(ui.textContent, /2 notes selected/);
  await ui.all('button').find(button => button.textContent === 'Show selected')!.click!();
  assert.equal(file('second').checked, true);
  assert.equal(file('third').checked, true);
  await ui.all('button').find(button => button.textContent === 'Clear selection')!.click!();
  assert.match(ui.textContent, /No selected notes/);
  assert.equal(ui.all('button').find(button => button.textContent === 'Add recommended tags')!.disabled, true);
  await ui.all('button').find(button => button.textContent === 'Show all notes')!.click!();
  check(folder('Inbox'), true);
  assert.match(ui.textContent, /2 notes selected/);
  modal.close();
});
