// Renders a searchable note hierarchy with independent folder expansion and additive checkbox selection.
import { ButtonComponent, setIcon, type TFile } from 'obsidian';
import { PAGE_SIZE } from './tag-list.ts';
import { renderMiddleText } from './middle-text.ts';

interface NoteEntry { kind: 'note'; name: string; path: string; file: TFile }
export interface NoteFolder {
  kind: 'folder'; name: string; path: string; children: NoteEntryOrFolder[]; files: TFile[];
  dates: { modified: { asc: number; desc: number }; created: { asc: number; desc: number } };
}
type NoteEntryOrFolder = NoteEntry | NoteFolder;

export function buildNoteTree(files: TFile[]): NoteFolder {
  const folder = (name: string, path: string): NoteFolder => ({ kind: 'folder', name, path, children: [], files: [],
    dates: { modified: { asc: Infinity, desc: -Infinity }, created: { asc: Infinity, desc: -Infinity } } });
  const root = folder('All notes', '/');
  const folders = new Map<string, NoteFolder>([['/', root]]);
  const add = (parent: NoteFolder, file: TFile) => {
    parent.files.push(file);
    for (const [field, key] of [['modified', 'mtime'], ['created', 'ctime']] as const) {
      parent.dates[field].asc = Math.min(parent.dates[field].asc, file.stat[key]);
      parent.dates[field].desc = Math.max(parent.dates[field].desc, file.stat[key]);
    }
  };
  for (const file of files) {
    let parent = root;
    add(parent, file);
    const parts = file.path.split('/');
    parts.pop();
    let path = '';
    for (const name of parts) {
      path = path ? `${path}/${name}` : name;
      let child = folders.get(path);
      if (!child) { child = folder(name, path); folders.set(path, child); parent.children.push(child); }
      add(child, file);
      parent = child;
    }
    parent.children.push({ kind: 'note', name: file.basename, path: file.path, file });
  }
  return root;
}

/** Keeps folder dates from the full hierarchy so searching does not change their sort order. */
export function filterNoteTree(folder: NoteFolder, query: string, selected?: ReadonlySet<string>): NoteFolder {
  if (!query && !selected) return folder;
  const matches = (file: TFile) => file.path.toLowerCase().includes(query) && (!selected || selected.has(file.path));
  const children = folder.children.flatMap<NoteEntryOrFolder>(entry => {
    if (entry.kind === 'note') return matches(entry.file) ? [entry] : [];
    const filtered = filterNoteTree(entry, query, selected);
    return filtered.files.length ? [filtered] : [];
  });
  return { ...folder, children, files: folder.files.filter(matches) };
}

/** Like a file explorer, folders precede notes; both sets follow the chosen name or descendant-note date order. */
export function sortedNoteChildren(folder: NoteFolder, order: string): NoteEntryOrFolder[] {
  const [field, direction] = order.split('-');
  const sign = direction === 'asc' ? 1 : -1;
  return [...folder.children].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    const alphabetical = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      || a.path.localeCompare(b.path);
    if (field === 'name') return sign * alphabetical;
    const timestamp = (entry: NoteEntryOrFolder) => entry.kind === 'folder'
      ? entry.dates[field === 'created' ? 'created' : 'modified'][direction === 'asc' ? 'asc' : 'desc']
      : entry.file.stat[field === 'created' ? 'ctime' : 'mtime'];
    return sign * (timestamp(a) - timestamp(b)) || alphabetical;
  });
}

let treeId = 0;

export class NoteTree {
  private readonly container: HTMLElement;
  private readonly selection: () => TFile[];
  private readonly select: (files: TFile[], checked: boolean) => void;
  private readonly root: NoteFolder;
  private readonly expanded = new Set<string>(['/']);
  private readonly filteredCollapsed = new Set<string>();
  private readonly limits = new Map<string, number>();
  private readonly noteControls = new Map<string, { input: HTMLInputElement; row: HTMLElement }>();
  private readonly folderControls = new Map<string, { input: HTMLInputElement; row: HTMLElement; files: TFile[]; button: HTMLButtonElement }>();
  private readonly id = ++treeId;
  private query = '';
  private order = 'modified-desc';
  private groupId = 0;
  private onlySelected: boolean;

  constructor(container: HTMLElement, files: TFile[], selection: () => TFile[],
    select: (files: TFile[], checked: boolean) => void, selectedOnly = false) {
    this.container = container;
    this.selection = selection;
    this.select = select;
    this.onlySelected = selectedOnly;
    this.root = buildNoteTree(files);
    // Sidebar selections open their ancestor folders so the prechecked notes can be inspected immediately.
    for (const file of selection()) {
      const parts = file.path.split('/'); parts.pop();
      while (parts.length) { this.expanded.add(parts.join('/')); parts.pop(); }
    }
    this.render();
  }

  setQuery(value: string) {
    this.query = value.trim().toLowerCase();
    this.filteredCollapsed.clear();
    this.limits.clear();
    this.render();
  }

  setSort(value: string) { this.order = value; this.render(); }

  get selectedOnly() { return this.onlySelected; }

  setSelectedOnly(value: boolean) {
    this.onlySelected = value;
    this.filteredCollapsed.clear();
    this.limits.clear();
    this.render();
  }

  updateSelection() {
    if (this.onlySelected) this.render();
    else this.syncSelection();
  }

  private syncSelection() {
    const selected = new Set(this.selection().map(file => file.path));
    for (const [path, { input, row }] of this.noteControls) {
      input.checked = selected.has(path);
      row.toggleClass('tag-match-row-selected', input.checked);
    }
    for (const { input, row, files } of this.folderControls.values()) {
      const count = files.filter(file => selected.has(file.path)).length;
      input.checked = count === files.length;
      input.indeterminate = count > 0 && count < files.length;
      row.toggleClass('tag-match-row-selected', count > 0);
    }
  }

  private render() {
    const scrollTop = this.container.scrollTop;
    this.container.empty(); this.noteControls.clear(); this.folderControls.clear();
    if (!this.root.files.length) {
      this.container.createEl('p', { cls: 'tag-match-list-note', text: 'No Markdown notes in this vault. Create a note, then reopen this command.' });
      return;
    }
    const selected = this.onlySelected ? new Set(this.selection().map(file => file.path)) : undefined;
    const root = filterNoteTree(this.root, this.query, selected);
    if (!root.files.length) {
      this.container.createEl('p', { cls: 'tag-match-list-note', text: this.onlySelected && !selected?.size
        ? 'No selected notes.' : 'No matching notes. Try another title or folder, or clear the search.' });
      return;
    }
    const list = this.container.createEl('ul', { cls: 'tag-match-tree-group' });
    this.renderFolder(list, root, 0);
    this.syncSelection();
    this.container.scrollTop = scrollTop;
  }

  private renderFolder(list: HTMLElement, folder: NoteFolder, depth: number) {
    const item = list.createEl('li');
    const row = item.createDiv('tag-match-row tag-match-tree-folder');
    row.style.setProperty('--tag-match-tree-depth', String(Math.max(0, Math.min(depth, 5))));
    const filtered = !!this.query || this.onlySelected;
    const name = folder.path === '/' ? this.onlySelected ? 'Selected notes' : this.query ? 'Search results' : folder.name : folder.name;
    const label = row.createEl('label', { cls: 'tag-match-tree-check' });
    const checkbox = label.createEl('input', { type: 'checkbox', attr: {
      'aria-label': `${folder.path === '/' ? name : folder.path}, ${folder.files.length.toLocaleString()} ${folder.files.length === 1 ? 'note' : 'notes'}`,
    } });
    checkbox.addEventListener('change', () => {
      this.select(folder.files, checkbox.checked);
      this.updateSelection();
      if (this.onlySelected && !checkbox.checked) this.folderControls.values().next().value?.button.focus();
    });
    const open = filtered ? !this.filteredCollapsed.has(folder.path) : this.expanded.has(folder.path);
    const groupId = `tag-match-note-group-${this.id}-${++this.groupId}`;
    const button = row.createEl('button', { cls: 'tag-match-tree-toggle', attr: {
      type: 'button', 'aria-expanded': String(open), 'aria-controls': groupId, title: folder.path === '/' ? name : folder.path,
    } });
    const icon = button.createSpan({ cls: 'tag-match-tree-icon', attr: { 'aria-hidden': 'true' } });
    setIcon(icon, open ? 'chevron-down' : 'chevron-right');
    button.createSpan({ cls: 'tag-match-tree-folder-name', text: name });
    button.createSpan({ cls: 'tag-match-row-uses', text: folder.files.length.toLocaleString(), attr: { 'aria-hidden': 'true' } });
    const toggle = (next: boolean) => {
      const state = filtered ? this.filteredCollapsed : this.expanded;
      if (filtered ? next : !next) state.delete(folder.path); else state.add(folder.path);
      this.render();
      this.folderControls.get(folder.path)?.button.focus();
    };
    button.addEventListener('click', () => toggle(!open));
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        toggle(event.key === 'ArrowRight');
      }
    });
    this.folderControls.set(folder.path, { input: checkbox, row, files: folder.files, button });
    const group = item.createEl('ul', { cls: 'tag-match-tree-group', attr: { id: groupId } });
    group.hidden = !open;
    if (!open) return;
    const children = sortedNoteChildren(folder, this.order);
    const limit = this.limits.get(folder.path) ?? PAGE_SIZE;
    for (const child of children.slice(0, limit)) {
      if (child.kind === 'folder') this.renderFolder(group, child, depth + 1);
      else this.renderNote(group, child.file, depth + 1);
    }
    if (children.length > limit) {
      const more = group.createEl('li');
      new ButtonComponent(more).setButtonText('Show more items').onClick(() => {
        this.limits.set(folder.path, limit + PAGE_SIZE);
        this.render();
        const next = children[limit]!;
        if (next.kind === 'folder') this.folderControls.get(next.path)?.button.focus();
        else this.noteControls.get(next.path)?.input.focus();
      });
    }
  }

  private renderNote(list: HTMLElement, file: TFile, depth: number) {
    const row = list.createEl('li').createEl('label', { cls: 'tag-match-row tag-match-bulk-file' });
    row.style.setProperty('--tag-match-tree-depth', String(Math.min(depth, 5)));
    const checkbox = row.createSpan({ cls: 'tag-match-tree-check' }).createEl('input', { type: 'checkbox' });
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : 'Vault root';
    checkbox.setAttribute('aria-label', `${file.basename} · ${folder}`);
    const icon = row.createSpan({ cls: 'tag-match-tree-icon tag-match-tree-file-icon', attr: { 'aria-hidden': 'true' } });
    setIcon(icon, 'file-text');
    const name = row.createSpan({ cls: 'tag-match-row-name', attr: { title: file.basename } });
    renderMiddleText(name, file.basename, 'tag-match-bulk-name-short').setAttribute('aria-hidden', 'true');
    // Focus reveals the full title for keyboard and touch users; hover retains the native title tooltip.
    name.createSpan({ cls: 'tag-match-bulk-name-full', text: file.basename });
    checkbox.addEventListener('change', () => {
      const paths = [...this.noteControls.keys()];
      const index = paths.indexOf(file.path);
      const nextPath = paths[index + 1] ?? paths[index - 1];
      this.select([file], checkbox.checked);
      // Keep the active row mounted in the full view; filtered removal moves focus to a remaining note.
      this.updateSelection();
      if (this.onlySelected && !checkbox.checked) {
        if (nextPath) this.noteControls.get(nextPath)?.input.focus();
        else this.folderControls.values().next().value?.button.focus();
      }
    });
    this.noteControls.set(file.path, { input: checkbox, row });
  }
}
