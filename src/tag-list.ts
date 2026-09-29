// Renders the paged tag rows and status labels shared by the review results and the vault tag browser.
import type { CandidateInspection } from './core.ts';

export const PAGE_SIZE = 100;

export function useCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'use' : 'uses'}`;
}

/** Labels why a tag is or is not part of a selection; `scored` switches the wording once analysis has run. */
export function inspectionLabel(item: CandidateInspection, scored = false): string {
  if (item.status === 'excluded') return 'Excluded';
  if (item.status === 'already-present') return 'On this note';
  if (scored) return 'Not scored';
  if (item.status === 'outside-pool') return 'Not selected';
  if (item.reason === 'discovery') return 'Sampled';
  if (item.reason === 'frequent') return 'Most-used';
  return 'Selected';
}

export function renderInspectionRows(rows: HTMLElement, items: CandidateInspection[], limit: number, onMore: () => void) {
  rows.empty();
  for (const item of items.slice(0, limit)) {
    const row = rows.createDiv({ cls: item.status === 'included' ? 'tag-match-row' : 'tag-match-row tag-match-row-unavailable' });
    const name = row.createSpan({ cls: 'tag-match-row-name', text: `#${item.tag}` });
    name.createSpan({ cls: 'tag-match-row-uses', text: ` ${useCount(item.count)}` });
    row.createSpan({ cls: 'tag-match-row-meta', text: inspectionLabel(item) });
  }
  listEnd(rows, items.length, Math.min(items.length, limit), onMore);
}

/** Ends a list with an empty state or a control that reveals the next page. */
export function listEnd(rows: HTMLElement, total: number, shown: number, onMore: () => void) {
  if (!total) { rows.createDiv({ cls: 'tag-match-list-note', text: 'No matching tags.' }); return; }
  if (total <= shown) return;
  const next = Math.min(PAGE_SIZE, total - shown);
  const more = rows.createEl('button', { cls: 'tag-match-list-more', text: `Show ${next.toLocaleString()} more` });
  more.createSpan({ cls: 'tag-match-detail', text: ` · ${shown.toLocaleString()} of ${total.toLocaleString()} shown` });
  more.addEventListener('click', onMore);
}
