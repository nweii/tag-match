// Exposes shared Jev tag suggestion, review, and application as a JSON-only command-line interface.
import { readFile } from 'node:fs/promises';
import { stdin, stdout, stderr, argv } from 'node:process';
import { normalizeConfig, record, type Config } from '../../src/config.ts';
import { suggest, type HttpResponse, type Transport } from '../../src/client.ts';
import { buildBatches, noteSeed, selectCandidates, type Note, type TagCount } from '../../src/core.ts';
import { applyReviewPlan, parseReviewPlan, quickApplyFile, reviewFile } from './cli-workflow.ts';
import { resolveCliCredential } from './credentials.ts';
import { withOverrides } from './cli-overrides.ts';
import { bulkTargets, runCliBulk, undoCliBulk } from './cli-bulk.ts';

declare const __TAG_MATCH_VERSION__: string;
export const CLI_VERSION = typeof __TAG_MATCH_VERSION__ === 'string' ? __TAG_MATCH_VERSION__ : '0.0.0-test';

const HELP = `Usage: tag-match <command> --config PATH

Commands:
  preview   Report tag selection without using the network
  suggest   Evaluate selected tags with the saved Jev provider
  review    Analyze a Markdown file and return a review plan without writing
  apply     Apply explicit selections from a review plan without using the network
  quick-apply  Analyze a Markdown file and add complete recommendations directly
  bulk      Preview, suggest, or apply tags to multiple Markdown notes
  bulk-undo  Preview or undo additions recorded by bulk --apply

Per-run options (do not change saved settings):
  --only-tags TEXT   Use only these comma- or newline-separated tags, including new tags
  --exclude-tags TEXT  Exclude tags or branches such as work/* (ignored with --only-tags)
  --min-score NUMBER  Minimum match probability, 0 through 1
  --max-tags NUMBER   Maximum recommendations per note, 1 through 1000
  JSON input may include "overrides" with tagging settings. Flags take precedence.
  Specific sets override inventory selection and exclusions. Tags do not require a # prefix.

Input for preview and suggest (JSON on stdin):
  {"note":{"title":"Example","body":"Text","existingTags":["notes"]},"tags":[{"tag":"design","count":12}]}

Input for review and quick-apply (JSON on stdin):
  {"tags":[{"tag":"design","count":12}],"existingTags":["inline-tag"]}
  existingTags is optional. Supply inline tags reported by Obsidian; Markdown frontmatter tags are read automatically.

Input for apply (JSON on stdin; PLAN is the complete JSON returned by review):
  {"plan":PLAN,"selectedTags":["design","typography"]}

Input for bulk (JSON on stdin):
  {"notes":["/vault/one.md",{"path":"/vault/two.md","existingTags":["inline-tag"]}],
   "folders":["/vault/Projects"],"excludeNotes":["/vault/Projects/skip.md"],"tags":[{"tag":"design","count":12}]}
  notes and folders are optional individually; select at least one note. Folders include subfolders.
  Canonical paths are deduplicated. Supply inline existingTags per note; frontmatter is read automatically.
  tags may be omitted when using a specific set, for every command that accepts a vocabulary.

Bulk options:
  --dry-run   Default: list selection, candidate tags, and request estimates; no network or note writes
  --suggest   Analyze and return per-note review plans; no note writes (uses API credits)
  --apply --recovery PATH   Analyze and add recommendations, retaining undo in a fresh file
  --concurrency NUMBER  1 through 3 notes in parallel; default 3
  --sort modified|created|alphabetical  Default modified, newest first
  --reverse   Reverse the sort order (alphabetical defaults A to Z)
  --search TEXT  Filter selected notes by title or folder; combine with excludeNotes to narrow a batch
  --filter all|applied|unchanged|failed|skipped|cancelled|ready|previewed|undone  Filter output results
  --quiet     Suppress progress on stderr; stdout remains one JSON report
  Ctrl-C or SIGTERM stops pending work and returns completed outcomes. In-flight requests may use credits.
  Provider-wide failures stop the queue; note-specific failures do not. Failed/stale notes are never written.
  Completed additions survive cancellation. Undo refuses to replace notes edited after tagging.
  Recovery files contain original note text and are created with owner-only permissions.

Undo:
  tag-match bulk-undo --recovery PATH      Preview undo without network or writes
  tag-match bulk-undo --recovery PATH --apply  Restore unchanged tagged notes
  Undo needs neither stdin nor configuration. Keep the recovery file until you no longer need undo.

File workflow:
  review and suggest never write files. review records the note path and SHA-256 snapshot.
  apply makes no network request and writes only explicit reviewed selections if the note is unchanged.
  quick-apply evaluates first, then writes only the recommended tags if analysis completes and the note is unchanged.
  Obtain vault counts with "obsidian tags counts format=json" from the vault directory. Its count strings are accepted.
  From that vault directory, run "obsidian tags path=folder/note.md format=json" with a vault-relative path.
  Map its records with rows.map(item => item.tag) and pass those strings as existingTags. --note remains an absolute Markdown path.

Tag selection:
  onlyTags lists tags separated by commas or newlines, including tags not yet in the vault.
  poolMode "specific" scores only that list, skipping existing tags and overriding exclusions and inventory selection.
  An empty specific set scores no tags; other modes use the inventory and selection settings below.
  Default (poolMode "auto") considers up to 250 tags, or 20% of all tags if that is more.
  In default, percentage, and number modes, mostUsedPercent sets the share selected by use count; the rest is sampled.
  mostUsedPercent accepts 0 through 100 and defaults to 70.
  Exclusions and tags already on the note are removed before this count. All and minimum-use modes remain literal.

Successful output:
  preview returns selection reasons, inspection statuses, coverage, and batch counts. suggest also returns judgments and recommendations.
  review returns status "review-ready", a snapshot identity, evaluated tags, and proposed tags; it contains no API key.
  apply returns status "applied" or "no-op", path, and addedTags. quick-apply returns the same plus its analysis result.
  All success output is one JSON value on stdout; errors use stderr and exit nonzero.
  Bulk reports contain every outcome and counts, without note bodies or credentials.
  --filter limits results only; totals and summary cover the full batch. Progress is JSON lines on stderr.
  Exit codes: 0 complete, 1 error or partial batch (including skipped notes), 130 cancelled.

Examples:
  cat input.json | tag-match preview --config /path/to/.obsidian/plugins/tag-match/data.json
  cat input.json | tag-match suggest --config /path/to/.obsidian/plugins/tag-match/data.json
  cat tags.json | tag-match review --note /path/to/note.md --config /path/to/.obsidian/plugins/tag-match/data.json
  cat apply.json | tag-match apply --config /path/to/.obsidian/plugins/tag-match/data.json
  cat tags.json | tag-match quick-apply --note /path/to/note.md --config /path/to/.obsidian/plugins/tag-match/data.json
  cat batch.json | tag-match bulk --config /path/to/data.json --only-tags 'research, writing'
  cat batch.json | tag-match bulk --config /path/to/data.json --apply --recovery /path/to/batch-undo.jsonl`;

async function readStdin(): Promise<unknown> {
  let text = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) text += chunk;
  if (!text.trim()) throw new Error('Expected JSON on stdin.');
  try { return JSON.parse(text); }
  catch { throw new Error('Stdin is not valid JSON.'); }
}

function parseArgs(args: string[]) {
  const result = { command: '', configPath: '', notePath: '', mode: 'dry-run' as 'dry-run' | 'suggest' | 'apply',
    recoveryPath: '', concurrency: 3, sort: 'modified', reverse: false, search: '', filter: 'all', quiet: false,
    overrides: {} as Record<string, unknown> };
  if (args.includes('--help') || args.includes('-h')) return { ...result, command: 'help' };
  if (args.includes('--version') || args.includes('-v')) return { ...result, command: 'version' };
  const command = args[0] ?? '';
  if (!['preview', 'suggest', 'review', 'apply', 'quick-apply', 'bulk', 'bulk-undo'].includes(command)) {
    throw new Error('Choose preview, suggest, review, apply, quick-apply, bulk, or bulk-undo. Use --help for examples.');
  }
  result.command = command;
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    const bulk = ['bulk', 'bulk-undo'].includes(command);
    if (['--dry-run', '--apply', '--suggest', '--recovery', '--concurrency', '--sort', '--reverse', '--search', '--filter', '--quiet'].includes(flag) && !bulk) {
      throw new Error(`${flag} is a bulk option.`);
    }
    if (flag === '--reverse') { result.reverse = true; continue; }
    if (flag === '--quiet') { result.quiet = true; continue; }
    if (['--dry-run', '--apply', '--suggest'].includes(flag)) {
      if (['--dry-run', '--apply', '--suggest'].filter(mode => seen.has(mode)).length > 1) throw new Error('Choose only one of --dry-run, --suggest, or --apply.');
      if (command === 'bulk-undo' && flag === '--suggest') throw new Error('Undo supports --dry-run or --apply.');
      result.mode = flag.slice(2) as typeof result.mode;
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Pass a value for ${flag}.`);
    if (flag === '--config') result.configPath = value;
    else if (flag === '--note') result.notePath = value;
    else if (flag === '--recovery') result.recoveryPath = value;
    else if (flag === '--sort') {
      if (!['modified', 'created', 'alphabetical'].includes(value)) throw new Error('Sort must be modified, created, or alphabetical.');
      result.sort = value;
    } else if (flag === '--search') result.search = value;
    else if (flag === '--filter') {
      if (!['all', 'applied', 'unchanged', 'failed', 'skipped', 'cancelled', 'ready', 'previewed', 'undone'].includes(value)) throw new Error('Unknown results filter.');
      result.filter = value;
    } else if (flag === '--concurrency') {
      if (!/^[1-3]$/.test(value)) throw new Error('Concurrency must be 1, 2, or 3.');
      result.concurrency = Number(value);
    } else if (flag === '--only-tags') { result.overrides.onlyTags = value; result.overrides.poolMode = 'specific'; }
    else if (flag === '--exclude-tags') result.overrides.excludedTags = value;
    else if (flag === '--min-score') result.overrides.minProbability = value.trim() ? Number(value) : NaN;
    else if (flag === '--max-tags') result.overrides.maxTagsToAdd = value.trim() ? Number(value) : NaN;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (command !== 'bulk-undo' && !result.configPath) throw new Error('Pass the plugin data file with --config PATH.');
  if (['review', 'quick-apply'].includes(command) && !result.notePath) throw new Error('Pass a Markdown file with --note PATH.');
  if ((command === 'bulk-undo' || command === 'bulk' && result.mode === 'apply') && !result.recoveryPath) throw new Error('Pass --recovery PATH. Bulk writes require a fresh recovery file.');
  if (command === 'bulk' && result.mode !== 'apply' && result.recoveryPath) throw new Error('--recovery is used with bulk --apply.');
  if (command === 'bulk-undo' && (Object.keys(result.overrides).length || result.notePath || result.configPath || seen.has('--sort') || seen.has('--search') || seen.has('--reverse') || seen.has('--concurrency'))) throw new Error('Undo uses only --recovery, --dry-run or --apply, --filter, and --quiet.');
  return result;
}

async function loadConfig(path: string): Promise<Config> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Config is not valid JSON: ${path}`);
    throw new Error(`Could not read config: ${path}`);
  }
  return normalizeConfig(value);
}

function tagInput(value: unknown): { note: Note; tags: TagCount[] } {
  if (!record(value) || !record(value.note) || !Array.isArray(value.tags)) throw new Error('Input must contain note and tags.');
  const note = value.note;
  if (typeof note.title !== 'string' || typeof note.body !== 'string'
    || !Array.isArray(note.existingTags) || !note.existingTags.every(tag => typeof tag === 'string')
    || (note.description !== undefined && typeof note.description !== 'string')) {
    throw new Error('note must contain title, body, and existingTags strings.');
  }
  const tags = value.tags.map((item): TagCount => {
    if (!record(item) || typeof item.tag !== 'string'
      || !((typeof item.count === 'number' && Number.isFinite(item.count))
        || (typeof item.count === 'string' && /^\d+$/.test(item.count)))) {
      throw new Error('Each tag must contain a text tag and numeric count.');
    }
    return { tag: item.tag, count: Number(item.count) };
  });
  return { note: { title: note.title, body: note.body, existingTags: note.existingTags,
    ...(note.description === undefined ? {} : { description: note.description }) }, tags };
}

function vocabularyInput(value: unknown): { tags: TagCount[]; existingTags: string[] } {
  const existingTags = record(value) && value.existingTags !== undefined ? value.existingTags : [];
  if (!Array.isArray(existingTags) || !existingTags.every(tag => typeof tag === 'string')) {
    throw new Error('existingTags must be an array of tag names.');
  }
  return { tags: tagInput({ note: { title: '', body: '', existingTags: [] },
    tags: record(value) ? value.tags : undefined }).tags, existingTags };
}

export const fetchTransport: Transport = async (request, apiKey, signal, endpoint): Promise<HttpResponse> => {
  const response = await fetch(endpoint, { method: 'POST', signal, headers: {
    authorization: `Bearer ${apiKey}`, 'content-type': 'application/json',
  }, body: JSON.stringify(request) });
  let json: unknown;
  try { json = await response.json(); } catch { json = undefined; }
  return { status: response.status, json, retryAfter: response.headers.get('retry-after') ?? undefined };
};

export async function run(args: string[], signal = new AbortController().signal): Promise<unknown> {
  const parsed = parseArgs(args);
  if (parsed.command === 'help') return { help: HELP };
  if (parsed.command === 'version') return { version: CLI_VERSION };
  const filter = <T extends { results: { status: string }[] }>(report: T): T => ({ ...report,
    results: report.results.filter(item => parsed.filter === 'all' || item.status === parsed.filter) });
  if (parsed.command === 'bulk-undo') return filter(await undoCliBulk(parsed.recoveryPath, parsed.mode === 'apply', signal));
  let config = await loadConfig(parsed.configPath);
  const input = await readStdin();
  config = withOverrides(withOverrides(config, record(input) ? input.overrides : undefined), parsed.overrides);
  const vocabularyValue = record(input) && input.tags === undefined && config.poolMode === 'specific' ? { ...input, tags: [] } : input;
  const targets = parsed.command === 'bulk' ? await bulkTargets(input, parsed.sort, parsed.reverse, parsed.search) : undefined;
  const vocabulary = ['bulk', 'review', 'quick-apply'].includes(parsed.command) ? vocabularyInput(vocabularyValue) : undefined;
  // Validate selection overrides before resolving secrets or starting a network run.
  selectCandidates(vocabulary?.tags ?? [], vocabulary?.existingTags ?? [], config, 'cli-validation');
  if (['suggest', 'review', 'quick-apply'].includes(parsed.command) || parsed.command === 'bulk' && parsed.mode !== 'dry-run') {
    config = await resolveCliCredential(config, parsed.configPath);
  }
  if (targets && vocabulary) return filter(await runCliBulk(targets, vocabulary.tags, config, fetchTransport,
    { mode: parsed.mode, concurrency: parsed.concurrency, recoveryPath: parsed.recoveryPath || undefined, signal,
      onProgress: parsed.quiet ? undefined : event => stderr.write(`${JSON.stringify(event)}\n`) }));
  if (parsed.command === 'apply') {
    if (!record(input) || !Array.isArray(input.selectedTags) || !input.selectedTags.every(tag => typeof tag === 'string')) {
      throw new Error('Input must contain a review plan and selectedTags array.');
    }
    return applyReviewPlan(parseReviewPlan(input.plan), input.selectedTags, config, signal);
  }
  if (parsed.command === 'review') {
    return reviewFile(parsed.notePath, vocabulary!.tags, config, fetchTransport, vocabulary!.existingTags, signal);
  }
  if (parsed.command === 'quick-apply') {
    return quickApplyFile(parsed.notePath, vocabulary!.tags, config, fetchTransport, vocabulary!.existingTags, signal);
  }
  const { note, tags } = tagInput(vocabularyValue);
  if (parsed.command === 'preview') {
    const pool = selectCandidates(tags, note.existingTags, config, noteSeed(note));
    const prepared = buildBatches(note, pool, config);
    return { pool, truncated: prepared.truncated, sentChars: prepared.sentChars, batches: prepared.batches.length };
  }
  return suggest(note, tags, config, fetchTransport, signal);
}

if (import.meta.url === `file://${argv[1]}`) {
  if (argv.slice(2).some(arg => arg === '--version' || arg === '-v')) stdout.write(`${CLI_VERSION}\n`);
  else if (argv.slice(2).some(arg => arg === '--help' || arg === '-h')) stdout.write(`${HELP}\n`);
  else {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
    run(argv.slice(2), controller.signal).then(result => {
      stdout.write(`${JSON.stringify(result)}\n`);
      if (record(result) && result.status === 'cancelled') process.exitCode = 130;
      else if (record(result) && result.status === 'partial') process.exitCode = 1;
    })
    .catch((error: unknown) => {
      stderr.write(`${error instanceof Error ? error.message : 'Tag Match failed.'}\n`);
      process.exitCode = controller.signal.aborted ? 130 : 1;
    }).finally(() => { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); });
  }
}
