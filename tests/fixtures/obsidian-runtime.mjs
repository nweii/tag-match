// Supplies the small Obsidian and DOM boundary needed to render settings callbacks in Node.
export class TestElement {
  constructor(tag = 'div', options = {}) {
    this.tagName = tag.toUpperCase();
    this.text = options.text ?? '';
    this.className = options.cls ?? '';
    this.children = [];
    this.open = false;
  }
  createEl(tag, options = {}) {
    const child = new TestElement(tag, options); child.parent = this; this.children.push(child);
    if (tag === 'summary') child.click = async () => { if (child.parent?.tagName === 'DETAILS') child.parent.open = !child.parent.open; };
    return child;
  }
  createDiv(cls = '') { return this.createEl('div', typeof cls === 'string' ? { cls } : cls); }
  addClass(value) { this.className += `${this.className ? ' ' : ''}${value}`; }
  appendText(value) { this.children.push(new TestElement('#text', { text: value })); }
  empty() { this.children = []; }
  all(tag) { return this.children.flatMap(child => [...(child.tagName === tag.toUpperCase() ? [child] : []), ...child.all(tag)]); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
}

export class FileSystemAdapter { constructor(path = '') { this.path = path; } getBasePath() { return this.path; } }
export const Platform = { isDesktop: true, isWin: false };
export class Modal { constructor(app) { this.app = app; this.contentEl = new TestElement(); } open() {} }
export class Notice { constructor(message) { this.message = message; } }
export class SecretComponent {
  constructor(_app, container) { this.element = container.createEl('select'); }
  setValue(value) { this.element.value = value; return this; }
  onChange(handler) { this.element.change = handler; return this; }
}
export class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; }
  update() {}
  renderSettingDefinition(definition) {
    const setting = new Setting();
    setting.setName(definition.name ?? '').setDesc(definition.desc ?? '');
    if (definition.control?.type === 'dropdown') setting.addDropdown(dropdown => {
      dropdown.addOptions(definition.control.options).setValue(String(this.getControlValue(definition.control.key)))
        .onChange(value => this.setControlValue(definition.control.key, value));
    });
    definition.render?.(setting);
    return setting;
  }
}
export class Setting {
  constructor() { this.settingEl = new TestElement(); this.controlEl = this.settingEl.createDiv('setting-item-control'); }
  setName() { return this; }
  setDesc(value) { this.description = value; return this; }
  addButton(callback) {
    const element = this.controlEl.createEl('button');
    const button = { setButtonText: text => { element.text = text; return button; }, onClick: handler => { element.click = handler; return button; } };
    callback(button); return this;
  }
  addDropdown(callback) {
    const element = this.controlEl.createEl('select');
    const dropdown = {
      addOptions: options => { element.options = options; return dropdown; },
      setValue: value => { element.value = value; return dropdown; },
      onChange: handler => { element.change = handler; return dropdown; },
    };
    callback(dropdown); return this;
  }
  addSearch() { return this; }
}
export function getAllTags() { return {}; }
export function getTags() { return []; }
export function normalizePath(path) { return path; }
