// Discovers and tags batches of Markdown notes, with offline previews and durable snapshot-checked undo.
import { createHash } from 'node:crypto';
import { open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { record, type Config } from '../../src/config.ts';
import { buildBatches, normalizeTag, noteSeed, selectCandidates, type TagCount } from '../../src/core.ts';
import { suggest, type Transport, type Progress } from '../../src/client.ts';
import { resolveProvider } from '../../src/provider.ts';
import { MAX_BULK_RECOVERY_CHARACTERS, runBulkQueue, stopsBulkRun } from '../../src/bulk-queue.ts';
import { applyReviewPlan, noteTarget, writeNoteSnapshot, type ReviewPlan } from './cli-workflow.ts';

export interface BulkTarget { path: string; existingTags: string[]; modified: number; created: number }
export type BulkStatus = 'pending' | 'previewed' | 'ready' | 'unchanged' | 'applied' | 'failed' | 'skipped' | 'cancelled' | 'undone';
export interface CliBulkItem {
  path: string; status: BulkStatus; addedTags: string[]; message?: string;
  preview?: { candidateTags: string[]; requests: number; sentChars: number; truncated: boolean };
  plan?: ReviewPlan;
}
export interface BulkOptions {
  mode: 'dry-run' | 'suggest' | 'apply'; concurrency: number; recoveryPath?: string;
  signal: AbortSignal;
  onProgress?: (event: { path: string; status?: BulkStatus; complete?: number; total?: number; scoring?: Progress }) => void;
}

const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const message = (error: unknown) => error instanceof Error ? error.message : 'Tagging could not be completed.';

/** Folders recurse; explicit note exclusions and search only narrow the selected batch. */
export async function bulkTargets(input: unknown, sort: string, reverse: boolean, search = ''): Promise<BulkTarget[]> {
  if (!record(input) || !Array.isArray(input.notes ?? []) || !strings(input.folders ?? []) || !strings(input.excludeNotes ?? [])) {
    throw new Error('Bulk input needs notes and/or folders, with optional excludeNotes arrays.');
  }
  const notes = (input.notes ?? []) as unknown[];
  const selected = new Map<string, BulkTarget>();
  const excluded = new Set(await Promise.all(((input.excludeNotes ?? []) as string[]).map(path => realpath(resolve(path)))));
  const add = async (path: string, existingTags: string[] = []) => {
    const canonical = await realpath(resolve(path));
    if (extname(canonical).toLowerCase() !== '.md') throw new Error(`Not a Markdown note: ${path}`);
    const details = await stat(canonical);
    if (!details.isFile()) throw new Error(`Not a file: ${path}`);
    if (excluded.has(canonical)) return;
    const previous = selected.get(canonical);
    selected.set(canonical, { path: canonical, existingTags: [...new Set([...(previous?.existingTags ?? []), ...existingTags])],
      modified: details.mtimeMs, created: details.birthtimeMs || details.ctimeMs });
  };
  const walk = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = resolve(path, entry.name);
      // Do not follow directory symlinks, which can escape a selected folder or create loops.
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') await add(child);
    }
  };
  for (const folder of (input.folders ?? []) as string[]) await walk(await realpath(resolve(folder)));
  for (const note of notes) {
    if (typeof note === 'string') await add(note);
    else if (record(note) && typeof note.path === 'string' && strings(note.existingTags ?? [])) await add(note.path, (note.existingTags ?? []) as string[]);
    else throw new Error('Each note must be a path or {path, existingTags}.');
  }
  const query = search.toLowerCase();
  const targets = [...selected.values()].filter(item => item.path.toLowerCase().includes(query));
  const alphabetical = (a: BulkTarget, b: BulkTarget) => basename(a.path).localeCompare(basename(b.path), undefined, { numeric: true, sensitivity: 'base' }) || a.path.localeCompare(b.path);
  targets.sort((a, b) => (sort === 'alphabetical' ? alphabetical(a, b)
    : b[sort as 'modified' | 'created'] - a[sort as 'modified' | 'created'] || alphabetical(a, b)) * (reverse ? -1 : 1));
  if (!targets.length) throw new Error('No Markdown notes selected.');
  return targets;
}

class RecoveryLimitError extends Error {
  constructor() { super('Undo storage limit reached. Tag the remaining notes in a smaller batch.'); }
}
class RecoveryWriteError extends Error {
  constructor(cause: unknown) { super('Could not save undo information. The batch stopped before further writes.', { cause }); }
}

/** Journal entries are flushed before the corresponding note write, making interrupted writes recoverable. */
async function recoveryWriter(path: string) {
  const file = await open(resolve(path), 'wx', 0o600);
  let queue = Promise.resolve();
  const append = (entry: unknown) => {
    const next = queue.then(async () => { await file.writeFile(`${JSON.stringify(entry)}\n`); await file.sync(); })
      .catch((error: unknown) => { throw error instanceof RecoveryWriteError ? error : new RecoveryWriteError(error); });
    queue = next;
    return next;
  };
  try { await append({ type: 'tag-match-recovery', version: 1 }); }
  catch (error) { await file.close(); throw error; }
  // A failed append is already a batch outcome; closing must preserve that report.
  return { append, close: async () => { await queue.catch(() => {}); await file.close(); } };
}

export async function runCliBulk(targets: BulkTarget[], tags: TagCount[], config: Config, transport: Transport, options: BulkOptions) {
  const settings = { ...config };
  const inventory = tags.map(tag => ({ ...tag }));
  const items: CliBulkItem[] = targets.map(target => ({ path: target.path, status: 'pending', addedTags: [] }));
  const targetByPath = new Map(targets.map(target => [target.path, target]));
  if (options.mode === 'apply' && !options.recoveryPath) throw new Error('Bulk writes require --recovery PATH for undo.');
  const journal = options.mode === 'apply' ? await recoveryWriter(options.recoveryPath!) : undefined;
  let recoveryCharacters = 0;
  try {
    await runBulkQueue(items, {
      signal: options.signal, concurrency: options.concurrency,
      shouldStop: error => error instanceof RecoveryLimitError || error instanceof RecoveryWriteError || stopsBulkRun(error),
      run: async (item, signal) => {
        const target = targetByPath.get(item.path)!;
        const captured = await noteTarget(item.path);
        captured.note.existingTags = [...new Set([...captured.note.existingTags, ...target.existingTags].map(normalizeTag).filter(Boolean))];
        signal.throwIfAborted();
        const pool = selectCandidates(inventory, captured.note.existingTags, settings, noteSeed(captured.note));
        const prepared = buildBatches(captured.note, pool, settings);
        item.preview = { candidateTags: pool.tags.map(tag => tag.tag), requests: prepared.batches.length,
          sentChars: prepared.sentChars, truncated: prepared.truncated };
        if (options.mode === 'dry-run') { item.status = 'previewed'; return; }
        let reservation = 0;
        if (journal) {
          reservation = captured.content.length * 2;
          if (recoveryCharacters + reservation > MAX_BULK_RECOVERY_CHARACTERS) throw new RecoveryLimitError();
          recoveryCharacters += reservation;
        }
        try {
          const result = await suggest(captured.note, inventory, settings, transport, signal,
            scoring => options.onProgress?.({ path: item.path, scoring }), pool);
          signal.throwIfAborted();
          const { recommended, ...rest } = result;
          const plan: ReviewPlan = { status: 'review-ready', version: 1,
            note: { path: captured.path, sha256: hash(captured.content), title: captured.note.title },
            existingTags: captured.note.existingTags, evaluatedTags: result.judgments.map(tag => tag.tag), proposedTags: recommended, result: rest };
          if (options.mode === 'suggest') { item.plan = plan; item.status = recommended.length ? 'ready' : 'unchanged'; return; }
          const added = recommended.map(tag => tag.tag);
          const applied = await applyReviewPlan(plan, added, settings, signal, async (path, original, written) => {
            const extra = written.length - original.length;
            if (recoveryCharacters + extra > MAX_BULK_RECOVERY_CHARACTERS) throw new RecoveryLimitError();
            recoveryCharacters += extra; reservation += extra;
            await journal!.append({ path, original, writtenHash: hash(written), addedTags: added });
          });
          item.status = applied.status === 'no-op' ? 'unchanged' : 'applied';
          item.addedTags = applied.addedTags;
        } finally {
          if (item.status !== 'applied') recoveryCharacters -= reservation;
        }
      },
      onError: (item, error, context) => {
        item.status = context.cancelled ? 'cancelled' : context.stopped ? 'skipped'
          : message(error).startsWith('The note changed') || message(error).startsWith('The reviewed note path') ? 'skipped' : 'failed';
        item.message = context.cancelled ? 'Cancelled before tags were added.' : context.stopped
          ? `Not applied because the run stopped. ${context.stopped}` : message(error);
      },
      onSkipped: (item, context) => {
        item.status = context.cancelled ? 'cancelled' : 'skipped';
        item.message = context.cancelled ? 'Cancelled before analysis.' : `Not analyzed because the run stopped. ${context.stopped}`;
      },
      onSettled: (item, complete, total) => options.onProgress?.({ path: item.path, status: item.status, complete, total }),
    });
  } finally { await journal?.close(); }
  return bulkOutput(items, settings, options.mode, options.signal.aborted, options.recoveryPath);
}

function bulkSummary(items: CliBulkItem[]) {
  return Object.fromEntries(['previewed', 'ready', 'unchanged', 'applied', 'failed', 'skipped', 'cancelled', 'undone']
    .map(status => [status, items.filter(item => item.status === status).length]));
}

export function bulkOutput(items: CliBulkItem[], config: Config, mode: string, cancelled: boolean, recoveryPath?: string) {
  const provider = resolveProvider(config);
  const { apiKey: _key, openRouterApiKey: _routerKey, typeSafeSecretId: _secret, openRouterSecretId: _routerSecret, ...settings } = config;
  const summary = bulkSummary(items);
  return { status: cancelled ? 'cancelled' : summary.failed || summary.skipped ? 'partial' : 'complete', mode,
    provider: provider.label, model: provider.model, settings,
    total: items.length, summary, estimatedRequests: items.reduce((total, item) => total + (item.preview?.requests ?? 0), 0),
    ...(recoveryPath ? { recoveryPath: resolve(recoveryPath) } : {}), results: items };
}

export async function undoCliBulk(path: string, apply: boolean, signal: AbortSignal) {
  if ((await stat(path)).size > MAX_BULK_RECOVERY_CHARACTERS * 4) throw new Error('Recovery file exceeds the supported size.');
  const text = await readFile(path, 'utf8');
  if (text.length > MAX_BULK_RECOVERY_CHARACTERS * 4) throw new Error('Recovery file exceeds the supported size.');
  // An interrupted append can leave a partial final line; only flushed, newline-terminated entries authorize undo.
  const lines = text.split('\n');
  lines.pop();
  const entries = lines.map(line => JSON.parse(line) as unknown);
  const header = entries.shift();
  if (!record(header) || header.type !== 'tag-match-recovery' || header.version !== 1) throw new Error('Not a Tag Match recovery file.');
  const records = entries.map(entry => {
    if (!record(entry) || typeof entry.path !== 'string' || typeof entry.original !== 'string'
      || typeof entry.writtenHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.writtenHash) || !strings(entry.addedTags)) throw new Error('Invalid recovery entry.');
    return { path: entry.path, original: entry.original, writtenHash: entry.writtenHash, addedTags: entry.addedTags };
  });
  if (new Set(records.map(entry => entry.path)).size !== records.length) throw new Error('Recovery contains duplicate note paths.');
  const items: CliBulkItem[] = [];
  const cancelled = () => signal.aborted;
  for (const entry of records) {
    const item: CliBulkItem = { path: entry.path, status: 'pending', addedTags: [] };
    items.push(item);
    if (cancelled()) { item.status = 'cancelled'; continue; }
    try {
      const target = await noteTarget(entry.path);
      if (target.path !== entry.path) throw new Error('The note path changed.');
      if (hash(target.content) === hash(entry.original)) { item.status = 'unchanged'; continue; }
      if (hash(target.content) !== entry.writtenHash) { item.status = 'skipped'; item.message = 'The note changed after tagging. Undo skipped to preserve those edits.'; continue; }
      if (apply) await writeNoteSnapshot(entry.path, entry.writtenHash, () => entry.original, signal);
      item.status = apply ? 'undone' : 'ready';
    } catch (error) {
      item.status = cancelled() ? 'cancelled' : message(error).startsWith('The note changed') || message(error).startsWith('The note path changed') ? 'skipped' : 'failed';
      item.message = message(error);
    }
  }
  return { status: signal.aborted ? 'cancelled' : items.some(item => ['failed', 'skipped'].includes(item.status)) ? 'partial' : 'complete',
    mode: apply ? 'undo' : 'dry-run', total: items.length, summary: bulkSummary(items), results: items };
}
