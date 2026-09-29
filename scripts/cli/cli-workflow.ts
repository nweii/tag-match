// Implements explicit Markdown review and apply workflows for the Node CLI with snapshot guards.
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { Config } from '../../src/config.ts';
import { record } from '../../src/config.ts';
import { suggest, type SuggestionResult, type Transport } from '../../src/client.ts';
import { exclusionRules, isExcluded, normalizeTag, tagKey, type Note, type TagCount } from '../../src/core.ts';
import { addTags, noteMetadata } from '../../src/document.ts';

export interface ReviewPlan {
  status: 'review-ready';
  version: 1;
  note: { path: string; sha256: string; title: string };
  existingTags: string[];
  evaluatedTags: string[];
  proposedTags: { tag: string; probability: number }[];
  result: Omit<SuggestionResult, 'recommended'>;
}

export type ApplyReviewPlan = Pick<ReviewPlan, 'note' | 'existingTags' | 'evaluatedTags'>;

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function noteTarget(path: string): Promise<{ path: string; content: string; note: Note }> {
  if (!path.trim()) throw new Error('Pass a Markdown file with --note PATH.');
  const resolved = await realpath(resolve(path)).catch(() => { throw new Error(`Could not read note: ${path}`); });
  if (extname(resolved).toLowerCase() !== '.md') throw new Error('The --note target must be a Markdown file.');
  const content = await readFile(resolved, 'utf8');
  const metadata = noteMetadata(content);
  return { path: resolved, content, note: { title: basename(resolved, extname(resolved)), body: metadata.body,
    description: metadata.description, existingTags: metadata.tags } };
}

export async function reviewFile(path: string, tags: TagCount[], config: Config, transport: Transport,
  additionalExistingTags: string[] = [],
  signal = new AbortController().signal): Promise<ReviewPlan> {
  const target = await noteTarget(path);
  target.note.existingTags = [...new Set([...target.note.existingTags, ...additionalExistingTags].map(normalizeTag).filter(Boolean))];
  const result = await suggest(target.note, tags, config, transport, signal);
  const { recommended, ...rest } = result;
  return { status: 'review-ready', version: 1, note: { path: target.path, sha256: digest(target.content), title: target.note.title },
    existingTags: target.note.existingTags, evaluatedTags: result.judgments.map(item => item.tag),
    proposedTags: recommended, result: rest };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function parseReviewPlan(value: unknown): ApplyReviewPlan {
  if (!record(value) || value.status !== 'review-ready' || value.version !== 1 || !record(value.note)
    || typeof value.note.path !== 'string' || typeof value.note.sha256 !== 'string'
    || typeof value.note.title !== 'string' || !stringArray(value.existingTags)
    || !stringArray(value.evaluatedTags)
    || !Array.isArray(value.proposedTags) || !record(value.result)) {
    throw new Error('The review plan is invalid. Run review again.');
  }
  return {
    note: { path: value.note.path, sha256: value.note.sha256, title: value.note.title },
    existingTags: value.existingTags,
    evaluatedTags: value.evaluatedTags,
  };
}

export async function applyReviewPlan(plan: ApplyReviewPlan, selectedTags: string[], config: Config,
  signal = new AbortController().signal): Promise<{ status: 'applied' | 'no-op'; path: string; addedTags: string[] }> {
  signal.throwIfAborted();
  if (!Array.isArray(selectedTags) || !selectedTags.every(tag => typeof tag === 'string')) {
    throw new Error('selectedTags must be an array of tag names.');
  }
  const selected = selectedTags.map(normalizeTag);
  if (selected.some(tag => !tag)) throw new Error('Selected tags cannot be empty.');
  if (new Set(selected.map(tagKey)).size !== selected.length) throw new Error('Selected tags must not contain duplicates.');
  const evaluated = new Set(plan.evaluatedTags.map(tagKey));
  const existing = new Set(plan.existingTags.map(tagKey));
  const rules = exclusionRules(config.excludedTags);
  if (selected.some(tag => !evaluated.has(tagKey(tag)))) throw new Error('Every selected tag must come from this review plan.');
  if (selected.some(tag => existing.has(tagKey(tag)))) throw new Error('A selected tag is already on the reviewed note.');
  if (selected.some(tag => isExcluded(tag, rules))) throw new Error('A selected tag is excluded by the current configuration.');

  const resolved = await realpath(resolve(plan.note.path)).catch(() => { throw new Error('Could not read the reviewed note.'); });
  if (resolved !== plan.note.path || extname(resolved).toLowerCase() !== '.md') throw new Error('The reviewed note path no longer matches the plan.');
  const lockPath = `${resolved}.tag-match.lock`;
  const lock = await open(lockPath, 'wx').catch((error: unknown) => {
    if (record(error) && error.code === 'EEXIST') throw new Error('Another Tag Match process is applying changes to this note.');
    throw new Error('Could not create a write lock beside the note.', { cause: error });
  });
  let tempPath: string | undefined;
  try {
    const current = await readFile(resolved, 'utf8');
    if (digest(current) !== plan.note.sha256) throw new Error('The note changed after analysis. Run review again before applying.');
    const next = addTags(current, current, selected, plan.existingTags);
    if (next === current) return { status: 'no-op', path: resolved, addedTags: [] };
    signal.throwIfAborted();
    const details = await stat(resolved);
    tempPath = join(dirname(resolved), `.${basename(resolved)}.tag-match-${randomUUID()}.tmp`);
    const temp = await open(tempPath, 'wx', details.mode);
    try { await temp.writeFile(next, 'utf8'); await temp.sync(); }
    finally { await temp.close(); }
    signal.throwIfAborted();
    const finalSnapshot = await readFile(resolved, 'utf8');
    if (digest(finalSnapshot) !== plan.note.sha256) throw new Error('The note changed while tags were being applied. Run review again.');
    signal.throwIfAborted();
    await rename(tempPath, resolved);
    tempPath = undefined;
  } finally {
    if (tempPath) await unlink(tempPath).catch(() => {});
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
  return { status: 'applied', path: resolved, addedTags: selected };
}

export async function quickApplyFile(path: string, tags: TagCount[], config: Config, transport: Transport,
  additionalExistingTags: string[] = [],
  signal = new AbortController().signal): Promise<{ status: 'applied' | 'no-op'; path: string; addedTags: string[]; result: SuggestionResult }> {
  const plan = await reviewFile(path, tags, config, transport, additionalExistingTags, signal);
  signal.throwIfAborted();
  const applied = await applyReviewPlan(plan, plan.proposedTags.map(item => item.tag), config, signal);
  return { ...applied, result: { ...plan.result, recommended: plan.proposedTags } };
}
