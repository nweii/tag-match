// Registers Obsidian commands and settings while keeping all tagging decisions in shared modules.
import { ButtonComponent, Notice, Platform, Plugin, normalizePath, requestUrl, type TFile } from 'obsidian';
import { type Config, normalizeConfig, persistedConfig } from './config.ts';
import { hydrateCredentials, migrateLegacyCredentials } from './secret-storage.ts';
import { type Transport } from './client.ts';
import { applySuggestions, inventory, readNote } from './vault.ts';
import { suggest } from './client.ts';
import { TagMatchSettingsTab } from './settings.ts';
import { ReviewModal } from './review.ts';
import { BulkTagModal, filesInScope } from './bulk-modal.ts';
import { resolveAgentCliStatus, type AgentCliStatus } from './agent-instruction.ts';

declare const __TAG_MATCH_CLI_IDENTITY__: string;

export default class TagMatchPlugin extends Plugin {
  declare settings: Config;
  agentCliStatus: AgentCliStatus = { kind: 'missing' };
  private saveQueue: Promise<void> = Promise.resolve();
  private reviews = new Set<ReviewModal>();
  private bulkModals = new Set<BulkTagModal>();
  private runs = new Map<string, AbortController>();
  private bulkStatus?: ButtonComponent;
  private bulkNotice?: Notice;
  private bulkNoticeButton?: ButtonComponent;
  private noticeRun?: BulkTagModal;
  private noticeFinished = false;

  transport: Transport = async (request, apiKey, signal, endpoint) => {
    signal.throwIfAborted();
    let timer: number | undefined;
    let abort: (() => void) | undefined;
    try {
      // Obsidian requestUrl cannot abort an in-flight request. Cancellation prevents subsequent batches and writes.
      const response = await Promise.race([
        requestUrl({ url: endpoint, method: 'POST', headers: { Authorization: `Bearer ${apiKey}` },
          contentType: 'application/json', body: JSON.stringify(request), throw: false }),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(() => reject(new Error('The Jev provider timed out after 45 seconds.')), 45000);
          abort = () => reject(new Error('Cancelled.'));
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
      signal.throwIfAborted();
      let json: unknown;
      try { json = response.json; } catch { json = undefined; }
      return { status: response.status, json, retryAfter: response.headers['retry-after'] };
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  };

  async onload() {
    const loaded = normalizeConfig(await this.loadData());
    const migrated = migrateLegacyCredentials(loaded, this.app.secretStorage);
    this.settings = hydrateCredentials(migrated.config, this.app.secretStorage);
    if (migrated.changed) await this.saveData(persistedConfig(this.settings));
    await this.refreshAgentCliStatus();
    this.addSettingTab(new TagMatchSettingsTab(this.app, this));
    this.addCommand({ id: 'find-matching-tags', name: 'Suggest tags for current note…',
      checkCallback: checking => {
        if (!this.app.workspace.getActiveFile()) return false;
        if (!checking) void this.openReview();
        return true;
      } });
    this.addCommand({ id: 'add-recommended-tags', name: 'Match and add tags to current note',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.quickApply();
        return true;
      } });
    this.addRibbonIcon('tags', 'Suggest tags for current note…', () => { void this.openReview(); });
    this.addCommand({ id: 'add-recommended-tags-multiple', name: 'Match tags to multiple notes…',
      callback: () => this.openBulk() });
    this.addCommand({ id: 'show-bulk-progress', name: 'Show bulk tagging progress',
      checkCallback: checking => {
        const run = this.retainedBulk();
        if (!run) return false;
        if (!checking) run.open();
        return true;
      } });
    if (Platform.isDesktop) {
      this.bulkStatus = new ButtonComponent(this.addStatusBarItem()).setButtonText('Tag Match')
        .setTooltip('Show bulk tagging progress and results').onClick(() => this.retainedBulk()?.open());
      this.bulkStatus.buttonEl.hidden = true;
    }
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      const files = filesInScope(this.app.vault.getMarkdownFiles(), [file.path || '/']);
      if (!files.length) return;
      menu.addItem(item => item.setTitle('Match tags…').setIcon('tags')
        .onClick(() => this.openBulk(files)));
    }));
    this.registerEvent(this.app.workspace.on('files-menu', (menu, files) => {
      const selected = filesInScope(this.app.vault.getMarkdownFiles(), files.map(file => file.path || '/'));
      if (!selected.length) return;
      menu.addItem(item => item.setTitle('Match tags to selected notes…').setIcon('tags')
        .onClick(() => this.openBulk(selected)));
    }));
  }

  private openBulk(files?: TFile[]) {
    const retained = this.retainedBulk();
    if (retained) { retained.open(); return; }
    // One plugin-owned bulk controller bounds requests and recovery storage across every entry point.
    for (const idle of this.bulkModals) idle.dispose();
    const modal = new BulkTagModal(this.app, this, files, () => {
      if (modal.disposed) this.bulkModals.delete(modal);
      this.updateBulkStatus();
    });
    this.bulkModals.add(modal);
    const close = modal.onClose.bind(modal);
    modal.onClose = () => { close(); if (!modal.retained) this.bulkModals.delete(modal); this.updateBulkStatus(); };
    modal.open();
  }

  private retainedBulk() { return [...this.bulkModals].find(modal => modal.retained); }

  private updateBulkStatus() {
    const run = this.retainedBulk();
    if (this.bulkStatus) {
      this.bulkStatus.buttonEl.hidden = !run;
      if (run) this.bulkStatus.setButtonText(run.progressText);
    }
    if (!run || run.visible) {
      this.bulkNotice?.hide(); this.bulkNotice = undefined;
      this.bulkNoticeButton = undefined; this.noticeRun = undefined;
      return;
    }
    const finished = !run.active;
    if (!this.bulkNotice || this.noticeRun !== run || this.noticeFinished !== finished) {
      this.bulkNotice?.hide();
      this.bulkNotice = new Notice('Tag Match', 0);
      this.bulkNotice.messageEl.empty();
      this.bulkNoticeButton = new ButtonComponent(this.bulkNotice.messageEl)
        .setTooltip('Open bulk tagging progress and results').onClick(() => run.open());
      this.bulkNoticeButton.buttonEl.addClass('tag-match-bulk-notice-action');
      this.noticeRun = run; this.noticeFinished = finished;
    }
    this.bulkNoticeButton!.setButtonText(finished ? 'Tag Match: Batch finished · Open results' : `${run.progressText} · Open progress`);
  }

  async refreshAgentCliStatus(): Promise<void> {
    if (!Platform.isDesktop) { this.agentCliStatus = { kind: 'missing' }; return; }
    const pluginDirectory = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    const cliPath = `${pluginDirectory}/tag-match.mjs`;
    const guidePath = `${pluginDirectory}/AGENT-CLI.md`;
    const [cli, guide] = await Promise.all([
      this.app.vault.adapter.exists(cliPath), this.app.vault.adapter.exists(guidePath),
    ]);
    if (!cli || !guide) { this.agentCliStatus = { kind: 'missing' }; return; }
    try {
      const source = await this.app.vault.adapter.read(cliPath);
      this.agentCliStatus = resolveAgentCliStatus(
        typeof __TAG_MATCH_CLI_IDENTITY__ === 'string' ? __TAG_MATCH_CLI_IDENTITY__ : null,
        this.manifest.version, source, true);
    } catch { this.agentCliStatus = { kind: 'unknown', version: null }; }
  }

  async saveSettings() {
    const snapshot = persistedConfig(this.settings);
    this.saveQueue = this.saveQueue.catch(() => {}).then(() => this.saveData(snapshot));
    try { await this.saveQueue; }
    catch { new Notice('Could not save Tag Match settings.'); }
  }

  credentialSnapshot(): Config {
    this.settings = hydrateCredentials(this.settings, this.app.secretStorage);
    return { ...this.settings };
  }

  private async openReview() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') { new Notice('Open a Markdown note first.'); return; }
    try {
      const { note, snapshot } = await readNote(this.app, file);
      const modal = new ReviewModal(this.app, this, file, note, snapshot);
      this.reviews.add(modal);
      const close = modal.onClose.bind(modal);
      modal.onClose = () => { close(); this.reviews.delete(modal); };
      modal.open();
    } catch (error) { new Notice(error instanceof Error ? error.message : 'Could not read the note.'); }
  }

  beginRun(path: string, controller: AbortController): boolean {
    if (this.runs.has(path)) return false;
    this.runs.set(path, controller);
    return true;
  }

  endRun(path: string, controller: AbortController) {
    if (this.runs.get(path) === controller) this.runs.delete(path);
  }

  private async quickApply() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') { new Notice('Open a Markdown note first.'); return; }
    const controller = new AbortController();
    if (!this.beginRun(file.path, controller)) { new Notice('Tag Match is already analyzing this note.'); return; }
    const progress = new Notice('Preparing tag analysis…', 0);
    try {
      const { note, snapshot } = await readNote(this.app, file);
      const config = this.credentialSnapshot();
      const result = await suggest(note, inventory(this.app), config, this.transport,
        controller.signal, state => progress.setMessage(`Evaluated ${state.complete} of ${state.total} tags…`));
      const selected = result.recommended.map(item => item.tag);
      if (!selected.length) {
        progress.hide();
        new Notice('Analysis complete. No tags met the recommendation threshold.');
        return;
      }
      controller.signal.throwIfAborted();
      await applySuggestions(this.app, file, snapshot, selected, note.existingTags, config, controller.signal);
      progress.hide();
      new Notice(`Added ${selected.length} recommended ${selected.length === 1 ? 'tag' : 'tags'} to ${file.basename}.`);
    } catch (error) {
      progress.hide();
      if (!controller.signal.aborted) new Notice(error instanceof Error ? error.message : 'Could not add recommended tags.');
    } finally { this.endRun(file.path, controller); }
  }

  onunload() {
    this.bulkNotice?.hide();
    for (const controller of this.runs.values()) controller.abort();
    this.runs.clear();
    for (const modal of this.reviews) modal.close();
    for (const modal of this.bulkModals) modal.dispose();
  }
}
