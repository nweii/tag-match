// Evaluates Jev batches through one resolved provider with bounded retries and isolated credentials.
import { type Config, record } from './config.ts';
import { resolveProvider, TYPE_SAFE_ENDPOINT, type ProviderConfig } from './provider.ts';
import { type EvaluationRequest, type Judgment, type Note, type TagCount,
  selectCandidates, buildBatches, parseJudgments, recommendations, rankJudgments, noteSeed } from './core.ts';

export const ENDPOINT = TYPE_SAFE_ENDPOINT;
export interface HttpResponse { status: number; json: unknown; retryAfter?: string }
export type Transport = (request: EvaluationRequest, apiKey: string, signal: AbortSignal, endpoint: string) => Promise<HttpResponse>;
export type Pause = (ms: number, signal: AbortSignal) => Promise<void>;

const pause: Pause = (ms, signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  // This module also runs in Node, where window does not exist.
  const timers = typeof window === 'undefined' ? { setTimeout, clearTimeout } : window;
  const abort = () => { timers.clearTimeout(timer); reject(new Error('Cancelled.')); };
  const timer = timers.setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
  signal.addEventListener('abort', abort, { once: true });
});

export async function evaluate(request: EvaluationRequest, provider: ProviderConfig, transport: Transport,
  signal: AbortSignal = new AbortController().signal, sleep: Pause = pause): Promise<unknown> {
  if (!provider.apiKey.trim()) throw new Error(`Add your ${provider.label} API key in Tag Match settings.`);
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const result = await transport(request, provider.apiKey, signal, provider.endpoint);
    signal.throwIfAborted();
    if (result.status >= 200 && result.status < 300) return result.json;
    if ([429, 529, 502, 503, 504].includes(result.status) && attempt < 2) {
      const seconds = result.retryAfter === undefined ? NaN : Number(result.retryAfter);
      const dateDelay = result.retryAfter ? Date.parse(result.retryAfter) - Date.now() : NaN;
      const wait = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(dateDelay) ? dateDelay : 1000 * 2 ** attempt;
      if (wait > 30000) throw new Error(`${provider.label} is busy. Try again after its rate limit resets.`);
      await sleep(Math.max(0, wait), signal);
      continue;
    }
    const messages: Record<number, string> = {
      401: `${provider.label} rejected the API key.`,
      402: `${provider.label} requires available credits for this request.`,
      403: `${provider.label} rejected access to the selected model.`,
      422: `${provider.label} rejected the request. Reduce the note context or check the model.`,
      429: `${provider.label} rate limit reached. Try again shortly.`,
      529: `${provider.label} is busy. Try again shortly.`,
    };
    throw new Error(messages[result.status] ?? `${provider.label} request failed (HTTP ${result.status}).`);
  }
  throw new Error(`${provider.label} request failed.`);
}

export interface Progress { complete: number; total: number }
export class BatchEvaluationError extends Error {
  readonly complete: number;
  readonly total: number;
  constructor(message: string, complete: number, total: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BatchEvaluationError';
    this.complete = complete;
    this.total = total;
  }
}

export async function suggest(note: Note, inventory: TagCount[], config: Config, transport: Transport,
  signal = new AbortController().signal, onProgress: (progress: Progress) => void = () => {}) {
  const analysisConfig = { ...config };
  const pool = selectCandidates(inventory, note.existingTags, analysisConfig, noteSeed(note));
  const prepared = buildBatches(note, pool, analysisConfig);
  const provider = resolveProvider(analysisConfig);
  const judgments: Judgment[] = [];
  const models = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let usageComplete = true;
  onProgress({ complete: 0, total: pool.tags.length });
  for (const batch of prepared.batches) {
    signal.throwIfAborted();
    let response: unknown;
    try {
      response = await evaluate(batch.request, provider, transport, signal);
      judgments.push(...parseJudgments(response, batch.tags));
    } catch (error) {
      if (signal.aborted) throw error;
      const message = error instanceof Error ? error.message : `${provider.label} evaluation failed.`;
      throw new BatchEvaluationError(`${message} Completed ${judgments.length} of ${pool.tags.length} tags; no partial suggestions were returned.`, judgments.length, pool.tags.length, { cause: error });
    }
    if (record(response) && typeof response.model === 'string') models.add(response.model);
    if (record(response) && record(response.usage)
      && typeof response.usage.input_tokens === 'number' && typeof response.usage.output_tokens === 'number') {
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
    } else usageComplete = false;
    onProgress({ complete: judgments.length, total: pool.tags.length });
  }
  return { pool, judgments: rankJudgments(judgments), recommended: recommendations(judgments, analysisConfig),
    truncated: prepared.truncated, sentChars: prepared.sentChars, batches: prepared.batches.length,
    models: [...models], usage: { inputTokens, outputTokens, complete: usageComplete } };
}

export type SuggestionResult = Awaited<ReturnType<typeof suggest>>;
