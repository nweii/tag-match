// Exercises observable settings controls through a lightweight Obsidian runtime boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FileSystemAdapter, Platform, Setting } from 'obsidian';
import { DEFAULTS } from '../src/config.ts';
import { TagMatchSettingsTab } from '../src/settings.ts';

interface Definition { name?: string; desc?: unknown; items?: Definition[]; render?: (setting: Setting) => void; control?: { options?: Record<string, string> }; visible?: () => boolean }
interface RenderElement { textContent: string; open: boolean; all(tag: string): RenderElement[]; click?(): Promise<void>; change?(value: string): Promise<void> }

class Fragment {
  children: { textContent: string }[] = [];
  appendText(text: string) { this.children.push({ textContent: text }); }
  createEl(_tag: string, options: { text: string }) { const child = { textContent: options.text }; this.children.push(child); return child; }
  get textContent() { return this.children.map(child => child.textContent).join(''); }
}

function renderElement(setting: Setting): RenderElement {
  return setting.settingEl as unknown as RenderElement;
}

function setup(desktop: boolean, eligible = 3, poolMode: 'auto' | 'percent' = 'auto', installed = desktop) {
  (Platform as { isDesktop: boolean }).isDesktop = desktop;
  const copied: string[] = [];
  Object.assign(globalThis, {
    createFragment: () => new Fragment(),
    activeWindow: { navigator: { clipboard: { writeText: async (value: string) => { copied.push(value); } } } },
  });
  const Adapter = FileSystemAdapter as unknown as new(path: string) => FileSystemAdapter;
  const app = { vault: { configDir: 'settings', adapter: new Adapter('/Vault') },
    metadataCache: { getTags: () => Object.fromEntries(Array.from({ length: eligible }, (_, index) => [`#tag-${index}`, eligible - index])) } };
  const plugin = { manifest: { id: 'tag-match', version: '0.1.0' }, agentCliInstalled: installed,
    settings: { ...DEFAULTS, poolMode }, saveSettings: async () => {} };
  const tab = new TagMatchSettingsTab(app as never, plugin as never);
  const definitions = tab.getSettingDefinitions() as Definition[];
  const items = definitions.flatMap(item => item.items ?? []);
  return { items, copied, tab };
}

function rendered(tab: TagMatchSettingsTab, definition: Definition): Setting {
  return (tab as unknown as { renderSettingDefinition(value: Definition): Setting }).renderSettingDefinition(definition);
}

test('installed desktop CLI puts the agent instruction first and keeps a compact update command', async () => {
  const { items, copied, tab } = setup(true);
  const definition = items.find(item => item.name === 'Use Tag Match with agents');
  assert.ok(definition);
  const setting = rendered(tab, definition);
  const details = renderElement(setting).all('details')[0];
  assert.ok(details);
  assert.equal(details.open, false);
  assert.equal(details.all('summary')[0]?.textContent, 'Preview update command');
  await details.all('summary')[0]?.click?.();
  assert.equal(details.open, true);
  const button = renderElement(setting).all('button')[0];
  await button?.click?.();
  assert.equal(copied.length, 1);
  assert.match(copied[0]!, /\/Vault\/settings\/plugins\/tag-match\/AGENT-CLI\.md/);
  const update = renderElement(setting).all('button')[1];
  await update?.click?.();
  assert.match(copied[1]!, /releases\/download\/0\.1\.0\/install-cli\.mjs/);
});

test('desktop without the CLI offers a pinned install command', async () => {
  const { items, copied, tab } = setup(true, 3, 'auto', false);
  const definition = items.find(item => item.name === 'Use Tag Match with agents');
  assert.ok(definition);
  const setting = rendered(tab, definition);
  assert.equal(renderElement(setting).all('button')[0]?.textContent, 'Copy install command');
  assert.equal(renderElement(setting).all('details')[0]?.all('summary')[0]?.textContent, 'Preview install command');
  await renderElement(setting).all('button')[0]?.click?.();
  assert.match(copied[0]!, /curl -fsSL/);
  assert.match(copied[0]!, /releases\/download\/0\.1\.0\/install-cli\.mjs/);
  assert.match(copied[0]!, /'\/Vault\/settings\/plugins\/tag-match'/);
});

test('mobile settings expose no local path, copy action, or preview', () => {
  const { items, tab } = setup(false);
  const definition = items.find(item => item.name === 'Use Tag Match with agents');
  assert.ok(definition);
  const setting = rendered(tab, definition);
  assert.equal(renderElement(setting).all('button').length, 0);
  assert.equal(renderElement(setting).all('details').length, 0);
  assert.doesNotMatch(String(definition.desc) + renderElement(setting).textContent, /\/Vault|AGENT-CLI/);
});

test('selecting automatic mode updates rendered coverage to its 100-tag floor', async () => {
  const { items, tab } = setup(true, 101, 'percent');
  const mode = items.find(item => item.name === 'Tags to check');
  assert.ok(mode);
  const modeSetting = rendered(tab, mode);
  const select = renderElement(modeSetting).all('select')[0];
  await select?.change?.('auto');
  assert.equal(tab.getControlValue('poolMode'), 'auto');
  const definitions = tab.getSettingDefinitions() as Definition[];
  const coverage = definitions.flatMap(item => item.items ?? [])
    .find(item => item.name === 'Candidate coverage') as Definition;
  const setting = rendered(tab, coverage);
  assert.match((setting as unknown as { description: Fragment }).description.textContent, /Checks 100 of 101 eligible tags/);
});
