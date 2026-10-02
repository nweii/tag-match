// Supplies the small Obsidian and DOM boundary needed to render settings callbacks in Node.
export class TestElement {
  constructor(tag = 'div', options = {}) {
    this.tagName = tag.toUpperCase();
    this.text = options.text ?? '';
    this.className = options.cls ?? '';
    this.children = [];
    this.open = false;
    this.scrollTop = 0;
    this.style = { setProperty: () => {} };
    Object.assign(this, options.attr ?? {});
  }
  createEl(tag, options = {}) {
    const child = new TestElement(tag, options); child.parent = this; this.children.push(child);
    if (tag === 'summary') child.click = async () => { if (child.parent?.tagName === 'DETAILS') child.parent.open = !child.parent.open; };
    return child;
  }
  createDiv(cls = '') { return this.createEl('div', typeof cls === 'string' ? { cls } : cls); }
  createSpan(options = {}) { return this.createEl('span', typeof options === 'string' ? { cls: options } : options); }
  setAttr(name, value) { this[name] = value; }
  setAttribute(name, value) { this[name] = value; }
  addClass(value) { this.className += `${this.className ? ' ' : ''}${value}`; }
  toggleClass(value, enabled) {
    const classes = new Set(this.className.split(' ').filter(Boolean));
    if (enabled) classes.add(value); else classes.delete(value);
    this.className = [...classes].join(' ');
  }
  setText(value) { this.text = value; this.children = []; }
  appendText(value) { this.children.push(new TestElement('#text', { text: value })); }
  addEventListener(name, handler) { this[name] = handler; }
  focus() {}
  get parentElement() { return this.parent ?? null; }
  empty() { this.children = []; }
  all(tag) { return this.children.flatMap(child => [...(child.tagName === tag.toUpperCase() ? [child] : []), ...(typeof child.all === 'function' ? child.all(tag) : [])]); }
  querySelectorAll(selector) {
    const className = selector.startsWith('.') ? selector.slice(1) : '';
    return this.children.flatMap(child => [
      ...(className && (child.className ?? '').split(' ').includes(className) ? [child] : []),
      ...(typeof child.querySelectorAll === 'function' ? child.querySelectorAll(selector) : []),
    ]);
  }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
}

export class FileSystemAdapter { constructor(path = '') { this.path = path; } getBasePath() { return this.path; } }
export const Platform = { isDesktop: true, isWin: false };
export class Modal { constructor(app) { this.app = app; this.modalEl = new TestElement(); this.titleEl = new TestElement(); this.contentEl = new TestElement(); } setTitle(title) { this.titleEl.setText(title); return this; } open() { this.onOpen(); } close() { this.onClose(); } }
export class FuzzySuggestModal extends Modal {
  setPlaceholder(value) { this.placeholder = value; }
  open() { FuzzySuggestModal.latest = this; }
  onClose() {}
}
export class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; this.commands = []; }
  loadData() { return Promise.resolve(null); }
  saveData() { return Promise.resolve(); }
  addSettingTab() {}
  addCommand(command) { this.commands.push(command); }
  addRibbonIcon() {}
  addStatusBarItem() { return new TestElement(); }
  registerEvent(event) { return event; }
}
export function requestUrl() { throw new Error('Tests must supply a mock transport.'); }
export class ButtonComponent {
  constructor(container) { this.buttonEl = container.createEl('button'); }
  setButtonText(text) { this.buttonEl.text = text; return this; }
  setCta() { return this; }
  setTooltip(text) { this.buttonEl.title = text; return this; }
  setDisabled(value) { this.buttonEl.disabled = value; return this; }
  onClick(handler) { this.buttonEl.click = handler; return this; }
}
export class SearchComponent {
  constructor(container) { this.inputEl = container.createEl('input'); }
  setPlaceholder(text) { this.inputEl.placeholder = text; return this; }
  onChange(handler) { this.inputEl.change = handler; return this; }
}
export class Notice {
  constructor(message, duration) { this.message = message; this.duration = duration; this.messageEl = new TestElement(); }
  setMessage(message) { this.message = message; this.messageEl.setText(message); return this; }
  hide() { this.hidden = true; }
}
export class SecretComponent {
  constructor(_app, container) { this.element = container.createEl('select'); }
  setValue(value) { this.element.value = value; return this; }
  onChange(handler) { this.element.change = handler; return this; }
}
export class SliderComponent {
  constructor(container) { this.sliderEl = container.createEl('input'); }
  setLimits(min, max, step) { Object.assign(this.sliderEl, { min, max, step }); return this; }
  setValue(value) { this.sliderEl.value = value; return this; }
  setDisplayFormat(format) { this.format = format; return this; }
  onChange(handler) { this.sliderEl.change = handler; return this; }
  then(callback) { callback(this); return this; }
}
export class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new TestElement(); }
  update() {}
  refreshDomState() {}
  renderSettingDefinition(definition) {
    const setting = new Setting();
    setting.setName(definition.name ?? '').setDesc(definition.desc ?? '');
    if (definition.control?.type === 'dropdown') setting.addDropdown(dropdown => {
      dropdown.addOptions(definition.control.options).setValue(String(this.getControlValue(definition.control.key)))
        .onChange(value => this.setControlValue(definition.control.key, value));
    });
    if (definition.control?.type === 'slider') setting.addSlider(slider => {
      slider.setLimits(definition.control.min, definition.control.max, definition.control.step)
        .setValue(Number(this.getControlValue(definition.control.key)))
        .onChange(value => this.setControlValue(definition.control.key, value));
    });
    definition.render?.(setting);
    return setting;
  }
}
export class Setting {
  constructor(container) {
    this.settingEl = new TestElement(); this.nameEl = this.settingEl.createDiv('setting-item-name');
    this.descEl = this.settingEl.createDiv('setting-item-description');
    this.controlEl = this.settingEl.createDiv('setting-item-control');
    if (container) container.children.push(this.settingEl);
  }
  setName(value) { this.settingEl.settingName = value; return this; }
  setClass(value) { this.settingEl.addClass(value); return this; }
  setDesc(value) {
    this.description = value;
    if (Array.isArray(value?.children)) { this.descEl.text = value.text ?? ''; this.descEl.children = value.children; }
    else this.descEl.setText(value?.textContent ?? String(value));
    return this;
  }
  addButton(callback) {
    const element = this.controlEl.createEl('button');
    const button = { setButtonText: text => { element.text = text; return button; }, setCta: () => button,
      setDisabled: value => { element.disabled = value; return button; },
      onClick: handler => { element.click = handler; return button; } };
    callback(button); return this;
  }
  addDropdown(callback) {
    const element = this.controlEl.createEl('select');
    const dropdown = {
      selectEl: element,
      addOptions: options => { element.options = options; return dropdown; },
      setValue: value => { element.value = value; return dropdown; },
      onChange: handler => { element.change = handler; return dropdown; },
    };
    callback(dropdown); return this;
  }
  addSlider(callback) { callback(new SliderComponent(this.controlEl)); return this; }
  addText(callback) {
    const element = this.controlEl.createEl('input');
    const text = { inputEl: element, setValue: value => { element.value = value; return text; },
      onChange: handler => { element.change = value => { element.value = String(value); handler(value); }; return text; } };
    callback(text); return this;
  }
  addTextArea(callback) {
    const element = this.controlEl.createEl('textarea');
    const text = { inputEl: element, setValue: value => { element.value = value; return text; },
      setPlaceholder: value => { element.placeholder = value; return text; },
      onChange: handler => { element.change = value => { element.value = String(value); handler(value); }; return text; } };
    callback(text); return this;
  }
  addSearch(callback) {
    const element = this.controlEl.createEl('input');
    const search = { setPlaceholder: text => { element.placeholder = text; return search; },
      onChange: handler => { element.change = handler; return search; } };
    callback(search); return this;
  }
}
export function getAllTags() { return {}; }
export function getTags() { return []; }
export function setIcon(element, icon) { element.icon = icon; }
export function normalizePath(path) { return path; }
