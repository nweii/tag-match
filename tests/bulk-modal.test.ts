// Exercises bulk scoping and the direct-add dialog through its visible controls and guarded undo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { type TFile } from 'obsidian';
import { BulkTagModal, filesInScope } from '../src/bulk-modal.ts';
import { DEFAULTS } from '../src/config.ts';
import { type Transport } from '../src/client.ts';

interface Control { textContent: string; checked?: boolean; indeterminate?: boolean; disabled?: boolean; hidden?: boolean; value?: string; title?: string; 'aria-label'?: string; 'aria-expanded'?: string;
  click?(): Promise<void>; change?(value: string | number): void }

function fixture() {
  const files = ['Inbox/first.md', 'Inbox/nested/second.md', 'Inbox-other/third.md'].map(path => ({
    path, basename: path.split('/').at(-1)!.slice(0, -3), extension: 'md', stat: { mtime: 0, ctime: 0, size: 0 },
  })) as TFile[];
  const content = new Map(files.map(file => [file.path, 'Design systems and typography.']));
  const app = { vault: { getMarkdownFiles: () => files, read: async (file: TFile) => content.get(file.path)!,
    process: async (file: TFile, transform: (value: string) => string) => {
      const next = transform(content.get(file.path)!); content.set(file.path, next); return next;
    } }, metadataCache: { getTags: () => ({ '#design': 3 }), getFileCache: () => null },
    secretStorage: { getSecret: () => 'test-key' } };
  const locks = new Set<string>();
  const transport: Transport = async request => ({ status: 200, json: { answers: Object.fromEntries(
    Object.keys(request.questions).map(key => [key, { type: 'noul', noul: 0.9 }])) } });
  const plugin = { settings: { ...DEFAULTS, typeSafeSecretId: 'saved-key' }, transport,
    beginRun: (path: string) => { if (locks.has(path)) return false; locks.add(path); return true; },
    endRun: (path: string) => { locks.delete(path); } };
  return { files, app, plugin, content, locks };
}

test('active rows distinguish analyzing from queued notes and progress counts only completed notes', async () => {
  const { app, plugin, files, content } = fixture();
  const fourth = { ...files[0]!, path: 'fourth.md', basename: 'fourth' };
  const scope = [...files, fourth];
  content.set(fourth.path, 'Fourth note');
  app.vault.getMarkdownFiles = () => scope;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const transport = plugin.transport;
  plugin.transport = async (...args) => { await pending; return transport(...args); };
  const modal = new BulkTagModal(app as never, plugin as never, scope);
  modal.open();
  const running = startBatch(modal);
  await new Promise(resolve => setTimeout(resolve, 0));
  const rows = controls(modal).all('p');
  assert.equal(rows.filter(row => row.textContent === 'Analyzing').length, 3);
  assert.equal(rows.filter(row => row.textContent === 'Waiting').length, 1);
  assert.equal(modal.progressText, 'Tag Match: 0/4');
  release();
  await running;
  assert.match(controls(modal).textContent, /4 changed/);
  modal.close();
});

test('single-note quick apply uses its analysis settings even when saved defaults change during a request', async () => {
  const { default: TagMatchPlugin } = await import('../src/main.ts');
  const { app, files, content } = fixture();
  const nativeApp = { ...app, workspace: { getActiveFile: () => files[0], on: () => ({}) },
    vault: { ...app.vault, configDir: 'synthetic-config', adapter: { exists: async () => false } } };
  const plugin = new TagMatchPlugin(nativeApp as never, { id: 'tag-match', version: '0.2.1' } as never);
  await plugin.onload();
  plugin.settings = { ...DEFAULTS, poolMode: 'specific', onlyTags: 'new/topic', typeSafeSecretId: 'saved-key' };
  plugin.transport = async request => {
    plugin.settings = { ...plugin.settings, poolMode: 'all', onlyTags: '', excludedTags: 'new/topic' };
    return { status: 200, json: { answers: Object.fromEntries(Object.keys(request.questions)
      .map(key => [key, { type: 'noul', noul: 0.9 }])) } };
  };
  const commands = (plugin as unknown as { commands: { id: string; checkCallback(checking: boolean): boolean }[] }).commands;
  assert.equal(commands.find(command => command.id === 'add-recommended-tags')!.checkCallback(false), true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(content.get(files[0]!.path)!, /new\/topic/);
  assert.equal((plugin as unknown as { runs: Map<string, unknown> }).runs.size, 0);
  plugin.onunload();
});

test('batch tag constraints override defaults without saving them and invalid tags cannot start', async () => {
  const { app, plugin, files, content, locks } = fixture();
  plugin.settings.poolMode = 'specific';
  plugin.settings.onlyTags = 'global/tag';
  plugin.settings.excludedTags = 'temporary';
  const saved = { ...plugin.settings };
  const modal = new BulkTagModal(app as never, plugin as never, files.slice(0, 1));
  modal.open();
  const ui = controls(modal);
  const only = ui.all('textarea').find(input => input['aria-label'] === 'Tags')!;
  assert.ok(!ui.all('textarea').some(input => input['aria-label'] === 'Excluded tags'));
  assert.equal(only.value, 'global/tag');
  const start = ui.all('button').find(button => button.textContent === 'Add tags to 1 note')!;
  only.change?.('two words');
  assert.equal(start.disabled, true);
  await start.click?.();
  assert.equal(locks.size, 0);
  assert.equal(content.get(files[0]!.path), 'Design systems and typography.');
  only.change?.('new/topic, temporary');
  const mode = ui.all('select').find(input => input['aria-label'] === 'Selection method')!;
  mode.change?.('all');
  assert.ok(!ui.all('textarea').some(input => input['aria-label'] === 'Tags'));
  assert.equal(ui.all('textarea').find(input => input['aria-label'] === 'Excluded tags')!.value, 'temporary');
  mode.change?.('specific');
  assert.equal(ui.all('textarea').find(input => input['aria-label'] === 'Tags')!.value, 'new/topic, temporary');
  assert.equal(start.disabled, false);
  await start.click?.();
  assert.match(content.get(files[0]!.path)!, /new\/topic/);
  assert.match(content.get(files[0]!.path)!, /temporary/);
  assert.doesNotMatch(content.get(files[0]!.path)!, /global\/tag/);
  assert.deepEqual(plugin.settings, saved);
});

function controls(modal: BulkTagModal) {
  return modal.contentEl as unknown as { textContent: string; all(tag: string): Control[] };
}

async function startBatch(modal: BulkTagModal) {
  await controls(modal).all('button').find(button => button.textContent.startsWith('Add tags to'))?.click?.();
}

test('folder scope includes descendants without including similarly named folders', () => {
  const { files } = fixture();
  assert.deepEqual(filesInScope(files, ['Inbox']).map(file => file.path), ['Inbox/first.md', 'Inbox/nested/second.md']);
  assert.equal(filesInScope(files, ['/']).length, 3);
  assert.deepEqual(filesInScope(files, ['Inbox/first.md']).map(file => file.path), ['Inbox/first.md']);
});

test('note sorting defaults to modified time and preserves selection through sorting and search', () => {
  const { app, plugin, files } = fixture();
  for (const [index, file] of files.entries()) {
    file.path = `${file.basename}.md`;
    file.stat = { mtime: [200, 100, 300][index]!, ctime: [10, 30, 20][index]!, size: 0 };
  }
  const modal = new BulkTagModal(app as never, plugin as never);
  modal.open();
  const ui = controls(modal);
  const notes = () => ui.all('input').filter(input => input['aria-label']?.includes(' · '));
  const titles = () => notes().map(input => input['aria-label']!.split(' · ')[0]);
  const sort = ui.all('select').find(input => input['aria-label'] === 'Sort by')!;
  const changeSort = (value: string) => { sort.value = value; sort.change?.(''); };
  assert.equal(sort.value, 'modified-desc');
  assert.deepEqual(titles(), ['third', 'first', 'second']);
  notes()[0]!.checked = true;
  notes()[0]!.change?.('');
  assert.match(ui.textContent, /1 note selected/);
  for (const [value, expected] of [
    ['modified-asc', ['second', 'first', 'third']], ['created-desc', ['second', 'third', 'first']],
    ['created-asc', ['first', 'third', 'second']], ['name-asc', ['first', 'second', 'third']],
    ['name-desc', ['third', 'second', 'first']],
  ] as const) {
    changeSort(value);
    assert.deepEqual(titles(), expected);
    assert.equal(notes().find(input => input['aria-label']!.startsWith('third · '))!.checked, true);
  }
  changeSort('created-desc');
  ui.all('input').find(input => input['aria-label'] === 'Search notes by title or folder')!.change?.('first');
  assert.deepEqual(titles(), ['first']);
  assert.match(ui.textContent, /1 note selected/);
  modal.close();
});

test('bulk setup requires an explicit scope and directly applies matches without a tag review queue', async () => {
  const { app, plugin, content, locks } = fixture();
  const modal = new BulkTagModal(app as never, plugin as never);
  modal.open();
  const ui = controls(modal);
  const start = ui.all('button').find(button => button.textContent === 'Add tags')!;
  assert.equal(start.disabled, true);
  assert.equal(ui.all('button').some(button => button.textContent === 'Select folder'), false);
  const folder = ui.all('input').find(input => input['aria-label'] === 'Inbox, 2 notes')!;
  folder.checked = true; folder.change?.('');
  assert.match(ui.textContent, /2 notes selected/);
  assert.match(ui.textContent, /Minimum match score: 75%/);
  assert.equal(start.disabled, false);
  await startBatch(modal);
  assert.match(content.get('Inbox/first.md')!, /design/);
  assert.match(content.get('Inbox/nested/second.md')!, /design/);
  assert.equal(content.get('Inbox-other/third.md'), 'Design systems and typography.');
  assert.match(ui.textContent, /2 changed/);
  assert.equal(start.hidden, true);
  assert.equal(locks.size, 2);
  await ui.all('button').find(button => button.textContent === 'Undo additions')?.click?.();
  assert.equal(content.get('Inbox/first.md'), 'Design systems and typography.');
  assert.match(ui.textContent, /2 undone/);
  modal.dispose();
  assert.equal(locks.size, 0);
});

test('bulk undo leaves later edits untouched and reports a busy note without analyzing it', async () => {
  const { app, plugin, files, content, locks } = fixture();
  locks.add(files[1]!.path);
  const modal = new BulkTagModal(app as never, plugin as never, files.slice(0, 2));
  modal.open();
  const ui = controls(modal);
  await startBatch(modal);
  assert.match(ui.textContent, /1 changed, 0 unchanged, 1 skipped/);
  const edited = content.get(files[0]!.path)! + '\nLater edit';
  content.set(files[0]!.path, edited);
  await ui.all('button').find(button => button.textContent === 'Undo additions')?.click?.();
  assert.equal(content.get(files[0]!.path), edited);
  assert.match(ui.textContent, /skipped/i);
  modal.dispose();
  assert.deepEqual([...locks], [files[1]!.path]);
});

test('closing after undo releases reservations using their original run controller', async () => {
  const { app, plugin, files } = fixture();
  const owners = new Map<string, AbortController>();
  const guardedPlugin = { ...plugin,
    beginRun: (path: string, controller: AbortController) => {
      if (owners.has(path)) return false;
      owners.set(path, controller); return true;
    },
    endRun: (path: string, controller: AbortController) => {
      if (owners.get(path) === controller) owners.delete(path);
    },
  };
  const modal = new BulkTagModal(app as never, guardedPlugin as never, files.slice(0, 1));
  modal.open();
  await startBatch(modal);
  assert.equal(owners.size, 1);
  await controls(modal).all('button').find(button => button.textContent === 'Undo additions')?.click?.();
  modal.close();
  assert.equal(owners.size, 0, 'Undo uses a fresh controller without changing reservation ownership');
});

test('plugin exposes folder and multiple-selection bulk actions through Obsidian events', async () => {
  const { default: TagMatchPlugin } = await import('../src/main.ts');
  const { app, files, plugin: mocked } = fixture();
  const handlers = new Map<string, (menu: unknown, selection: unknown) => void>();
  const nativeApp = { ...app, workspace: {
    getActiveFile: () => files[0],
    on: (event: string, handler: (menu: unknown, selection: unknown) => void) => { handlers.set(event, handler); return {}; },
  }, vault: { ...app.vault, configDir: 'synthetic-config', adapter: { exists: async () => false } } };
  const plugin = new TagMatchPlugin(nativeApp as never, { id: 'tag-match', version: '0.2.1' } as never);
  await plugin.onload();
  plugin.settings = mocked.settings;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  plugin.transport = async (...args) => { await pending; return mocked.transport(...args); };
  const actions: { title?: string; callback?: () => void }[] = [];
  const menu = { addItem: (build: (item: unknown) => void) => {
    const action: { title?: string; callback?: () => void } = {};
    const item = { setTitle: (title: string) => { action.title = title; return item; }, setIcon: () => item,
      onClick: (callback: () => void) => { action.callback = callback; return item; } };
    build(item); actions.push(action);
  } };
  handlers.get('files-menu')!(menu, [files[0], files[1]]);
  assert.equal(actions[0]!.title, 'Match tags to selected notes…');
  actions[0]!.callback!();
  const modals = (plugin as unknown as { bulkModals: Set<BulkTagModal> }).bulkModals;
  assert.match(controls([...modals][0]!).textContent, /2 notes selected/);
  assert.ok(controls([...modals][0]!).all('button').some(button => button.textContent === 'Show all notes'));
  assert.equal(controls([...modals][0]!).all('input').some(input => input['aria-label']?.startsWith('third · ')), false);
  handlers.get('file-menu')!(menu, { path: 'Inbox' });
  assert.equal(actions[1]!.title, 'Match tags…');
  actions[1]!.callback!();
  assert.match(controls([...modals][0]!).textContent, /2 notes selected/);
  assert.equal(modals.size, 1);
  const run = [...modals][0]!;
  const running = startBatch(run);
  await new Promise(resolve => setTimeout(resolve, 0));
  run.close();
  assert.equal(run.retained, true);
  assert.equal(run.visible, false);
  const owner = plugin as unknown as { bulkNotice?: { duration: number; messageEl: { all(tag: string): Control[] } }; bulkStatus: { buttonEl: Control } };
  const noticeButton = owner.bulkNotice!.messageEl.all('button')[0]!;
  assert.match(noticeButton.textContent, /0\/2.*Open progress/);
  await noticeButton.click?.();
  assert.equal(run.visible, true);
  assert.equal(owner.bulkNotice, undefined);
  run.close();
  const commands = (plugin as unknown as { commands: { id: string; checkCallback(checking: boolean): boolean }[] }).commands;
  const progress = commands.find(command => command.id === 'show-bulk-progress')!;
  assert.equal(progress.checkCallback(true), true);
  progress.checkCallback(false);
  assert.equal(run.visible, true);
  run.close();
  release();
  await running;
  assert.equal(owner.bulkNotice!.duration, 0, 'The completion action remains available until dismissed or opened');
  const completionButton = owner.bulkNotice!.messageEl.all('button')[0]!;
  assert.match(completionButton.textContent, /Batch finished.*Open results/);
  await completionButton.click?.();
  assert.match(controls(run).textContent, /2 changed/);
  assert.equal(modals.size, 1, 'Opening progress reuses the plugin-owned run');
  run.close();
  assert.equal(owner.bulkStatus.buttonEl.hidden, true);
  assert.equal(owner.bulkNotice, undefined);
  plugin.onunload();
  assert.equal(modals.size, 0);
});

test('large bulk scopes tag every note while revealing results in manageable groups', async () => {
  const { app, plugin, content, locks } = fixture();
  const files = Array.from({ length: 101 }, (_, index) => ({ path: `Inbox/${index}.md`, basename: String(index), extension: 'md', stat: { mtime: 0, ctime: 0, size: 0 } })) as TFile[];
  for (const file of files) content.set(file.path, 'Design systems and typography.');
  app.vault.getMarkdownFiles = () => files;
  const modal = new BulkTagModal(app as never, plugin as never, files);
  modal.open();
  const ui = controls(modal);
  await startBatch(modal);
  assert.equal(locks.size, 101);
  assert.match(content.get('Inbox/100.md')!, /design/);
  assert.match(ui.textContent, /101 changed/);
  assert.equal(ui.all('p').some(row => row.textContent === 'Inbox/100.md'), false);
  await ui.all('button').find(button => button.textContent === 'Show 1 more result')?.click?.();
  assert.equal(ui.all('p').some(row => row.textContent === 'Inbox/100.md'), true);
  modal.dispose();
  assert.equal(locks.size, 0);
});

test('individual selection retains checked notes across searches and applies only that selection', async () => {
  const { app, plugin, content } = fixture();
  const modal = new BulkTagModal(app as never, plugin as never);
  modal.open();
  const ui = controls(modal);
  const search = ui.all('input').find(input => (input as Control & { placeholder?: string }).placeholder === 'Note title or folder')!;
  search.change?.('first');
  const first = ui.all('input').find(input => input['aria-label']?.startsWith('first · '))!;
  first.checked = true;
  first.change?.('');
  assert.match(ui.textContent, /1 note selected/);
  search.change?.('third');
  const third = ui.all('input').find(input => input['aria-label']?.startsWith('third · '))!;
  third.checked = true;
  third.change?.('');
  assert.match(ui.textContent, /2 notes selected/);
  await startBatch(modal);
  assert.match(content.get('Inbox/first.md')!, /design/);
  assert.match(content.get('Inbox-other/third.md')!, /design/);
  assert.equal(content.get('Inbox/nested/second.md'), 'Design systems and typography.');
  modal.dispose();
});

test('batch adjustments control each request and write without changing saved defaults', async () => {
  for (const threshold of [80, 95]) {
    const { app, plugin, files, content } = fixture();
    app.metadataCache.getTags = () => ({ '#design': 3, '#writing': 2 } as never);
    const saved = { ...plugin.settings };
    const candidates: string[][] = [];
    const transport = plugin.transport;
    plugin.transport = async (request, key, signal, endpoint) => {
      candidates.push(Object.values(request.questions).map(question => (question as { instructions: { tag: string } }).instructions.tag));
      return transport(request, key, signal, endpoint);
    };
    const modal = new BulkTagModal(app as never, plugin as never, files.slice(0, 2));
    modal.open();
    const ui = controls(modal);
    ui.all('select').find(control => control['aria-label'] === 'Selection method')!.change?.('count');
    ui.all('input').find(control => control['aria-label'] === 'Selection size')!.change?.('1');
    ui.all('input').find(control => control['aria-label'] === 'Selection mix, most-used percentage')!.change?.(100);
    ui.all('input').find(control => control['aria-label'] === 'Minimum match score')!.change?.(String(threshold));
    ui.all('input').find(control => control['aria-label'] === 'Maximum tags per note')!.change?.('1');
    assert.match(ui.textContent, new RegExp(`Minimum match score: ${threshold}%`));
    await startBatch(modal);
    assert.deepEqual(candidates, [['design'], ['design']]);
    assert.equal(content.get(files[0]!.path)!.includes('tags:'), threshold === 80);
    assert.deepEqual(plugin.settings, saved);
    modal.dispose();
  }
});

test('one click starts the batch and closing results releases undo without a confirmation', async () => {
  const { app, plugin, files, content, locks } = fixture();
  const modal = new BulkTagModal(app as never, plugin as never, files.slice(0, 1));
  modal.open();
  await startBatch(modal);
  assert.match(content.get(files[0]!.path)!, /design/);
  assert.equal(locks.size, 1);
  assert.doesNotMatch(controls(modal).textContent, /Undo remains available|Notes edited after|Discard results/);
  await controls(modal).all('button').find(button => button.textContent === 'Close')!.click?.();
  assert.equal(modal.retained, false);
  assert.equal(modal.disposed, true);
  assert.equal(locks.size, 0);
  assert.match(content.get(files[0]!.path)!, /design/);
});

test('hiding a running batch does not stop it, and explicit Stop still prevents late writes', async () => {
  const { app, plugin, files, content } = fixture();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const transport = plugin.transport;
  plugin.transport = async (request, key, signal, endpoint) => {
    if (++calls >= 2) await pending;
    return transport(request, key, signal, endpoint);
  };
  const process = app.vault.process;
  app.vault.process = async (file, transform) => {
    const value = await process(file, transform);
    if (file.path === files[0]!.path) entered();
    return value;
  };
  const modal = new BulkTagModal(app as never, plugin as never, files);
  modal.open();
  const run = startBatch(modal);
  await waiting;
  modal.close();
  assert.equal(modal.visible, false);
  assert.equal(modal.retained, true);
  assert.doesNotMatch(controls(modal).textContent, /Stopping/);
  modal.open();
  await controls(modal).all('button').find(button => button.textContent === 'Stop')!.click?.();
  assert.match(controls(modal).textContent, /Stopping/);
  release();
  await run;
  assert.equal(calls, 3);
  assert.match(controls(modal).textContent, /1 changed, 0 unchanged, 0 skipped, 0 failed, 2 not processed/);
  assert.ok(controls(modal).all('button').some(button => button.textContent === 'Undo additions' && !button.hidden));
  assert.equal(content.get(files[1]!.path), 'Design systems and typography.');
  modal.dispose();
});

test('batch preflight rejects invalid global configuration before charging or locking notes', async () => {
  const { app, plugin, files, locks } = fixture();
  plugin.settings.definitions = 'Broken definition';
  let calls = 0;
  plugin.transport = async () => { calls++; throw new Error('Must not call'); };
  const modal = new BulkTagModal(app as never, plugin as never, files);
  modal.open();
  await startBatch(modal);
  assert.match(controls(modal).textContent, /tag = meaning/);
  assert.equal(calls, 0);
  assert.equal(locks.size, 0);
  assert.equal(controls(modal).all('button').find(button => button.textContent === 'Add tags to 3 notes')!.hidden, undefined);
  modal.dispose();
});

test('results filters expose a late failure beyond the first page', async () => {
  const { app, plugin, content } = fixture();
  const files = Array.from({ length: 101 }, (_, index) => ({ path: `Inbox/${index}.md`, basename: String(index), extension: 'md', stat: { mtime: 0, ctime: 0, size: 0 } })) as TFile[];
  for (const file of files) content.set(file.path, 'Design systems and typography.');
  app.vault.getMarkdownFiles = () => files;
  const transport = plugin.transport;
  let calls = 0;
  plugin.transport = async (request, key, signal, endpoint) => ++calls === 101
    ? { status: 401, json: {} } : transport(request, key, signal, endpoint);
  const modal = new BulkTagModal(app as never, plugin as never, files);
  modal.open();
  await startBatch(modal);
  assert.match(controls(modal).textContent, /rejected the API key/);
  const filter = controls(modal).all('select').find(control => control['aria-label'] === 'Results to show')!;
  filter.value = 'problems'; filter.change?.('');
  assert.ok(controls(modal).all('p').some(row => row.textContent === 'Inbox/100.md'));
  assert.equal(controls(modal).all('p').some(row => row.textContent === 'Inbox/0.md'), false);
  modal.dispose();
});

test('invalid batch numbers cannot silently start with an older valid value', async () => {
  const { app, plugin, files, locks } = fixture();
  let calls = 0;
  const transport = plugin.transport;
  plugin.transport = async (request, key, signal, endpoint) => { calls++; return transport(request, key, signal, endpoint); };
  const modal = new BulkTagModal(app as never, plugin as never, files);
  modal.open();
  const ui = controls(modal);
  const maximum = ui.all('input').find(control => control['aria-label'] === 'Maximum tags per note')!;
  maximum.change?.('0');
  assert.match(ui.textContent, /Enter a whole number from 1 to 1,000/);
  assert.equal(ui.all('button').find(button => button.textContent === 'Add tags to 3 notes')!.disabled, true);
  await ui.all('button').find(button => button.textContent === 'Add tags to 3 notes')!.click?.();
  assert.equal(calls, 0);
  assert.equal(locks.size, 0);
  maximum.change?.('2');
  assert.equal(ui.all('button').find(button => button.textContent === 'Add tags to 3 notes')!.disabled, false);
  ui.all('select').find(control => control['aria-label'] === 'Selection method')!.change?.('count');
  const size = ui.all('input').find(control => control['aria-label'] === 'Selection size')!;
  size.change?.('');
  assert.equal(ui.all('button').find(button => button.textContent === 'Add tags to 3 notes')!.disabled, true);
  size.change?.('10');
  assert.equal(ui.all('button').find(button => button.textContent === 'Add tags to 3 notes')!.disabled, false);
  modal.dispose();
});
