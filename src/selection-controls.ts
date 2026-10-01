// Renders temporary candidate-selection controls shared by note reviews and bulk tagging.
import { Setting } from 'obsidian';
import type { Config } from './config.ts';
import { parseOnlyTags } from './core.ts';

let numericControlId = 0;

export function wholeNumber(value: string, maximum: number): boolean {
  return value.trim() !== '' && Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= maximum;
}

/** Keeps invalid text visible and described instead of silently using the last valid value. */
export function renderWholeNumber(container: HTMLElement, value: number, name: string, maximum: number,
  change: (value?: number) => void): HTMLInputElement {
  const setting = new Setting(container).setName(name).setClass('tag-match-setting-centered');
  setting.descEl.id = `tag-match-number-${++numericControlId}`;
  let input!: HTMLInputElement;
  setting.addText(text => {
    input = text.inputEl;
    input.type = 'number'; input.min = '1'; input.max = String(maximum); input.step = '1';
    input.setAttribute('aria-label', name);
    input.setAttribute('aria-describedby', setting.descEl.id);
    text.setValue(String(value)).onChange(raw => {
      const valid = wholeNumber(raw, maximum);
      input.setAttribute('aria-invalid', String(!valid));
      setting.setDesc(valid ? '' : `Enter a whole number from 1 to ${maximum.toLocaleString()}.`);
      change(valid ? Number(raw) : undefined);
    });
  });
  return input;
}

export function renderSelectionControls(container: HTMLElement, config: Config, includeMinimum: boolean,
  update: (patch: Partial<Config>, rebuild?: boolean) => void) {
  const numbers: HTMLInputElement[] = [];
  const mode = config.poolMode;
  new Setting(container).setName('Selection method').setClass('tag-match-setting-centered').addDropdown(dropdown => {
    dropdown.selectEl.setAttribute('aria-label', 'Selection method');
    dropdown.addOptions({ auto: 'Default', all: 'All tags', percent: 'Percentage', count: 'Number', specific: 'Only these tags',
      ...(includeMinimum ? { minimum: 'Tags used at least X times' } : {}),
    }).setValue(mode).onChange(value => update({ poolMode: value as Config['poolMode'] }, true));
  });
  if (mode === 'specific') {
    const only = new Setting(container).setName('Tags').setClass('tag-match-tag-constraint');
    only.descEl.id = `tag-match-tags-${++numericControlId}`;
    let input!: HTMLTextAreaElement;
    const valid = () => {
      try { return !!parseOnlyTags(input.value).length; }
      catch { return false; }
    };
    only.addTextArea(text => {
      input = text.inputEl;
      input.rows = 3;
      input.setAttribute('aria-label', 'Tags');
      input.setAttribute('aria-describedby', only.descEl.id);
      text.setPlaceholder('#Research, #writing').setValue(config.onlyTags).onChange(value => {
        let error = '';
        try { if (!parseOnlyTags(value).length) error = 'Enter at least one tag.'; }
        catch (cause) { error = cause instanceof Error ? cause.message : 'Enter valid tag names.'; }
        input.setAttribute('aria-invalid', String(!!error));
        only.setDesc(error);
        update({ onlyTags: value });
      });
    });
    return valid;
  }
  if (mode === 'percent') new Setting(container).setName('Selection size').setDesc('Share of all tags').addSlider(slider => {
    slider.sliderEl.setAttribute('aria-label', 'Selection size, percentage of available tags');
    slider.setLimits(1, 100, 1).setValue(config.poolPercent).setDisplayFormat(value => `${value}%`)
      .onChange(value => update({ poolPercent: value }));
  });
  const whole = (key: 'poolCount' | 'minimumUses', name: string) => {
    numbers.push(renderWholeNumber(container, config[key], name, 1000000, value => update(value === undefined ? {} : { [key]: value })));
  };
  if (mode === 'count') whole('poolCount', 'Selection size');
  if (mode === 'minimum') whole('minimumUses', 'Minimum uses');
  if (['auto', 'percent', 'count'].includes(mode)) {
    const mixLabel = (value: number) => `Most-used ${value}% · sampled ${100 - value}%`;
    const mix = new Setting(container).setName('Selection mix').setDesc(mixLabel(config.mostUsedPercent));
    mix.addSlider(slider => {
      slider.sliderEl.setAttribute('aria-label', 'Selection mix, most-used percentage');
      slider.setLimits(0, 100, 1).setValue(config.mostUsedPercent).setDisplayFormat(() => '').onChange(value => {
        mix.setDesc(mixLabel(value)); update({ mostUsedPercent: value });
      });
    });
  }
  new Setting(container).setName('Excluded tags').setClass('tag-match-tag-constraint').addTextArea(text => {
    text.inputEl.rows = 3;
    text.inputEl.setAttribute('aria-label', 'Excluded tags');
    text.setPlaceholder('#Admin, #work/*').setValue(config.excludedTags).onChange(value => update({ excludedTags: value }));
  });
  return () => numbers.every(input => wholeNumber(input.value, 1000000));
}
