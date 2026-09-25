// Registers Obsidian commands and settings while keeping all tagging decisions in shared modules.
import { Notice, Platform, Plugin, normalizePath, requestUrl } from 'obsidian';
import { type Config, normalizeConfig, persistedConfig } from './config.ts';
import { hydrateCredentials, migrateLegacyCredentials } from './secret-storage.ts';
import { type Transport } from './client.ts';
import { applySuggestions, inventory, readNote } from './vault.ts';
import { suggest } from './client.ts';
import { TagMatchSettingsTab } from './settings.ts';
import { ReviewModal } from './review.ts';
import { resolveAgentCliStatus, type AgentCliStatus } from './agent-instruction.ts';

export default class TagMatchPlugin extends Plugin {
  declare settings: Config;
  agentCliStatus: AgentCliStatus = { kind: 'missing' };
  private saveQueue: Promise<void> = Promise.resolve();
  private reviews = new Set<ReviewModal>();
  private runs = new Map<string, AbortController>();

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
    if (Platform.isDesktop) {
      const pluginDirectory = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
      const [cli, guide] = await Promise.all([
        this.app.vault.adapter.exists(`${pluginDirectory}/tag-match.mjs`),
        this.app.vault.adapter.exists(`${pluginDirectory}/AGENT-CLI.md`),
      ]);
      if (!cli || !guide) this.agentCliStatus = { kind: 'missing' };
      else {
        try {
          const source = await this.app.vault.adapter.read(`${pluginDirectory}/tag-match.mjs`);
          this.agentCliStatus = resolveAgentCliStatus(this.manifest.version, source, true);
        } catch { this.agentCliStatus = { kind: 'unknown' }; }
      }
    }
    this.addSettingTab(new TagMatchSettingsTab(this.app, this));
    this.addCommand({ id: 'find-matching-tags', name: 'Review tags for current note',
      checkCallback: checking => {
        if (!this.app.workspace.getActiveFile()) return false;
        if (!checking) void this.openReview();
        return true;
      } });
    this.addCommand({ id: 'add-recommended-tags', name: 'Add recommended tags to current note',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.quickApply();
        return true;
      } });
    this.addRibbonIcon('tags', 'Review tags for current note', () => { void this.openReview(); });
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
      const result = await suggest(note, inventory(this.app), this.credentialSnapshot(), this.transport,
        controller.signal, state => progress.setMessage(`Evaluated ${state.complete} of ${state.total} tags…`));
      const selected = result.recommended.map(item => item.tag);
      if (!selected.length) {
        progress.hide();
        new Notice('Analysis complete. No tags met the recommendation threshold.');
        return;
      }
      controller.signal.throwIfAborted();
      await applySuggestions(this.app, file, snapshot, selected, note.existingTags, this.settings);
      progress.hide();
      new Notice(`Added ${selected.length} recommended ${selected.length === 1 ? 'tag' : 'tags'} to ${file.basename}.`);
    } catch (error) {
      progress.hide();
      if (!controller.signal.aborted) new Notice(error instanceof Error ? error.message : 'Could not add recommended tags.');
    } finally { this.endRun(file.path, controller); }
  }

  onunload() {
    for (const controller of this.runs.values()) controller.abort();
    this.runs.clear();
    for (const modal of this.reviews) modal.close();
  }
}
