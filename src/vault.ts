// Adapts Obsidian's authoritative tag cache and atomic file updates to the shared core.
import { type App, type TFile, getAllTags } from 'obsidian';
import { type Config } from './config.ts';
import { type Note, type TagCount, tagKey, isExcluded, exclusionRules, parseOnlyTags } from './core.ts';
import { addTags, noteMetadata } from './document.ts';
import { diagnostics } from './diagnostics.ts';

export interface NoteWrite { original: string; written: string }

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
  diagnostics(app)?.capture(file, snapshot);
  const cache = app.metadataCache.getFileCache(file);
  return { snapshot, note: { title: file.basename, body: metadata.body, description: metadata.description,
    existingTags: [...new Set([...metadata.tags, ...(cache ? getAllTags(cache) ?? [] : [])])] } };
}

export async function applySuggestions(app: App, file: TFile, snapshot: string,
  selected: string[], existingTags: string[], config: Config, signal?: AbortSignal,
  beforeWrite?: (change: NoteWrite) => void): Promise<NoteWrite> {
  signal?.throwIfAborted();
  const explicit = config.poolMode === 'specific' ? parseOnlyTags(config.onlyTags) : [];
  const vocabulary = new Set(config.poolMode === 'specific' ? explicit.map(tagKey) : inventory(app).map(item => tagKey(item.tag)));
  const rules = config.poolMode === 'specific' ? [] : exclusionRules(config.excludedTags);
  if (selected.some(tag => !vocabulary.has(tagKey(tag)) || isExcluded(tag, rules))) {
    throw new Error('The tag vocabulary or exclusions changed. Run tagging again.');
  }
  let original = snapshot;
  let observed: string | undefined;
  try {
    const written = await app.vault.process(file, content => {
      observed = content;
      signal?.throwIfAborted();
      const written = addTags(content, snapshot, selected, existingTags);
      beforeWrite?.({ original: content, written });
      original = content;
      return written;
    });
    diagnostics(app)?.apply(file, snapshot, observed, true);
    return { original, written };
  } catch (error) {
    diagnostics(app)?.apply(file, snapshot, observed, false);
    throw error;
  }
}
