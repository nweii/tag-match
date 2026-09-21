// Defines searchable native Obsidian settings for candidate coverage and tagging conventions.
import { type App, FileSystemAdapter, Modal, Notice, Platform, PluginSettingTab, SecretComponent, Setting, type SettingDefinitionItem } from 'obsidian';
import type TagMatchPlugin from './main.ts';
import { type Config, normalizeConfig } from './config.ts';
import { selectCandidates, parseDefinitions, isExcluded, exclusionRules } from './core.ts';
import { inventory } from './vault.ts';
import { resolveProvider } from './provider.ts';
import { buildAgentInstruction, resolveAgentSetup } from './agent-instruction.ts';
import { hydrateCredentials } from './secret-storage.ts';

class VocabularyModal extends Modal {
  private plugin: TagMatchPlugin;
  constructor(app: App, plugin: TagMatchPlugin) { super(app); this.plugin = plugin; }
  onOpen() {
    this.contentEl.createEl('h2', { text: 'Vault tags' });
    const all = selectCandidates(inventory(this.app), [], { ...this.plugin.settings, poolMode: 'all', excludedTags: '' });
    const rules = exclusionRules(this.plugin.settings.excludedTags);
    let query = '';
    const rows = this.contentEl.createDiv('tag-match-list');
    const draw = () => {
      rows.empty();
      const tags = all.tags.filter(item => item.tag.toLowerCase().includes(query));
      rows.createEl('p', { text: `${tags.length.toLocaleString()} tags${tags.length > 200 ? ' · showing the first 200; search to narrow' : ''}` });
      for (const item of tags.slice(0, 200)) rows.createDiv({ cls: 'tag-match-candidate',
        text: `#${item.tag} · ${item.count} uses${isExcluded(item.tag, rules) ? ' · excluded' : ''}` });
    };
    new Setting(this.contentEl).setName('Search tags').addSearch(search => search.onChange(value => {
      query = value.toLowerCase(); draw();
    }));
    draw();
  }
  onClose() { this.contentEl.empty(); }
}

type SettingKey = keyof Config;

export class TagMatchSettingsTab extends PluginSettingTab {
  private plugin: TagMatchPlugin;
  constructor(app: App, plugin: TagMatchPlugin) { super(app, plugin); this.plugin = plugin; }

  getControlValue(key: string): unknown { return this.plugin.settings[key as SettingKey]; }

  async setControlValue(key: string, value: unknown) {
    this.plugin.settings = normalizeConfig({ ...this.plugin.settings, [key]: value });
    await this.plugin.saveSettings();
    this.update();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const textLimit = this.plugin.settings.maxBodyChars;
    const wordEstimate = (charactersPerWord: number) =>
      (Math.round(textLimit / charactersPerWord / 10) * 10).toLocaleString();
    const provider = resolveProvider(this.plugin.settings);
    const basePath = Platform.isDesktop && this.app.vault.adapter instanceof FileSystemAdapter
      ? this.app.vault.adapter.getBasePath() : null;
    const agentSetup = resolveAgentSetup(Platform.isDesktop, basePath, this.app.vault.configDir,
      this.plugin.manifest.id, this.plugin.manifest.version, Platform.isWin);
    const agentInstruction = agentSetup && this.plugin.agentCliInstalled
      ? buildAgentInstruction(agentSetup.guidePath) : null;
    return [
      { name: 'Tag Match', desc: `Review matches before adding them, or apply recommendations directly. Analysis sends note content and tagging context to ${provider.label} using ${provider.model}.` },
      { type: 'group', heading: 'Connection and agents', items: [
        { name: 'Connection provider', desc: 'Choose where decision requests are sent. Each provider uses its own key.',
          control: { type: 'dropdown', key: 'provider', options: { typesafe: 'TypeSafe', openrouter: 'OpenRouter' } } },
        { name: 'TypeSafe API key', desc: 'Choose an Obsidian Secret for TypeSafe.',
          visible: () => this.plugin.settings.provider === 'typesafe', aliases: ['credential', 'token'], render: setting => {
            new SecretComponent(this.app, setting.controlEl).setValue(this.plugin.settings.typeSafeSecretId).onChange(async value => {
              this.plugin.settings.typeSafeSecretId = value;
              this.plugin.settings = hydrateCredentials(this.plugin.settings, this.app.secretStorage);
              await this.plugin.saveSettings();
            });
          } },
        { name: 'OpenRouter API key', desc: 'Choose an Obsidian Secret for OpenRouter.',
          visible: () => this.plugin.settings.provider === 'openrouter', aliases: ['credential', 'token'], render: setting => {
            new SecretComponent(this.app, setting.controlEl).setValue(this.plugin.settings.openRouterSecretId).onChange(async value => {
              this.plugin.settings.openRouterSecretId = value;
              this.plugin.settings = hydrateCredentials(this.plugin.settings, this.app.secretStorage);
              await this.plugin.saveSettings();
            });
          } },
        { name: 'OpenRouter model', desc: 'Decision model ID. The default is the verified Jev 1.13 model.',
          visible: () => this.plugin.settings.provider === 'openrouter',
          control: { type: 'text', key: 'openRouterModel', placeholder: 'typesafe/jev-1.13',
            validate: value => value.trim() ? undefined : 'Enter an OpenRouter Decisions API model ID.' } },
        { name: 'Use Tag Match with agents', desc: agentSetup
          ? this.plugin.agentCliInstalled
            ? 'Ready for terminal-capable agents. Copy an instruction for tag review, direct application, or general decisions.'
            : `Requires Node.js 22 or later. Copy the install command, run it in ${Platform.isWin ? 'PowerShell' : 'a terminal'}, then reload Obsidian.`
          : 'The optional agent CLI requires Node.js and a terminal on a desktop computer.',
          aliases: ['shared command-line configuration', 'CLI'], render: setting => {
            if (!agentSetup) return;
            setting.settingEl.addClass('tag-match-agent-instruction');
            if (agentInstruction) setting.addButton(button => button.setButtonText('Copy agent instruction').onClick(async () => {
              try { await activeWindow.navigator.clipboard.writeText(agentInstruction); new Notice('Agent instruction copied.'); }
              catch { new Notice('Could not copy the agent instruction.'); }
            }));
            setting.addButton(button => button.setButtonText(agentInstruction ? 'Copy update command' : 'Copy install command').onClick(async () => {
              try { await activeWindow.navigator.clipboard.writeText(agentSetup.installCommand); new Notice(`${agentInstruction ? 'Update' : 'Install'} command copied.`); }
              catch { new Notice('Could not copy the command. Open the preview and copy it instead.'); }
            }));
            const details = setting.controlEl.createEl('details', { cls: 'tag-match-agent-preview' });
            details.createEl('summary', { text: `Preview ${agentInstruction ? 'update' : 'install'} command` });
            details.createEl('code', { text: agentSetup.installCommand });
          } },
      ] },
      { type: 'group', heading: 'Tags to check', items: [
        { name: 'Tags to check', desc: 'Set how many eligible vault tags the model evaluates.',
          aliases: ['tags to consider', 'candidate pool'], control: { type: 'dropdown', key: 'poolMode', options: {
            auto: 'Automatic (recommended)', percent: 'Most-used tags by percentage', count: 'Most-used tags by number',
            minimum: 'Tags used at least X times', all: 'All tags, including rare tags',
          } } },
        { name: 'Automatic range', desc: 'All eligible tags up to 100. For larger vocabularies, at least 100 or the most-used 20%, whichever is larger.',
          visible: () => this.plugin.settings.poolMode === 'auto' },
        { name: 'Top percentage to check', desc: 'Uses distinct eligible tags ranked by vault use. The count rounds up.',
          visible: () => this.plugin.settings.poolMode === 'percent',
          control: { type: 'slider', key: 'poolPercent', min: 1, max: 100, step: 1, displayFormat: value => `${value}%` } },
        { name: 'Number of top tags to check', desc: 'Uses this many of the most-used eligible tags. Larger numbers require more requests.',
          visible: () => this.plugin.settings.poolMode === 'count',
          control: { type: 'number', key: 'poolCount', min: 1, max: 1_000_000, step: 1,
            validate: value => Number.isInteger(value) && value >= 1 && value <= 1_000_000 ? undefined : 'Enter a whole number from 1 to 1,000,000.' } },
        { name: 'Minimum uses', desc: 'Includes tags with at least this many uses. A value of 2 includes tags used exactly twice.',
          visible: () => this.plugin.settings.poolMode === 'minimum',
          control: { type: 'number', key: 'minimumUses', min: 1, max: 1_000_000, step: 1,
            validate: value => Number.isInteger(value) && value >= 1 && value <= 1_000_000 ? undefined : 'Enter a whole number from 1 to 1,000,000.' } },
        { name: 'Candidate coverage', desc: 'Shows how much of the current vault vocabulary this range checks after exclusions.', render: setting => {
          const pool = selectCandidates(inventory(this.app), [], this.plugin.settings);
          const description = createFragment();
          description.appendText('Checks ');
          description.createEl('strong', { text: pool.tags.length.toLocaleString() });
          description.appendText(' of ');
          description.createEl('strong', { text: pool.eligible.toLocaleString() });
          description.appendText(' eligible tags, ranked by use. Vault total: ');
          description.createEl('strong', { text: pool.total.toLocaleString() });
          description.appendText('; excluded: ');
          description.createEl('strong', { text: pool.excluded.toLocaleString() });
          description.appendText('. Existing note tags are removed when analysis starts.');
          setting.setDesc(description);
        } },
        { name: 'Excluded tags', desc: 'One tag per line or separated by commas. “work” excludes #work only. “work/*” also excludes descendants such as #work/project. Existing note tags are excluded automatically.',
          aliases: ['branches'], control: { type: 'textarea', key: 'excludedTags', rows: 5,
            placeholder: 'admin\nwork/*' } },
        { name: 'Browse vault tags', desc: 'Search tags by use count. Excluded tags are marked.',
          action: () => new VocabularyModal(this.app, this.plugin).open() },
      ] },
      { type: 'group', heading: 'Suggestions', items: [
        { name: 'Maximum tags to add', desc: 'Limits preselected and directly applied tags. Candidate coverage is separate.',
          aliases: ['maximum tags to add'], control: { type: 'number', key: 'maxTagsToAdd', min: 1, max: 1000, step: 1,
            validate: value => Number.isInteger(value) && value >= 1 && value <= 1000 ? undefined : 'Enter a whole number from 1 to 1,000.' } },
        { name: 'Preselect threshold', desc: 'Preselect matches at or above this score, up to the maximum additions. Every checked tag remains available for review, including tags below the threshold.',
          aliases: ['suggestion threshold'], control: { type: 'slider', key: 'minProbability', min: 0, max: 1, step: 0.01,
            displayFormat: value => `${Math.round(value * 100)}%` } },
      ] },
      { type: 'group', heading: 'Tagging context', items: [
        { name: 'Tagging guidance', desc: 'Describe your general tagging preferences in short, direct rules. Examples help clarify boundaries. Define individual tags below, and use Excluded tags for anything that must never be suggested.',
          control: { type: 'textarea', key: 'guidance', rows: 5,
            placeholder: 'Prefer durable topics over workflow status. Do not tag a passing mention.' } },
        { name: 'Tag definitions', desc: 'Define any tag whose vault-specific meaning is unclear. Use one line per tag in the form “tag = meaning; use for …; do not use for …”.',
          control: { type: 'textarea', key: 'definitions', rows: 5,
            placeholder: 'research = Source material and findings; do not use for casual references',
            validate: value => { try { parseDefinitions(value); return undefined; }
              catch (error) { return error instanceof Error ? error.message : 'Use “tag = meaning” on each line.'; } } } },
        { name: 'Note text limit', desc: `${textLimit.toLocaleString()} characters · roughly ${wordEstimate(6.4)}–${wordEstimate(16 / 3)} English words. For longer notes, Tag Match sends excerpts from the beginning, middle, and end. Frontmatter is handled separately.`,
          aliases: ['note body characters'], control: { type: 'number', key: 'maxBodyChars', min: 200, max: 24000, step: 1,
            validate: value => Number.isInteger(value) && value >= 200 && value <= 24000 ? undefined : 'Enter a whole number from 200 to 24,000.' } },
      ] },
      { type: 'group', heading: 'About', items: [
        { name: 'Tag Match', render: setting => {
          setting.descEl.appendText(`Version ${this.plugin.manifest.version} · Created by `);
          setting.descEl.createEl('a', { text: 'Nathan Cheng', href: 'https://nathancheng.work/' });
          setting.descEl.appendText('.');
        } },
        { name: 'Feedback', render: setting => {
          setting.addButton(button => button.setButtonText('Report issue').onClick(() => {
            activeWindow.open('https://github.com/nweii/tag-match/issues');
          }));
        } },
      ] },
    ];
  }
}
