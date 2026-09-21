// Exposes shared Jev evaluation and tag suggestion as a JSON-only command-line interface.
import { readFile } from 'node:fs/promises';
import { stdin, stdout, stderr, argv } from 'node:process';
import { normalizeConfig, record, type Config } from './config.ts';
import { evaluate, suggest, type HttpResponse, type Transport } from './client.ts';
import { buildBatches, selectCandidates, type EvaluationRequest, type Note, type TagCount } from './core.ts';
import { applyReviewPlan, parseReviewPlan, quickApplyFile, reviewFile } from './cli-workflow.ts';
import { resolveProvider } from './provider.ts';
import { resolveCliCredential } from './credentials.ts';

const HELP = `Usage: tag-match <command> --config PATH

Commands:
  preview   Report candidate coverage without using the network
  suggest   Evaluate candidate tags with the saved Jev provider
  review    Analyze a Markdown file and return a review plan without writing
  apply     Apply explicit selections from a review plan without using the network
  quick-apply  Analyze a Markdown file and add complete recommendations directly
  evaluate  Evaluate arbitrary Decisions API state and Noul questions

Input for preview and suggest (JSON on stdin):
  {"note":{"title":"Example","body":"Text","existingTags":["notes"]},"tags":[{"tag":"design","count":12}]}

Input for evaluate (JSON on stdin):
  {"state":{"text":"Example"},"questions":{"relevant":{"type":"noul","instructions":"Is it relevant?","criteria":{"true":"Yes","false":"No"}}}}

Input for review and quick-apply (JSON on stdin):
  {"tags":[{"tag":"design","count":12}],"existingTags":["inline-tag"]}
  existingTags is optional. Supply inline tags reported by Obsidian; Markdown frontmatter tags are read automatically.

Input for apply (JSON on stdin; PLAN is the complete JSON returned by review):
  {"plan":PLAN,"selectedTags":["design","typography"]}

File workflow:
  review and suggest never write files. review records the note path and SHA-256 snapshot.
  apply makes no network request and writes only explicit reviewed selections if the note is unchanged.
  quick-apply evaluates first, then writes only the recommended tags if analysis completes and the note is unchanged.
  Obtain vault counts with "obsidian tags counts format=json" from the vault directory. Its count strings are accepted.
  From that vault directory, run "obsidian tags path=folder/note.md format=json" with a vault-relative path.
  Map its records with rows.map(item => item.tag) and pass those strings as existingTags. --note remains an absolute Markdown path.

Candidate range:
  The default automatic mode checks all eligible tags up to 100. Above 100, it checks at least 100 or the top 20%, whichever is larger.
  Exclusions and tags already on the note are removed before this count. Saved percent mode remains a literal percentage.

Successful output:
  preview returns pool coverage and batch counts. suggest returns ranked judgments and recommendations.
  review returns status "review-ready", a snapshot identity, evaluated tags, and proposed tags; it contains no API key.
  apply returns status "applied" or "no-op", path, and addedTags. quick-apply returns the same plus its analysis result.
  evaluate returns the selected provider's Decisions API response. All success output is one JSON value on stdout; errors use stderr and exit nonzero.

Examples:
  cat input.json | tag-match preview --config /path/to/.obsidian/plugins/tag-match/data.json
  cat input.json | tag-match suggest --config /path/to/.obsidian/plugins/tag-match/data.json
  cat tags.json | tag-match review --note /path/to/note.md --config /path/to/.obsidian/plugins/tag-match/data.json
  cat apply.json | tag-match apply --config /path/to/.obsidian/plugins/tag-match/data.json
  cat tags.json | tag-match quick-apply --note /path/to/note.md --config /path/to/.obsidian/plugins/tag-match/data.json
  cat evaluation.json | tag-match evaluate --config /path/to/.obsidian/plugins/tag-match/data.json`;

async function readStdin(): Promise<unknown> {
  let text = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) text += chunk;
  if (!text.trim()) throw new Error('Expected JSON on stdin.');
  try { return JSON.parse(text); }
  catch { throw new Error('Stdin is not valid JSON.'); }
}

function parseArgs(args: string[]): { command: string; configPath: string; notePath: string } {
  if (args.includes('--help') || args.includes('-h')) return { command: 'help', configPath: '', notePath: '' };
  const command = args[0] ?? '';
  const configIndex = args.indexOf('--config');
  const configPath = configIndex >= 0 ? args[configIndex + 1] ?? '' : '';
  const noteIndex = args.indexOf('--note');
  const notePath = noteIndex >= 0 ? args[noteIndex + 1] ?? '' : '';
  if (!['preview', 'suggest', 'review', 'apply', 'quick-apply', 'evaluate'].includes(command)) {
    throw new Error('Choose preview, suggest, review, apply, quick-apply, or evaluate. Use --help for examples.');
  }
  if (!configPath) throw new Error('Pass the plugin data file with --config PATH.');
  if (['review', 'quick-apply'].includes(command) && !notePath) throw new Error('Pass a Markdown file with --note PATH.');
  return { command, configPath, notePath };
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

function evaluationInput(value: unknown, config: Config): EvaluationRequest {
  if (!record(value) || !record(value.questions)) throw new Error('Input must contain state and a questions object.');
  return { model: resolveProvider(config).model, state: value.state, questions: value.questions };
}

export const fetchTransport: Transport = async (request, apiKey, signal, endpoint): Promise<HttpResponse> => {
  const response = await fetch(endpoint, { method: 'POST', signal, headers: {
    authorization: `Bearer ${apiKey}`, 'content-type': 'application/json',
  }, body: JSON.stringify(request) });
  let json: unknown;
  try { json = await response.json(); } catch { json = undefined; }
  return { status: response.status, json, retryAfter: response.headers.get('retry-after') ?? undefined };
};

export async function run(args: string[]): Promise<unknown> {
  const parsed = parseArgs(args);
  if (parsed.command === 'help') return { help: HELP };
  let config = await loadConfig(parsed.configPath);
  const input = await readStdin();
  if (['suggest', 'review', 'quick-apply', 'evaluate'].includes(parsed.command)) {
    config = await resolveCliCredential(config, parsed.configPath);
  }
  if (parsed.command === 'evaluate') return evaluate(evaluationInput(input, config), resolveProvider(config), fetchTransport);
  if (parsed.command === 'apply') {
    if (!record(input) || !Array.isArray(input.selectedTags) || !input.selectedTags.every(tag => typeof tag === 'string')) {
      throw new Error('Input must contain a review plan and selectedTags array.');
    }
    return applyReviewPlan(parseReviewPlan(input.plan), input.selectedTags, config);
  }
  if (parsed.command === 'review') {
    const vocabulary = vocabularyInput(input);
    return reviewFile(parsed.notePath, vocabulary.tags, config, fetchTransport, vocabulary.existingTags);
  }
  if (parsed.command === 'quick-apply') {
    const vocabulary = vocabularyInput(input);
    return quickApplyFile(parsed.notePath, vocabulary.tags, config, fetchTransport, vocabulary.existingTags);
  }
  const { note, tags } = tagInput(input);
  if (parsed.command === 'preview') {
    const pool = selectCandidates(tags, note.existingTags, config);
    const prepared = buildBatches(note, pool, config);
    return { pool, truncated: prepared.truncated, sentChars: prepared.sentChars, batches: prepared.batches.length };
  }
  return suggest(note, tags, config, fetchTransport);
}

if (import.meta.url === `file://${argv[1]}`) {
  if (argv.slice(2).some(arg => arg === '--help' || arg === '-h')) stdout.write(`${HELP}\n`);
  else run(argv.slice(2)).then(result => { stdout.write(`${JSON.stringify(result)}\n`); })
    .catch((error: unknown) => {
      stderr.write(`${error instanceof Error ? error.message : 'Tag Match failed.'}\n`);
      process.exitCode = 1;
    });
}
