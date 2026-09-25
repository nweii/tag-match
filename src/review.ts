// Presents candidate coverage and selectable results before any note changes occur.
import { type App, Modal, Notice, Setting, type TFile } from 'obsidian';
import type TagMatchPlugin from './main.ts';
import { type Config } from './config.ts';
import { type CandidateInspection, type Note, selectCandidates, buildBatches, noteSeed } from './core.ts';
import { suggest, type SuggestionResult } from './client.ts';
import { inventory, applySuggestions } from './vault.ts';
import { resolveProvider } from './provider.ts';

export class ReviewModal extends Modal {
  private controller = new AbortController();
  private result: SuggestionResult | null = null;
  private selected = new Set<string>();
  private query = '';
  private rows!: HTMLElement;
  private status!: HTMLElement;
  private selectionCount: HTMLElement | null = null;
  private config: Config;
  private running = false;
  private applying = false;

  constructor(app: App, private plugin: TagMatchPlugin, private file: TFile,
    private note: Note, private snapshot: string) {
    super(app);
    this.config = { ...plugin.settings };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('tag-match-review');
    contentEl.createEl('h2', { text: `Tag matches for ${this.note.title}` });
    const provider = resolveProvider(this.config);
    contentEl.createEl('p', { cls: 'setting-item-description', text: provider.attribution });
    const tags = inventory(this.app);
    const pool = selectCandidates(tags, this.note.existingTags, this.config, noteSeed(this.note));
    let prepared: ReturnType<typeof buildBatches>;
    try { prepared = buildBatches(this.note, pool, this.config); }
    catch (error) {
      contentEl.createEl('p', { attr: { role: 'alert' }, text: error instanceof Error ? error.message : 'Could not prepare this note for analysis.' });
      new Setting(contentEl).addButton(button => button.setButtonText('Close').onClick(() => this.close()));
      return;
    }
    const mix = ['auto', 'percent', 'count'].includes(this.config.poolMode)
      ? ` · ${pool.frequent.toLocaleString()} most-used · ${pool.discovery.toLocaleString()} sampled from the rest`
      : '';
    contentEl.createEl('p', { text: `${pool.tags.length.toLocaleString()} of ${pool.eligible.toLocaleString()} eligible tags${mix} · ${pool.excluded} excluded · ${pool.existing} already present` });
    contentEl.createEl('p', { cls: 'setting-item-description', text:
      `Sends the title, description, existing tags, ${prepared.sentChars.toLocaleString()} body characters, guidance, and definitions to ${provider.label} in ${prepared.batches.length} batches. ${prepared.truncated ? 'Uses excerpts from the beginning, middle, and end.' : 'Includes the full note body.'}` });
    this.status = contentEl.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    new Setting(contentEl).setName('Analyze this note').setDesc(`Preselects up to ${this.config.maxTagsToAdd} matches scoring at least ${(this.config.minProbability * 100).toFixed(0)}%. Review all scores before adding tags.`)
      .addButton(button => button.setButtonText('Analyze note').setCta().setDisabled(!pool.tags.length).onClick(async () => {
        if (this.running || this.result) return;
        if (!this.plugin.beginRun(this.file.path, this.controller)) {
          new Notice('Tag Match is already analyzing this note.'); return;
        }
        this.running = true;
        button.setDisabled(true);
        try {
          this.config = this.plugin.credentialSnapshot();
          this.result = await suggest(this.note, tags, this.config, this.plugin.transport,
            this.controller.signal, progress => { this.status.setText(`Evaluated ${progress.complete} of ${progress.total} tags…`); });
          this.selected = new Set(this.result.recommended.map(item => item.tag));
          this.status.setText(`Evaluated ${this.result.judgments.length} tags. ${this.result.recommended.length} recommended. ${this.result.truncated ? 'Note text was sampled.' : ''}`);
          this.renderResults();
        } catch (error) {
          if (!this.controller.signal.aborted) {
            this.status.setText(error instanceof Error ? error.message : 'Analysis failed. No tags were applied.');
            button.setDisabled(false);
          }
        } finally { this.running = false; this.plugin.endRun(this.file.path, this.controller); }
      }));
    new Setting(contentEl).setName('Find a tag').addSearch(search => search.setPlaceholder('Search tags or results')
      .onChange(value => { this.query = value.toLowerCase(); this.renderResults(); }));
    this.rows = contentEl.createDiv('tag-match-list');
    this.renderResults();
    new Setting(contentEl)
      .addButton(button => button.setButtonText('Close').onClick(() => this.close()))
      .addButton(button => button.setButtonText('Add selected tags').setCta().onClick(async () => {
        if (this.applying || !this.result || !this.selected.size) return;
        this.applying = true;
        button.setDisabled(true);
        try {
          await applySuggestions(this.app, this.file, this.snapshot, [...this.selected], this.note.existingTags, this.plugin.settings);
          new Notice(`Added ${this.selected.size} tags to ${this.file.basename}.`);
          this.close();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : 'Could not apply tags.');
          button.setDisabled(false);
        } finally { this.applying = false; }
      }));
  }

  private renderResults() {
    this.rows.empty();
    if (!this.result) {
      const pool = selectCandidates(inventory(this.app), this.note.existingTags, this.config, noteSeed(this.note));
      const matching = pool.inspected.filter(item => item.tag.toLowerCase().includes(this.query));
      for (const item of matching.slice(0, 100)) {
        this.rows.createDiv({ cls: 'tag-match-candidate', text: `#${item.tag} · ${item.count} uses · ${inspectionLabel(item)}` });
      }
      if (matching.length > 100) this.rows.createEl('p', { text: `Showing 100 of ${matching.length}. Search to find more.` });
      if (!matching.length) this.rows.createEl('p', { text: 'No matching tags.' });
      return;
    }
    this.selectionCount = this.rows.createEl('p', { text: `${this.selected.size} of ${this.config.maxTagsToAdd} selected` });
    const judgments = new Map(this.result.judgments.map(item => [item.tag, item.probability]));
    const rank = new Map(this.result.judgments.map((item, index) => [item.tag, index]));
    const matching = this.result.pool.inspected.filter(item => item.tag.toLowerCase().includes(this.query))
      .sort((a, b) => (rank.get(a.tag) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.tag) ?? Number.MAX_SAFE_INTEGER)
        || b.count - a.count || a.tag.localeCompare(b.tag));
    for (const item of matching.slice(0, 100)) {
      const probability = judgments.get(item.tag);
      if (probability === undefined) {
        this.rows.createDiv({ cls: 'tag-match-candidate', text: `#${item.tag} · ${item.count} uses · ${inspectionLabel(item)}` });
        continue;
      }
      const label = this.rows.createEl('label', { cls: 'tag-match-result' });
      const checkbox = label.createEl('input', { type: 'checkbox' });
      checkbox.checked = this.selected.has(item.tag);
      const copy = label.createDiv({ cls: 'tag-match-result-copy' });
      copy.createDiv({ cls: 'tag-match-result-name', text: `#${item.tag}` });
      copy.createDiv({ cls: 'setting-item-description', text: `${(probability * 100).toFixed(1)}% match${probability < this.config.minProbability ? ' · below threshold' : ''} · ${inspectionLabel(item)}` });
      checkbox.addEventListener('change', () => {
        if (checkbox.checked && this.selected.size >= this.config.maxTagsToAdd) {
          checkbox.checked = false; new Notice(`Select at most ${this.config.maxTagsToAdd} tags.`); return;
        }
        if (checkbox.checked) this.selected.add(item.tag); else this.selected.delete(item.tag);
        this.selectionCount?.setText(`${this.selected.size} of ${this.config.maxTagsToAdd} selected`);
      });
    }
    if (matching.length > 100) this.rows.createEl('p', { text: `Showing 100 of ${matching.length}. Search to find more.` });
    if (!matching.length) this.rows.createEl('p', { text: 'No matching results.' });
  }

  onClose() {
    this.controller.abort();
    this.plugin.endRun(this.file.path, this.controller);
    this.contentEl.empty();
  }
}

function inspectionLabel(item: CandidateInspection): string {
  if (item.status === 'excluded') return 'excluded';
  if (item.status === 'already-present') return 'already on note';
  if (item.status === 'outside-pool') return 'not evaluated · outside this selection';
  if (item.reason === 'discovery') return 'selected by sampling';
  if (item.reason === 'frequent') return 'selected by usage';
  if (item.reason === 'minimum') return 'meets minimum uses';
  return 'all eligible tags';
}
