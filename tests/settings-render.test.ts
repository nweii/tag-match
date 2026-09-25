// Exercises observable settings controls through a lightweight Obsidian runtime boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FileSystemAdapter, Platform, Setting } from 'obsidian';
import { DEFAULTS, type Config } from '../src/config.ts';
import { TagMatchSettingsTab } from '../src/settings.ts';

interface Definition { name?: string; desc?: unknown; items?: Definition[]; render?: (setting: Setting) => void; control?: { options?: Record<string, string> }; visible?: () => boolean }
interface RenderElement { textContent: string; open: boolean; all(tag: string): RenderElement[]; click?(): Promise<void>; change?(value: unknown): Promise<void> }

class Fragment {
  children: Fragment[] = [];
  text = '';
  constructor(text = '') { this.text = text; }
  appendText(text: string) { this.children.push(new Fragment(text)); }
  createEl(_tag: string, options: { text?: string } = {}) { const child = new Fragment(options.text ?? ''); this.children.push(child); return child; }
  createSpan(options: { text?: string; cls?: string } = {}) { const child = new Fragment(options.text ?? ''); this.children.push(child); return child; }
  empty() { this.text = ''; this.children = []; }
  setText(text: string) { this.text = text; this.children = []; }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
}

function renderElement(setting: Setting): RenderElement {
  return setting.settingEl as unknown as RenderElement;
}

function setup(desktop: boolean, eligible = 3,
  poolMode: 'auto' | 'percent' | 'count' | 'minimum' | 'all' = 'auto', installed = desktop,
  settings: Partial<Config> = {}, cliKind: 'current' | 'older' | 'unknown' | 'newer' | 'missing' = installed ? 'current' : 'missing') {
  (Platform as { isDesktop: boolean }).isDesktop = desktop;
  const copied: string[] = [];
  Object.assign(globalThis, {
    createFragment: () => new Fragment(),
    activeWindow: { navigator: { clipboard: { writeText: async (value: string) => { copied.push(value); } } } },
  });
  const Adapter = FileSystemAdapter as unknown as new(path: string) => FileSystemAdapter;
  const app = { vault: { configDir: 'settings', adapter: new Adapter('/Vault') },
    metadataCache: { getTags: () => Object.fromEntries(Array.from({ length: eligible }, (_, index) => [`#tag-${index}`, eligible - index])) } };
  const agentCliStatus = cliKind === 'missing' || cliKind === 'unknown' ? { kind: cliKind }
    : { kind: cliKind, version: cliKind === 'older' ? '0.0.9' : cliKind === 'newer' ? '0.2.0' : '0.1.0' };
  const plugin = { manifest: { id: 'tag-match', version: '0.1.0' }, agentCliStatus,
    settings: { ...DEFAULTS, poolMode, ...settings }, saveSettings: async () => {} };
  const tab = new TagMatchSettingsTab(app as never, plugin as never);
  const definitions = tab.getSettingDefinitions() as Definition[];
  const items = definitions.flatMap(item => item.items ?? []);
  return { items, copied, tab };
}

function rendered(tab: TagMatchSettingsTab, definition: Definition): Setting {
  return (tab as unknown as { renderSettingDefinition(value: Definition): Setting }).renderSettingDefinition(definition);
}

test('current desktop CLI shows its matching release without an update command', async () => {
  const { items, copied, tab } = setup(true);
  const definition = items.find(item => item.name === 'Use Tag Match with agents');
  assert.ok(definition);
  const setting = rendered(tab, definition);
  assert.match((definition.desc as Fragment).textContent, /CLI up to date.*0\.1\.0 matches this plugin/);
  assert.match((definition.desc as Fragment).textContent, /\/Vault\/settings\/plugins\/tag-match\/tag-match\.mjs/);
  assert.equal(renderElement(setting).all('details').length, 0);
  const button = renderElement(setting).all('button')[0];
  await button?.click?.();
  assert.equal(copied.length, 1);
  assert.match(copied[0]!, /\/Vault\/settings\/plugins\/tag-match\/AGENT-CLI\.md/);
  assert.equal(renderElement(setting).all('button').length, 1);
});

test('older and unknown CLIs offer an update while a newer CLI does not', () => {
  for (const kind of ['older', 'unknown'] as const) {
    const state = setup(true, 3, 'auto', true, {}, kind);
    const definition = state.items.find(item => item.name === 'Use Tag Match with agents');
    assert.ok(definition);
    const setting = renderElement(rendered(state.tab, definition));
    assert.equal(setting.all('button')[1]?.textContent, 'Copy CLI update command');
    assert.equal(setting.all('details')[0]?.all('summary')[0]?.textContent, 'Preview CLI update command');
  }
  const newer = setup(true, 3, 'auto', true, {}, 'newer');
  const definition = newer.items.find(item => item.name === 'Use Tag Match with agents');
  assert.ok(definition);
  assert.match((definition.desc as Fragment).textContent, /CLI 0\.2\.0 is newer than this plugin/);
  assert.equal(renderElement(rendered(newer.tab, definition)).all('details').length, 0);
});

test('tag selection controls follow the selected range and preserve the legacy minimum option', () => {
  const definitions = (mode: 'auto' | 'percent' | 'count' | 'minimum' | 'all') => setup(true, 101, mode).items;
  const visible = (items: Definition[], name: string) => items.find(item => item.name === name)?.visible?.() ?? true;
  assert.equal(visible(definitions('auto'), 'Share from most-used tags'), true);
  assert.equal(visible(definitions('percent'), 'Selection size'), true);
  assert.equal(visible(definitions('all'), 'Selection mix'), false);
  const minimum = definitions('minimum').find(item => item.name === 'Tags to consider');
  assert.equal(minimum?.control?.options?.minimum, 'Tags used at least X times');
  const automatic = definitions('auto').find(item => item.name === 'Tags to consider');
  assert.equal(automatic?.control?.options?.minimum, undefined);
});

test('percentage size and selection mix show their live counts and balance', async () => {
  const state = setup(true, 2452, 'percent', true, { poolPercent: 20, mostUsedPercent: 70 });
  const size = state.items.find(item => item.name === 'Selection size' && item.visible?.());
  const mix = state.items.find(item => item.name === 'Selection mix');
  assert.ok(size); assert.ok(mix);
  assert.equal((size.desc as Fragment).textContent, '20% of all tags. Current selection: 491 tags');
  assert.equal((mix.desc as Fragment).textContent, '491 tags = 343 most-used + 148 sampled');
  const sizeSetting = rendered(state.tab, size);
  const renderedMix = renderElement(rendered(state.tab, mix));
  assert.match(renderedMix.textContent, /Most-used 70%30% Other tags/);
  const slider = renderedMix.all('input')[0];
  await slider?.change?.(60);
  assert.equal(state.tab.getControlValue('mostUsedPercent'), 60);
  const sizeSlider = renderElement(sizeSetting).all('input')[0];
  await sizeSlider?.change?.(30);
  assert.match(renderElement(sizeSetting).textContent, /30% of all tags\. Current selection: 736 tags/);
  assert.match(renderedMix.textContent, /736 tags = 441 most-used \+ 295 sampled/);
});

test('tagging prompt copies current counts and context without credentials or local paths', async () => {
  const { items, copied, tab } = setup(true, 2, 'auto', true, {
    guidance: 'Prefer durable topics.', definitions: 'work = professional activity', excludedTags: 'private/*',
    apiKey: 'type-secret', openRouterApiKey: 'router-secret',
  });
  const definition = items.find(item => item.name === 'Draft guidance with an agent');
  assert.ok(definition);
  const setting = rendered(tab, definition);
  const details = renderElement(setting).all('details')[0];
  assert.equal(details?.open, false);
  assert.equal(details?.all('summary')[0]?.textContent, 'Preview prompt');
  await renderElement(setting).all('button')[0]?.click?.();
  const prompt = copied[0] ?? '';
  assert.match(prompt, /#tag-0\t2/);
  assert.match(prompt, /Prefer durable topics/);
  assert.match(prompt, /work = professional activity/);
  assert.match(prompt, /private\/\*/);
  assert.doesNotMatch(prompt, /type-secret|router-secret|\/Vault/);
  assert.match(prompt, /Do not edit notes, tags, or settings\.[\s\S]*```json[\s\S]*```tsv[\s\S]*#tag-0\t2[\s\S]*```$/);
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

test('selecting automatic mode considers every tag in a small vocabulary', async () => {
  const { items, tab } = setup(true, 101, 'percent');
  const mode = items.find(item => item.name === 'Tags to consider');
  assert.ok(mode);
  const modeSetting = rendered(tab, mode);
  const select = renderElement(modeSetting).all('select')[0];
  await select?.change?.('auto');
  assert.equal(tab.getControlValue('poolMode'), 'auto');
  const definitions = tab.getSettingDefinitions() as Definition[];
  const automatic = definitions.flatMap(item => item.items ?? [])
    .find(item => item.name === 'Default selection') as Definition;
  assert.match((automatic.desc as Fragment).textContent, /101 tags/);
});
