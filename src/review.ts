// Presents candidate coverage and selectable results before any note changes occur.
import { type App, ButtonComponent, Modal, Notice, SearchComponent, type TFile } from 'obsidian';
import type TagMatchPlugin from './main.ts';
import { type Config } from './config.ts';
import { type CandidateInspection, type CandidatePool, type Note, type TagCount, selectCandidates, buildBatches, noteSeed, rankJudgments, recommendations, tagKey } from './core.ts';
import { suggest, type SuggestionResult } from './client.ts';
import { inventory, applySuggestions } from './vault.ts';
import { resolveProvider } from './provider.ts';
import { hydrateCredentials } from './secret-storage.ts';

const VISIBLE_ROWS = 100;

export class ReviewModal extends Modal {
  private controller = new AbortController();
  private result: SuggestionResult | null = null;
  private selected = new Set<string>();
  private query = '';
  private rows!: HTMLElement;
  private status!: HTMLElement;
  private addButton!: ButtonComponent;
  private resultsSearch?: HTMLInputElement;
  private nextPool: CandidatePool | null = null;
  private sampleSize = 0;
  private sampleButton!: ButtonComponent;
  private plugin: TagMatchPlugin;
  private file: TFile;
  private note: Note;
  private snapshot: string;
  private readonly config: Config;
  private readonly tags: TagCount[];
  private running = false;
  private applying = false;

  constructor(app: App, plugin: TagMatchPlugin, file: TFile, note: Note, snapshot: string) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.note = note;
    this.snapshot = snapshot;
    this.config = { ...plugin.settings };
    this.tags = inventory(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.setTitle('Review tags');
    contentEl.addClass('tag-match-review');
    contentEl.createEl('p', { cls: 'tag-match-note-title', text: this.note.title });
    const provider = resolveProvider(this.config);
    const pool = selectCandidates(this.tags, this.note.existingTags, this.config, noteSeed(this.note));
    let prepared: ReturnType<typeof buildBatches>;
    try { prepared = buildBatches(this.note, pool, this.config); }
    catch (error) {
      contentEl.createEl('p', { cls: 'tag-match-status', attr: { role: 'alert' }, text: error instanceof Error ? error.message : 'Could not prepare this note for analysis.' });
      new ButtonComponent(contentEl.createDiv('tag-match-footer')).setButtonText('Close').onClick(() => this.close());
      return;
    }
    // Later samples match the first sample's random share, or the whole pool when it had none.
    this.sampleSize = pool.discovery || pool.tags.length;

    const overview = contentEl.createEl('dl', { cls: 'tag-match-overview' });
    const fact = (term: string, value: string, detail = '') => {
      overview.createEl('dt', { text: term });
      const description = overview.createEl('dd', { text: value });
      if (detail) description.createSpan({ cls: 'tag-match-detail', text: ` · ${detail}` });
    };
    const mixed = ['auto', 'percent', 'count'].includes(this.config.poolMode);
    fact('Tags', `${pool.tags.length.toLocaleString()} of ${pool.eligible.toLocaleString()}`,
      mixed ? `${pool.frequent.toLocaleString()} most-used, ${pool.discovery.toLocaleString()} sampled` : '');
    const skipped = [pool.existing ? `${pool.existing.toLocaleString()} already on this note` : '',
      pool.excluded ? `${pool.excluded.toLocaleString()} excluded` : ''].filter(Boolean);
    if (skipped.length) fact('Skipped', skipped.join(', '));
    fact('Preselects', `Up to ${tagCount(this.config.maxTagsToAdd)} scoring ${percent(this.config.minProbability)} or higher`);
    fact('Sends', `Title, description, tags, guidance, and ${prepared.truncated ? 'excerpts of the body' : 'the full body'}`,
      `${prepared.sentChars.toLocaleString()} characters`);
    fact('Model', `${provider.model} via ${provider.label}`, `${prepared.batches.length} ${prepared.batches.length === 1 ? 'request' : 'requests'}`);

    const candidateDetails = contentEl.createEl('details', { cls: 'tag-match-candidates' });
    const summary = candidateDetails.createEl('summary', { text: 'Browse all vault tags' });
    summary.createSpan({ cls: 'tag-match-detail', text: ` ${pool.inspected.length.toLocaleString()}` });
    const candidateSearch = new SearchComponent(candidateDetails).setPlaceholder('Search vault tags')
      .onChange(value => { this.query = value.toLowerCase(); this.renderCandidates(pool, candidateRows); });
    candidateSearch.inputEl.setAttribute('aria-label', 'Search vault tags');
    const candidateRows = candidateDetails.createDiv('tag-match-list');
    this.renderCandidates(pool, candidateRows);

    this.status = contentEl.createEl('p', { cls: 'tag-match-status', attr: { role: 'status', 'aria-live': 'polite' } });
    if (!pool.tags.length) this.status.setText(pool.total === 0
      ? 'No vault tags yet. Add a tag to a note, then try again.'
      : pool.eligible === 0 ? 'Every vault tag is excluded or already on this note.'
        : 'No tags meet the current selection. Change Tags to consider in settings.');

    const resultsArea = contentEl.createDiv('tag-match-results-area');
    resultsArea.hidden = true;
    const resultsSearch = new SearchComponent(resultsArea).setPlaceholder('Search all tags')
      .onChange(value => { this.query = value.toLowerCase(); this.renderResults(); });
    resultsSearch.inputEl.setAttribute('aria-label', 'Search all tags, including unscored ones');
    this.resultsSearch = resultsSearch.inputEl;
    this.rows = resultsArea.createDiv('tag-match-list');
    this.sampleButton = new ButtonComponent(resultsArea.createDiv('tag-match-more'))
      .onClick(() => this.analyzeAnotherSample());

    const footer = contentEl.createDiv('tag-match-footer');
    new ButtonComponent(footer).setButtonText('Close').onClick(() => this.close());
    const analyzeButton = new ButtonComponent(footer).setButtonText('Analyze note').setCta().setDisabled(!pool.tags.length);
    this.addButton = new ButtonComponent(footer).setButtonText('Add tags').setCta().setDisabled(true)
      .onClick(() => this.addSelected());
    this.addButton.buttonEl.hidden = true;
    analyzeButton.onClick(async () => {
      if (this.running) return;
      if (!this.plugin.beginRun(this.file.path, this.controller)) {
        new Notice('Tag Match is already analyzing this note.'); return;
      }
      this.running = true;
      analyzeButton.setDisabled(true);
      candidateDetails.open = false;
      this.status.setText(`Scoring ${tagCount(pool.tags.length)}…`);
      try {
        const config = hydrateCredentials(this.config, this.app.secretStorage);
        this.result = await suggest(this.note, this.tags, config, this.plugin.transport,
          this.controller.signal, progress => { this.status.setText(`Scored ${progress.complete.toLocaleString()} of ${tagCount(progress.total)}…`); }, pool);
        this.selected = new Set(this.result.recommended.map(item => item.tag));
        this.query = '';
        const recommended = this.result.recommended.length;
        const minimum = percent(this.config.minProbability);
        this.status.setText(`Scored ${tagCount(this.result.judgments.length)}. ${recommended
          ? `${recommended.toLocaleString()} reached ${minimum} and ${recommended === 1 ? 'is' : 'are'} preselected.`
          : `None reached ${minimum}; the closest matches are listed first.`}${this.result.truncated ? ' Used excerpts of the note.' : ''}`);
        overview.hidden = true;
        candidateDetails.hidden = true;
        analyzeButton.buttonEl.hidden = true;
        this.addButton.buttonEl.hidden = false;
        resultsArea.hidden = false;
        this.renderResults();
        this.prepareNextSample();
        this.resultsSearch?.focus();
      } catch (error) {
        if (!this.controller.signal.aborted) {
          this.status.setText(`${error instanceof Error ? error.message : 'Analysis failed.'} No tags were applied. Try again.`);
          analyzeButton.setDisabled(false);
        }
      } finally { this.running = false; this.plugin.endRun(this.file.path, this.controller); }
    });
  }

  private async analyzeAnotherSample() {
    const next = this.nextPool;
    if (!next || this.running || this.applying) return;
    if (!this.plugin.beginRun(this.file.path, this.controller)) {
      new Notice('Tag Match is already analyzing this note.'); return;
    }
    this.running = true;
    this.sampleButton.setDisabled(true);
    this.updateSelection();
    this.status.setText(`Scoring ${moreTags(next.tags.length)}…`);
    try {
      const config = hydrateCredentials(this.config, this.app.secretStorage);
      const further = await suggest(this.note, this.tags, config, this.plugin.transport,
        this.controller.signal, progress => { this.status.setText(`Scored ${progress.complete.toLocaleString()} of ${progress.total.toLocaleString()} more tags…`); }, next);
      const previous = this.result!;
      const judgments = rankJudgments([...previous.judgments, ...further.judgments]);
      const included = new Map(next.tags.map(item => [tagKey(item.tag), item.reason]));
      const inspected = previous.pool.inspected.map(item => {
        const reason = included.get(tagKey(item.tag));
        return reason ? { ...item, status: 'included' as const, reason } : item;
      });
      this.result = { ...previous, pool: { ...previous.pool, inspected }, judgments,
        recommended: recommendations(judgments, this.config),
        batches: previous.batches + further.batches,
        usage: { inputTokens: previous.usage.inputTokens + further.usage.inputTokens,
          outputTokens: previous.usage.outputTokens + further.usage.outputTokens,
          complete: previous.usage.complete && further.usage.complete },
        models: [...new Set([...previous.models, ...further.models])] };
      this.status.setText(`Scored ${moreTags(further.judgments.length)} (${judgments.length.toLocaleString()} total). Your selections were kept.`);
      this.renderResults();
      this.prepareNextSample();
    } catch (error) {
      if (!this.controller.signal.aborted) this.status.setText(`${error instanceof Error ? error.message : 'Analysis failed.'} Your results and selections were kept. Try again.`);
    } finally {
      this.running = false;
      this.plugin.endRun(this.file.path, this.controller);
      this.sampleButton.setDisabled(!this.nextPool);
      this.updateSelection();
    }
  }

  private async addSelected() {
    if (this.running || this.applying || !this.result || !this.selected.size) return;
    this.applying = true;
    this.addButton.setDisabled(true);
    try {
      await applySuggestions(this.app, this.file, this.snapshot, [...this.selected], this.note.existingTags, this.plugin.settings);
      new Notice(`Added ${tagCount(this.selected.size)} to ${this.file.basename}.`);
      this.close();
    } catch (error) {
      new Notice(error instanceof Error ? error.message : 'Could not apply tags.');
      this.addButton.setDisabled(!this.selected.size);
    } finally { this.applying = false; }
  }

  private renderCandidates(pool: CandidatePool, rows: HTMLElement) {
    rows.empty();
    const matching = pool.inspected.filter(item => item.tag.toLowerCase().includes(this.query));
    for (const item of matching.slice(0, VISIBLE_ROWS)) {
      const row = rows.createDiv({ cls: item.status === 'included' ? 'tag-match-row' : 'tag-match-row tag-match-row-unavailable' });
      const name = row.createSpan({ cls: 'tag-match-row-name', text: `#${item.tag}` });
      name.createSpan({ cls: 'tag-match-row-uses', text: ` ${useCount(item.count)}` });
      row.createSpan({ cls: 'tag-match-row-meta', text: inspectionLabel(item, false) });
    }
    listFooter(rows, matching.length);
  }

  private renderResults() {
    if (!this.result) return;
    this.rows.empty();
    this.updateSelection();
    const scores = new Map(this.result.judgments.map(item => [item.tag, item.probability]));
    const rank = new Map(this.result.judgments.map((item, index) => [item.tag, index]));
    // Without a query the list shows scores; a query also reaches unscored, excluded, and existing tags.
    const matching = this.result.pool.inspected
      .filter(item => this.query ? item.tag.toLowerCase().includes(this.query) : scores.has(item.tag))
      .sort((a, b) => (rank.get(a.tag) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.tag) ?? Number.MAX_SAFE_INTEGER)
        || b.count - a.count || a.tag.localeCompare(b.tag));
    // Checked tags stay reachable even when they rank past the display limit.
    const visible = matching.filter((item, index) => index < VISIBLE_ROWS || this.selected.has(item.tag));
    const threshold = this.config.minProbability;
    const meets = (tag: string) => (scores.get(tag) ?? -1) >= threshold;
    let divided = !visible.some(item => meets(item.tag));
    for (const item of visible) {
      const probability = scores.get(item.tag);
      if (!divided && !meets(item.tag)) {
        this.rows.createDiv({ cls: 'tag-match-divider', text: `Below ${percent(threshold)}` });
        divided = true;
      }
      // Unscored tags keep the checkbox column so names align; the disabled box shows they cannot be added here.
      const label = this.rows.createEl('label', { cls: probability === undefined ? 'tag-match-row tag-match-row-unavailable'
        : meets(item.tag) ? 'tag-match-row tag-match-row-meets' : 'tag-match-row' });
      const checkbox = label.createEl('input', { type: 'checkbox' });
      label.createSpan({ cls: 'tag-match-row-name', text: `#${item.tag}` });
      if (probability === undefined) {
        checkbox.disabled = true;
        checkbox.checked = item.status === 'already-present';
        label.createSpan({ cls: 'tag-match-row-meta', text: inspectionLabel(item, true) });
        continue;
      }
      checkbox.checked = this.selected.has(item.tag);
      label.createSpan({ cls: 'tag-match-row-meta', text: percent(probability) });
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selected.add(item.tag); else this.selected.delete(item.tag);
        this.updateSelection();
      });
    }
    listFooter(this.rows, matching.length, visible.length);
  }

  private updateSelection() {
    this.addButton.setButtonText(this.selected.size ? `Add ${tagCount(this.selected.size)}` : 'Add tags');
    this.addButton.setDisabled(!this.selected.size || this.running || this.applying);
  }

  private prepareNextSample() {
    const result = this.result;
    if (!result || ['all', 'minimum'].includes(this.config.poolMode)) {
      this.nextPool = null;
    } else {
      const evaluated = new Set(result.judgments.map(item => tagKey(item.tag)));
      const remaining = this.tags.filter(item => !evaluated.has(tagKey(item.tag)));
      // Another sample draws at random from unscored tags instead of taking the next most-used ones.
      const config: Config = { ...this.config, poolMode: 'count', poolCount: this.sampleSize, mostUsedPercent: 0 };
      const pool = selectCandidates(remaining, this.note.existingTags, config, `${noteSeed(this.note)}:review:${evaluated.size}`);
      this.nextPool = pool.tags.length ? pool : null;
    }
    const more = this.sampleButton.buttonEl.parentElement;
    if (more) more.hidden = !this.nextPool;
    if (!this.nextPool) return;
    try {
      const prepared = buildBatches(this.note, this.nextPool, this.config);
      this.sampleButton.setButtonText(`Score ${moreTags(this.nextPool.tags.length)}`)
        .setTooltip(`Sends ${prepared.batches.length} more ${prepared.batches.length === 1 ? 'request' : 'requests'} to ${resolveProvider(this.config).label}. Your selections stay.`);
    } catch {
      this.nextPool = null;
      if (more) more.hidden = true;
    }
  }

  onClose() {
    this.controller.abort();
    this.plugin.endRun(this.file.path, this.controller);
    this.contentEl.empty();
  }
}

function listFooter(rows: HTMLElement, total: number, shown = Math.min(total, VISIBLE_ROWS)) {
  if (!total) rows.createDiv({ cls: 'tag-match-list-note', text: 'No matching tags.' });
  else if (total > shown) rows.createDiv({ cls: 'tag-match-list-note', text: `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}. Search to find more.` });
}

// Rounds down so a score just under the minimum never displays as the minimum itself.
function percent(probability: number): string {
  return `${Math.floor(probability * 100 + 1e-9)}%`;
}

function tagCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'tag' : 'tags'}`;
}

function moreTags(count: number): string {
  return `${count.toLocaleString()} more ${count === 1 ? 'tag' : 'tags'}`;
}

function useCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'use' : 'uses'}`;
}

function inspectionLabel(item: CandidateInspection, scored: boolean): string {
  if (item.status === 'excluded') return 'Excluded';
  if (item.status === 'already-present') return 'On this note';
  if (scored) return 'Not scored';
  if (item.status === 'outside-pool') return 'Not selected';
  if (item.reason === 'discovery') return 'Sampled';
  if (item.reason === 'frequent') return 'Most-used';
  return 'Selected';
}
