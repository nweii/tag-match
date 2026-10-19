// Retains bounded development diagnostics in device-local Obsidian storage without note text or filenames.
import type { App, TFile } from 'obsidian';
import { record } from './config.ts';
import { noteMetadata, splitDocument } from './document.ts';

const STORAGE_KEY = 'tag-match-dev:diagnostics';
export const DIAGNOSTIC_LIMIT = 120;
const changeFields = ['raw', 'body', 'description', 'tags', 'frontmatter'] as const;
type Changes = Record<typeof changeFields[number], boolean | null>;
interface DiagnosticEvent {
  time: string;
  build: string;
  noteId: string;
  action: 'captured' | 'applied' | 'apply-failed';
  snapshotCharacters: number;
  currentCharacters: number | null;
  changed: Changes;
}

function parseEvent(value: unknown): DiagnosticEvent | null {
  if (!record(value) || typeof value.time !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value.time)
    || typeof value.build !== 'string' || !/^(?:[a-f\d]{7,40}\+?|unknown)$/.test(value.build)
    || typeof value.noteId !== 'string' || !/^[a-f\d-]{36}$/.test(value.noteId)
    || typeof value.snapshotCharacters !== 'number' || !Number.isSafeInteger(value.snapshotCharacters) || value.snapshotCharacters < 0
    || !(value.currentCharacters === null || typeof value.currentCharacters === 'number'
      && Number.isSafeInteger(value.currentCharacters) && value.currentCharacters >= 0)
    || !record(value.changed)) return null;
  const action = value.action;
  if (action !== 'captured' && action !== 'applied' && action !== 'apply-failed') return null;
  const changed: Changes = { raw: null, body: null, description: null, tags: null, frontmatter: null };
  for (const field of changeFields) {
    const flag = value.changed[field];
    if (flag !== null && typeof flag !== 'boolean') return null;
    changed[field] = flag;
  }
  return { time: value.time, build: value.build, noteId: value.noteId, action,
    snapshotCharacters: value.snapshotCharacters, currentCharacters: value.currentCharacters, changed };
}

function changes(snapshot: string, current?: string): Changes {
  const changed: Changes = { raw: null, body: null, description: null, tags: null, frontmatter: null };
  if (current === undefined) return changed;
  changed.raw = snapshot !== current;
  const before = splitDocument(snapshot);
  const after = splitDocument(current);
  changed.body = before.body !== after.body;
  changed.frontmatter = before.frontmatter !== after.frontmatter;
  try {
    const expected = noteMetadata(snapshot);
    const actual = noteMetadata(current);
    changed.description = expected.description !== actual.description;
    changed.tags = JSON.stringify(expected.tags) !== JSON.stringify(actual.tags);
  } catch { /* Invalid metadata leaves these comparisons unknown. */ }
  return changed;
}

export class DiagnosticLog {
  private events: DiagnosticEvent[] = [];
  private noteIds = new WeakMap<TFile, string>();
  private persisted = true;
  private app: Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>;
  private build: string;

  constructor(app: Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>, build: string) {
    this.app = app;
    this.build = build;
    try {
      const saved: unknown = app.loadLocalStorage(STORAGE_KEY);
      if (Array.isArray(saved)) this.events = saved.slice(-DIAGNOSTIC_LIMIT)
        .map((value: unknown) => parseEvent(value)).filter((value): value is DiagnosticEvent => value !== null);
    } catch { this.persisted = false; }
  }

  capture(file: TFile, snapshot: string): void {
    this.append(file, 'captured', snapshot);
  }

  apply(file: TFile, snapshot: string, current: string | undefined, succeeded: boolean): void {
    this.append(file, succeeded ? 'applied' : 'apply-failed', snapshot, current);
  }

  private append(file: TFile, action: DiagnosticEvent['action'], snapshot: string, current?: string): void {
    let noteId = this.noteIds.get(file);
    if (!noteId) { noteId = crypto.randomUUID(); this.noteIds.set(file, noteId); }
    this.events.push({ time: new Date().toISOString(), build: this.build, noteId, action,
      snapshotCharacters: snapshot.length, currentCharacters: current?.length ?? null, changed: changes(snapshot, current) });
    this.events = this.events.slice(-DIAGNOSTIC_LIMIT);
    try { this.app.saveLocalStorage(STORAGE_KEY, this.events); this.persisted = true; }
    catch { this.persisted = false; }
  }

  export(): string {
    return JSON.stringify({ schema: 1, storage: this.persisted ? 'device-local' : 'memory-only', events: this.events }, null, 2);
  }
}

const logs = new WeakMap<App, DiagnosticLog>();

export function enableDiagnostics(app: App, build: string): DiagnosticLog {
  const log = new DiagnosticLog(app, build);
  logs.set(app, log);
  return log;
}

export function diagnostics(app: App): DiagnosticLog | undefined {
  return logs.get(app);
}
