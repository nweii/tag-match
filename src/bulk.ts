// Runs bounded parallel note tagging from one settings and vocabulary snapshot, with isolated failures and safe undo.
import type { App, TFile } from 'obsidian';
import type { Config } from './config.ts';
import type { Note, TagCount } from './core.ts';
import { ProviderRequestError, suggest, type Progress, type SuggestionResult, type Transport } from './client.ts';
import { resolveProvider } from './provider.ts';
import { applySuggestions, readNote } from './vault.ts';
import { addTags } from './document.ts';
import { MAX_BULK_RECOVERY_CHARACTERS, runBulkQueue, stopsBulkRun } from './bulk-queue.ts';

export { MAX_BULK_RECOVERY_CHARACTERS } from './bulk-queue.ts';
class BulkRecoveryLimitError extends Error {
  constructor() { super('Undo storage limit reached. Keep or undo completed additions, then tag the remaining notes in a smaller batch.'); }
}

export interface BulkItem {
  file: TFile;
  note?: Note;
  snapshot?: string;
  appliedSnapshot?: string;
  result?: SuggestionResult;
  selected: Set<string>;
  status: 'pending' | 'analyzing' | 'ready' | 'unchanged' | 'applied' | 'failed' | 'skipped' | 'cancelled' | 'undone';
  message?: string;
}

export function createBulkItems(files: TFile[]): BulkItem[] {
  const unique = new Map<string, TFile>();
  for (const file of files) if (file.extension === 'md' && !unique.has(file.path)) unique.set(file.path, file);
  return [...unique.values()].map(file => ({ file, selected: new Set<string>(), status: 'pending' }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Tagging could not be completed.';
}

function cancelled(signal: AbortSignal): boolean {
  // Abort state can change during awaited transport and vault work.
  return signal.aborted;
}

function applicationFailure(item: BulkItem, error: unknown): void {
  item.message = errorMessage(error);
  item.status = item.message.startsWith('The note changed after analysis.')
    || item.message.startsWith('The tag vocabulary or exclusions changed.') ? 'skipped' : 'failed';
}

export async function applyBulkItem(app: App, item: BulkItem, config: Config, signal: AbortSignal): Promise<void> {
  if (item.appliedSnapshot !== undefined || item.status === 'undone') return;
  if (cancelled(signal)) { item.status = 'cancelled'; return; }
  // Failed or incomplete analysis must never expose partial results as writable suggestions.
  if (!item.result || !item.note || item.snapshot === undefined
    || !['ready', 'unchanged'].includes(item.status)) return;
  if (!item.selected.size) { item.status = 'unchanged'; return; }
  try {
    const written = await applySuggestions(app, item.file, item.snapshot, [...item.selected],
      item.note.existingTags, config, signal);
    // process returns the exact committed content, so later edits cannot enter the undo snapshot.
    item.appliedSnapshot = written;
    item.status = written === item.snapshot ? 'unchanged' : 'applied';
    item.message = undefined;
  } catch (error) {
    if (cancelled(signal)) { item.status = 'cancelled'; item.message = 'Cancelled before tags were added.'; }
    else applicationFailure(item, error);
  }
}

export async function undoBulkItem(app: App, item: BulkItem, signal?: AbortSignal): Promise<void> {
  if (item.status !== 'applied' || item.snapshot === undefined || item.appliedSnapshot === undefined) return;
  if (signal?.aborted) return;
  const original = item.snapshot;
  const applied = item.appliedSnapshot;
  try {
    await app.vault.process(item.file, content => {
      signal?.throwIfAborted();
      if (content !== applied) throw new Error('The note changed after tags were added. Undo was skipped to preserve those edits.');
      return original;
    });
    item.status = 'undone';
    item.message = undefined;
  } catch (error) {
    if (signal?.aborted) return;
    const message = errorMessage(error);
    // An edited note is deliberately left alone; a temporary write failure keeps undo retryable.
    if (message.startsWith('The note changed after tags were added.')) {
      item.status = 'skipped'; item.message = message;
    } else item.message = `Undo failed. Check that this note can be written, then try Undo additions again. ${message}`;
  }
}

/** Exports outcomes and run settings without note bodies, recovery snapshots, or credentials. */
export function bulkReport(items: BulkItem[], config: Config): string {
  const provider = resolveProvider(config);
  return JSON.stringify({ provider: provider.label, model: provider.model,
    settings: { poolMode: config.poolMode, poolPercent: config.poolPercent, poolCount: config.poolCount,
      minimumUses: config.minimumUses, mostUsedPercent: config.mostUsedPercent,
      onlyTags: config.onlyTags, excludedTags: config.excludedTags,
      minProbability: config.minProbability, maxTagsToAdd: config.maxTagsToAdd },
    results: items.map(item => ({ path: item.file.path, status: item.status,
      addedTags: item.appliedSnapshot !== undefined && item.appliedSnapshot !== item.snapshot ? [...item.selected] : [], message: item.message })),
  }, null, 2);
}

export async function analyzeBulkItems(app: App, items: BulkItem[], config: Config, tags: TagCount[],
  transport: Transport, signal: AbortSignal, direct: boolean,
  onUpdate: (item: BulkItem, complete: number, total: number) => void,
  onNoteProgress: (file: TFile, progress: Progress) => void = () => {}, concurrency = 1): Promise<void> {
  const analysisConfig = { ...config };
  const inventory = tags.map(tag => ({ ...tag }));
  const queued = items.filter(item => item.status === 'pending');
  const provider = resolveProvider(analysisConfig);
  const credentialError = provider.apiKey.trim() ? undefined
    : new ProviderRequestError(`Add your ${provider.label} API key in Tag Match settings.`, 401);
  let recoveryCharacters = 0;
  await runBulkQueue(queued, {
    signal, concurrency,
    shouldStop: error => error instanceof BulkRecoveryLimitError || stopsBulkRun(error),
    run: async (item, workSignal) => {
      let reservation = 0;
      try {
        if (credentialError) throw credentialError;
        item.status = 'analyzing';
        const captured = await readNote(app, item.file);
        workSignal.throwIfAborted();
        if (direct && recoveryCharacters + captured.snapshot.length * 2 > MAX_BULK_RECOVERY_CHARACTERS) {
          throw new BulkRecoveryLimitError();
        }
        if (direct) {
          // Reserve recovery space before awaiting a request so concurrent notes cannot oversubscribe it.
          reservation = captured.snapshot.length * 2;
          recoveryCharacters += reservation;
        }
        item.note = captured.note;
        item.snapshot = captured.snapshot;
        const result = await suggest(captured.note, inventory, analysisConfig, transport, workSignal,
          progress => onNoteProgress(item.file, progress));
        workSignal.throwIfAborted();
        item.result = result;
        item.selected = new Set(result.recommended.map(tag => tag.tag));
        item.status = item.selected.size ? 'ready' : 'unchanged';
        if (direct) {
          if (item.selected.size) {
            const proposed = addTags(captured.snapshot, captured.snapshot, [...item.selected], captured.note.existingTags);
            if (recoveryCharacters + proposed.length - captured.snapshot.length > MAX_BULK_RECOVERY_CHARACTERS) {
              throw new BulkRecoveryLimitError();
            }
            const extra = proposed.length - captured.snapshot.length;
            reservation += extra;
            recoveryCharacters += extra;
          }
          await applyBulkItem(app, item, analysisConfig, workSignal);
          // Another worker can halt the run during awaited transport or vault work.
          if (['cancelled'].includes(item.status)) workSignal.throwIfAborted();
        }
      } finally {
        // Direct runs retain additions and exact content for undo, rather than every tag judgment and sampled body.
        if (direct) {
          item.note = undefined;
          item.result = undefined;
          if (item.appliedSnapshot === undefined || item.appliedSnapshot === item.snapshot) {
            recoveryCharacters -= reservation;
            item.snapshot = undefined; item.appliedSnapshot = undefined;
          }
        }
      }
    },
    onError: (item, error, context) => {
      const applying = item.status === 'cancelled';
      item.status = context.cancelled ? 'cancelled' : context.stopped !== undefined ? 'skipped' : 'failed';
      item.message = context.cancelled ? applying ? 'Cancelled before tags were added.' : 'Cancelled during analysis.'
        : context.stopped !== undefined ? `${applying ? 'Not applied' : 'Not analyzed'} because the run stopped. ${context.stopped}`
          : errorMessage(error);
    },
    onSkipped: (item, context) => {
      item.status = context.cancelled ? 'cancelled' : 'skipped';
      item.message = context.cancelled ? 'Cancelled before analysis.'
        : `Not analyzed because the run stopped. ${context.stopped ?? 'The batch was stopped.'}`;
    },
    onSettled: onUpdate,
  });
}
