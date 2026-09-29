// Adapts Obsidian's authoritative tag cache and atomic file updates to the shared core.
import { type App, type TFile, getAllTags } from 'obsidian';
import { type Config } from './config.ts';
import { type Note, type TagCount, tagKey, isExcluded, exclusionRules } from './core.ts';
import { addTags, noteMetadata } from './document.ts';

export function inventory(app: App): TagCount[] {
  const cache = app.metadataCache as typeof app.metadataCache & { getTags?: () => Record<string, number> };
  if (cache.getTags) return Object.entries(cache.getTags()).map(([tag, count]) => ({ tag, count }));
  const counts = new Map<string, number>();
  for (const file of app.vault.getMarkdownFiles()) {
    const metadata = app.metadataCache.getFileCache(file);
    for (const tag of metadata ? getAllTags(metadata) ?? [] : []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts].map(([tag, count]) => ({ tag, count }));
}

export async function readNote(app: App, file: TFile): Promise<{ note: Note; snapshot: string }> {
  const snapshot = await app.vault.read(file);
  const metadata = noteMetadata(snapshot);
  const cache = app.metadataCache.getFileCache(file);
  return { snapshot, note: { title: file.basename, body: metadata.body, description: metadata.description,
    existingTags: [...new Set([...metadata.tags, ...(cache ? getAllTags(cache) ?? [] : [])])] } };
}

export async function applySuggestions(app: App, file: TFile, snapshot: string,
  selected: string[], existingTags: string[], config: Config): Promise<void> {
  const vocabulary = new Set(inventory(app).map(item => tagKey(item.tag)));
  const rules = exclusionRules(config.excludedTags);
  if (selected.some(tag => !vocabulary.has(tagKey(tag)) || isExcluded(tag, rules))) {
    throw new Error('The tag vocabulary or exclusions changed. Run tagging again.');
  }
  await app.vault.process(file, content => addTags(content, snapshot, selected, existingTags));
}
