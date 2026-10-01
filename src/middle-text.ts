// Keeps both ends of long names visible without changing the surrounding row height.
export function renderMiddleText(container: HTMLElement, text: string, cls = ''): HTMLElement {
  const element = container.createSpan({ cls: `tag-match-middle-text ${cls}`.trim(), attr: { title: text } });
  const characters = [...text];
  const middle = Math.ceil(characters.length / 2);
  element.createSpan({ cls: 'tag-match-middle-start', text: characters.slice(0, middle).join('') });
  element.createSpan({ cls: 'tag-match-middle-end' }).createSpan({ text: characters.slice(middle).join('') });
  return element;
}
