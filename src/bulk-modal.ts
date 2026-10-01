// Scopes bulk tagging and retains one run's progress and guarded undo while its plugin-owned window is hidden.
import { type App, ButtonComponent, Modal, Notice, SearchComponent, Setting, type TFile } from 'obsidian';
import type TagMatchPlugin from './main.ts';
import { type Config, normalizeConfig } from './config.ts';
import { parseDefinitions, parseOnlyTags } from './core.ts';
import { inventory } from './vault.ts';
import { resolveProvider } from './provider.ts';
import { hydrateCredentials } from './secret-storage.ts';
import { PAGE_SIZE } from './tag-list.ts';
import { createBulkItems, analyzeBulkItems, undoBulkItem, bulkReport, type BulkItem } from './bulk.ts';
import { renderSelectionControls, renderWholeNumber, wholeNumber } from './selection-controls.ts';
import { NoteTree } from './note-tree.ts';
import { renderMiddleText } from './middle-text.ts';

export function filesInScope(files: TFile[], paths: string[]): TFile[] {
  return files.filter(file => file.extension === 'md' && paths.some(path => path === '/'
    || file.path === path || file.path.startsWith(`${path}/`)));
}

export class BulkTagModal extends Modal {
  private readonly plugin: TagMatchPlugin;
  private readonly preset?: TFile[];
  private files: TFile[] = [];
  private items: BulkItem[] = [];
  private config!: Config;
  private controller = new AbortController();
  private reserved: { path: string; controller: AbortController }[] = [];
  private running = false;
  private undoing = false;
  private started = false;
  private resultsLimit = PAGE_SIZE;
  private closed = false;
  private scopeControls!: HTMLElement;
  private summary!: HTMLElement;
  private selectionCount!: HTMLElement;
  private selectionList!: HTMLElement;
  private selectionSearch!: SearchComponent;
  private searchArea!: HTMLElement;
  private clear!: ButtonComponent;
  private allFiles: TFile[] = [];
  private selectionSort!: HTMLSelectElement;
  private selectedView!: ButtonComponent;
  private noteTree!: NoteTree;
  private adjustments!: HTMLElement;
  private settingsSummary!: HTMLElement;
  private selectionValid: () => boolean = () => true;
  private maximumInput!: HTMLInputElement;
  private status!: HTMLElement;
  private progressArea!: HTMLElement;
  private activity!: HTMLElement;
  private activityProgress!: HTMLElement;
  private activityPath!: HTMLElement;
  private results!: HTMLElement;
  private start!: ButtonComponent;
  private stop!: ButtonComponent;
  private undo!: ButtonComponent;
  private copy!: ButtonComponent;
  private resultsFilter!: HTMLSelectElement;
  private background!: ButtonComponent;
  private readonly stateChanged: () => void;
  visible = false;

  constructor(app: App, plugin: TagMatchPlugin, files?: TFile[], stateChanged: () => void = () => {}) {
    super(app);
    this.plugin = plugin;
    this.preset = files;
    this.stateChanged = stateChanged;
  }

  get retained() { return this.started && !this.closed; }
  get disposed() { return this.closed; }
  get active() { return this.running; }
  get progressText() {
    if (!this.running) return 'Tag Match: Results';
    if (this.undoing) return 'Tag Match: Undoing';
    const complete = this.items.filter(item => !['pending', 'analyzing', 'ready'].includes(item.status)).length;
    return `Tag Match: ${complete}/${this.items.length}`;
  }

  onOpen() {
    this.visible = true;
    this.stateChanged();
    // Reopening uses the same controller, settings, outcomes, and recovery snapshots.
    if (this.retained) return;
    this.setTitle('Tag multiple notes');
    this.contentEl.addClass('tag-match-review');
    this.contentEl.addClass('tag-match-bulk');
    this.scopeControls = this.contentEl.createDiv('tag-match-bulk-scope');
    this.allFiles = [...this.app.vault.getMarkdownFiles()];
    if (this.preset) {
      this.files = createBulkItems(this.preset).map(item => item.file);
    }
    this.searchArea = this.scopeControls.createDiv('tag-match-bulk-search');
    const searchLabel = this.searchArea.createEl('label', { cls: 'tag-match-bulk-search-label' });
    searchLabel.createSpan({ text: 'Search notes' });
    this.selectionSearch = new SearchComponent(searchLabel).setPlaceholder('Note title or folder')
      .onChange(value => this.noteTree.setQuery(value));
    this.selectionSearch.inputEl.setAttribute('aria-label', 'Search notes by title or folder');
    const notesArea = this.scopeControls.createDiv('tag-match-bulk-notes');
    const toolbar = notesArea.createDiv('tag-match-bulk-list-toolbar');
    const sortLabel = toolbar.createEl('label', { cls: 'tag-match-bulk-sort-label', text: 'Sort by' });
    this.selectionSort = sortLabel.createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'Sort by' } });
    for (const [value, text] of Object.entries({ 'modified-desc': 'Modified: newest first', 'modified-asc': 'Modified: oldest first',
      'created-desc': 'Created: newest first', 'created-asc': 'Created: oldest first', 'name-asc': 'Name: A–Z', 'name-desc': 'Name: Z–A' })) {
      this.selectionSort.createEl('option', { value, text });
    }
    this.selectionSort.value = 'modified-desc';
    this.selectionSort.addEventListener('change', () => this.noteTree.setSort(this.selectionSort.value));
    this.selectedView = new ButtonComponent(toolbar).onClick(() => {
      this.noteTree.setSelectedOnly(!this.noteTree.selectedOnly);
      this.refreshSelectionSummary();
      this.selectedView.buttonEl.focus();
    });
    this.selectedView.buttonEl.addClass('tag-match-bulk-view-button');
    this.selectionList = notesArea.createDiv('tag-match-list tag-match-bulk-selection');
    const selectionBar = notesArea.createDiv('tag-match-bulk-selection-bar');
    this.selectionCount = selectionBar.createEl('p', { cls: 'tag-match-bulk-count', attr: { role: 'status', 'aria-live': 'polite' } });
    this.clear = new ButtonComponent(selectionBar).setButtonText('Clear selection').onClick(() => {
      this.files = [];
      this.showScope();
    });
    this.noteTree = new NoteTree(this.selectionList, this.allFiles, () => this.files, (files, checked) => {
      const paths = new Set(files.map(file => file.path));
      this.files = checked ? [...new Map([...this.files, ...files].map(file => [file.path, file])).values()]
        : this.files.filter(file => !paths.has(file.path));
      this.refreshSelectionSummary();
    }, !!this.preset?.length);
    this.config = { ...this.plugin.settings };
    this.settingsSummary = this.contentEl.createEl('p', { cls: 'tag-match-detail tag-match-bulk-summary' });
    this.summary = this.contentEl.createEl('details', { cls: 'tag-match-disclosure tag-match-bulk-settings' });
    this.summary.createEl('summary', { text: 'Adjust for this batch' });
    this.adjustments = this.summary.createDiv('tag-match-adjustments');
    this.renderAdjustments();
    this.progressArea = this.contentEl.createDiv('tag-match-bulk-progress');
    this.progressArea.hidden = true;
    this.status = this.progressArea.createEl('p', { cls: 'tag-match-status', attr: { role: 'status', 'aria-live': 'polite' } });
    this.activity = this.progressArea.createDiv('tag-match-bulk-activity');
    this.activity.hidden = true;
    this.activityProgress = this.activity.createSpan('tag-match-bulk-scoring');
    this.activityPath = this.activity.createSpan('tag-match-bulk-activity-path');
    const filterLabel = this.contentEl.createEl('label', { cls: 'tag-match-bulk-result-filter', text: 'Results' });
    this.resultsFilter = filterLabel.createEl('select', { cls: 'dropdown', attr: { 'aria-label': 'Results to show' } });
    for (const [value, text] of Object.entries({ all: 'All notes', changed: 'Changed notes', problems: 'Failed or skipped', cancelled: 'Not processed' })) {
      this.resultsFilter.createEl('option', { value, text });
    }
    this.resultsFilter.addEventListener('change', () => { this.resultsLimit = PAGE_SIZE; this.renderResults(); });
    filterLabel.hidden = true;
    this.results = this.contentEl.createDiv('tag-match-list tag-match-bulk-results');
    this.results.hidden = true;
    const footer = this.contentEl.createDiv('tag-match-footer');
    this.stop = new ButtonComponent(footer).setButtonText('Close').onClick(() => {
      if (this.running) this.requestStop();
      else this.close();
    });
    this.copy = new ButtonComponent(footer).setButtonText('Copy results').onClick(async () => {
      try { await activeWindow.navigator.clipboard.writeText(bulkReport(this.items, this.config)); new Notice('Results copied.'); }
      catch { new Notice('Could not copy results. Keep this window open and try again.'); }
    });
    this.copy.buttonEl.hidden = true;
    this.background = new ButtonComponent(footer).setButtonText('Run in background').onClick(() => this.close());
    this.background.buttonEl.hidden = true;
    this.undo = new ButtonComponent(footer).setButtonText('Undo additions').onClick(() => this.undoAdditions());
    this.undo.buttonEl.hidden = true;
    this.start = new ButtonComponent(footer).setButtonText('Add recommended tags').setCta().onClick(() => this.run());
    this.showScope();
    this.selectionSearch.inputEl.focus();
  }

  private renderAdjustments() {
    this.adjustments.empty();
    const update = (patch: Partial<Config>, rebuild = false) => {
      this.config = normalizeConfig({ ...this.config, ...patch });
      if (rebuild) this.renderAdjustments();
      this.refreshSettingsSummary();
      this.updateStartButton();
    };
    this.selectionValid = renderSelectionControls(this.adjustments, this.config, this.plugin.settings.poolMode === 'minimum', update);
    new Setting(this.adjustments).setName('Minimum match score').addSlider(slider => {
      slider.sliderEl.setAttribute('aria-label', 'Minimum match score');
      slider.setLimits(0, 100, 1).setValue(Math.round(this.config.minProbability * 100))
        .setDisplayFormat(value => `${value}%`).onChange(value => update({ minProbability: value / 100 }));
    });
    this.maximumInput = renderWholeNumber(this.adjustments, this.config.maxTagsToAdd, 'Maximum tags per note', 1000,
      value => update(value === undefined ? {} : { maxTagsToAdd: value }));
    this.refreshSettingsSummary();
  }

  private refreshSettingsSummary() {
    this.settingsSummary.setText(`${this.config.poolMode === 'specific' ? 'Only these tags · ' : ''}Minimum match score: ${Math.round(this.config.minProbability * 100)}% · Up to ${this.config.maxTagsToAdd} tags per note`);
  }

  private showScope() {
    this.noteTree.updateSelection();
    this.refreshSelectionSummary();
  }

  private refreshSelectionSummary() {
    const count = this.files.length;
    this.selectionCount.setText(`${count.toLocaleString()} ${count === 1 ? 'note' : 'notes'} selected`);
    this.clear.buttonEl.hidden = !count;
    this.selectedView.setButtonText(this.noteTree.selectedOnly ? 'Show all notes' : 'Show selected')
      .setDisabled(!count && !this.noteTree.selectedOnly);
    if (!count && this.noteTree.selectedOnly) this.selectedView.buttonEl.focus();
    this.updateStartButton();
  }

  private validSettings() { return this.selectionValid() && wholeNumber(this.maximumInput.value, 1000); }

  private updateStartButton() {
    const count = this.files.length;
    this.start.setDisabled(!count || !this.validSettings()).setButtonText(count
      ? `Add tags to ${count.toLocaleString()} ${count === 1 ? 'note' : 'notes'}` : 'Add recommended tags');
  }

  // Closing can occur while async work is awaiting a provider or vault operation.
  private isClosed() { return this.closed; }

  private requestStop() {
    this.controller.abort();
    this.stop.setDisabled(true);
    this.setStatus(this.undoing ? 'Stopping undo…' : 'Stopping… Completed additions are kept; no further notes will be tagged.');
  }

  private setStatus(text: string) {
    this.progressArea.hidden = false;
    if (this.status.textContent === text) return;
    this.status.setText(text); this.stateChanged();
  }

  private setActivity(path: string, scoring = '') {
    this.activityProgress.setText(scoring);
    this.activityProgress.hidden = !scoring;
    this.activityPath.empty();
    renderMiddleText(this.activityPath, path);
  }

  private async run() {
    if (this.isClosed() || this.running || this.started || !this.files.length || !this.validSettings()) return;
    let tags: ReturnType<typeof inventory>;
    try {
      this.config = hydrateCredentials(this.config, this.app.secretStorage);
      if (!resolveProvider(this.config).apiKey.trim()) throw new Error('Add an API key in Tag Match settings, then try this batch again.');
      parseDefinitions(this.config.definitions);
      if (this.config.poolMode === 'specific' && !parseOnlyTags(this.config.onlyTags).length) {
        throw new Error('Enter at least one tag in “Tags”.');
      }
      tags = inventory(this.app);
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : 'Could not prepare the batch. Check Tag Match settings and try again.');
      return;
    }
    this.running = this.started = true;
    this.items = createBulkItems(this.files);
    for (const item of this.items) {
      if (this.plugin.beginRun(item.file.path, this.controller)) this.reserved.push({ path: item.file.path, controller: this.controller });
      else { item.status = 'skipped'; item.message = 'This note is already being analyzed.'; }
    }
    this.scopeControls.hidden = true;
    this.contentEl.addClass('tag-match-bulk-results-view');
    this.summary.hidden = true;
    this.settingsSummary.hidden = true;
    this.start.buttonEl.hidden = true;
    this.stop.setButtonText('Stop');
    this.background.buttonEl.hidden = false;
    this.results.hidden = false;
    this.resultsFilter.parentElement!.hidden = false;
    this.resultsFilter.disabled = true;
    this.activity.hidden = false;
    this.setStatus(`Preparing ${this.items.length} notes…`);
    this.renderResults();
    let completed = this.items.filter(item => item.status === 'skipped').length;
    const skipped = completed;
    try {
      await analyzeBulkItems(this.app, this.items, this.config, tags, this.plugin.transport, this.controller.signal, true,
        (item, complete) => {
          if (this.closed) return;
          completed = complete + skipped;
          this.setStatus(`${completed} of ${this.items.length} notes processed`);
          this.setActivity(item.file.path);
          this.updateRow(item);
        }, (file, progress) => {
          if (!this.closed) {
            this.setStatus(`${completed} of ${this.items.length} notes processed`);
            this.setActivity(file.path, `Scoring ${progress.complete} of ${progress.total} tags`);
            const item = this.items.find(item => item.file === file);
            if (item) this.updateRow(item);
          }
        }, 3);
    } catch (error) {
      if (!this.closed) this.setStatus(error instanceof Error ? error.message : 'Could not tag these notes.');
    } finally {
      this.running = false;
      if (!this.closed) {
        this.renderResults();
        this.showOutcome();
        this.stop.setButtonText('Close').setDisabled(false);
        this.background.buttonEl.hidden = true;
        this.resultsFilter.disabled = false;
        this.copy.buttonEl.hidden = false;
        this.undo.buttonEl.hidden = !this.items.some(item => item.status === 'applied');
      }
    }
  }

  private readonly rows = new Map<BulkItem, HTMLElement>();

  private renderResults() {
    this.results.empty();
    this.rows.clear();
    const filtered = this.items.filter(item => this.resultsFilter.value === 'changed' ? item.status === 'applied'
      : this.resultsFilter.value === 'problems' ? ['failed', 'skipped'].includes(item.status) || !!item.message
        : this.resultsFilter.value === 'cancelled' ? item.status === 'cancelled' : true);
    if (!filtered.length) this.results.createEl('p', { cls: 'tag-match-list-note', text: 'No notes in this group. Choose another results filter.' });
    for (const item of filtered.slice(0, this.resultsLimit)) {
      const row = this.results.createDiv('tag-match-bulk-note');
      this.rows.set(item, row);
      this.updateRow(item);
    }
    if (this.resultsLimit < filtered.length) {
      const remaining = Math.min(PAGE_SIZE, filtered.length - this.resultsLimit);
      new ButtonComponent(this.results).setButtonText(`Show ${remaining} more ${remaining === 1 ? 'result' : 'results'}`)
        .onClick(() => { this.resultsLimit += PAGE_SIZE; this.renderResults(); });
    }
  }

  private updateRow(item: BulkItem) {
    const row = this.rows.get(item);
    if (!row) return;
    row.empty();
    renderMiddleText(row.createEl('p', { cls: 'tag-match-bulk-path' }), item.file.path);
    const labels = { pending: 'Waiting', analyzing: 'Analyzing', ready: 'Ready', unchanged: 'No additions', applied: 'Added', failed: 'Failed', skipped: 'Skipped', cancelled: 'Not processed', undone: 'Undone' };
    row.createEl('p', { cls: 'tag-match-detail', text: item.status === 'applied'
      ? `Added ${[...item.selected].map(tag => `#${tag}`).join(', ')}${item.message ? `. ${item.message}` : ''}` : `${labels[item.status]}${item.message ? `: ${item.message}` : ''}` });
  }

  private showOutcome() {
    this.activity.hidden = true;
    const count = (status: BulkItem['status']) => this.items.filter(item => item.status === status).length;
    const failure = this.items.find(item => item.status === 'failed' || (item.status === 'applied' && item.message));
    this.setStatus(`${count('applied')} changed, ${count('unchanged')} unchanged, ${count('skipped')} skipped, ${count('failed')} failed, ${count('cancelled')} not processed${count('undone') ? `, ${count('undone')} undone` : ''}.${failure?.message ? ` ${failure.message} Check failed or skipped results for details.` : ''}`);
  }

  private async undoAdditions() {
    if (this.running) return;
    this.running = this.undoing = true;
    this.controller = new AbortController();
    this.undo.setDisabled(true);
    this.copy.setDisabled(true);
    this.resultsFilter.disabled = true;
    this.activity.hidden = false;
    this.background.buttonEl.hidden = false;
    this.stop.setButtonText('Stop undo');
    let completed = 0;
    try {
      for (const item of this.items) {
        if (this.closed || this.controller.signal.aborted) break;
        if (item.status === 'applied') {
          await undoBulkItem(this.app, item, this.controller.signal);
          this.setStatus(`Undoing additions: ${++completed} notes processed`);
          this.setActivity(item.file.path);
          this.updateRow(item);
        }
      }
    } finally {
      this.running = this.undoing = false;
      if (!this.closed) {
        this.renderResults();
        this.showOutcome();
        this.undo.buttonEl.hidden = !this.items.some(item => item.status === 'applied');
        this.undo.setDisabled(false);
        this.copy.setDisabled(false);
        this.resultsFilter.disabled = false;
        this.stop.setButtonText('Close').setDisabled(false);
        this.background.buttonEl.hidden = true;
      }
    }
  }

  /** Plugin unload cannot keep a modal open; cancel work before releasing its resources. */
  dispose() { this.release(); super.close(); }

  onClose() {
    this.visible = false;
    // The plugin retains active work when its view closes. Closing results releases the run.
    if (this.running && !this.closed) { this.stateChanged(); return; }
    this.release();
  }

  private release() {
    this.closed = true;
    this.visible = false;
    this.controller.abort();
    for (const { path, controller } of this.reserved) this.plugin.endRun(path, controller);
    this.reserved = [];
    this.items = [];
    this.rows.clear();
    this.files = [];
    this.allFiles = [];
    this.contentEl.empty();
    this.stateChanged();
  }
}
