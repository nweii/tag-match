// Evaluates decision batches through one resolved provider with bounded retries and isolated credentials.
import { parseOpenAiJudgments } from './decision-protocol.ts';
import { type Config, record } from './config.ts';
import { resolveProvider, TYPE_SAFE_ENDPOINT, type ProviderConfig } from './provider.ts';
import { type EvaluationRequest, type Judgment, type Note, type TagCount,
  selectCandidates, buildBatches, parseJudgments, recommendations, rankJudgments, noteSeed, type CandidatePool } from './core.ts';

export const ENDPOINT = TYPE_SAFE_ENDPOINT;
export interface HttpResponse { status: number; json: unknown; retryAfter?: string }
export type Transport = (request: EvaluationRequest, apiKey: string, signal: AbortSignal, endpoint: string) => Promise<HttpResponse>;
export type Pause = (ms: number, signal: AbortSignal) => Promise<void>;

export class ProviderRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderRequestError';
    this.status = status;
  }
}

// Only recover from an explicit question-count validation error, never an arbitrary 422.
export function questionLimit(value: unknown, depth = 0): number | undefined {
  if (depth > 3 || !record(value)) return undefined;
  if (Array.isArray(value.detail)) {
    for (const item of value.detail) {
      if (!record(item) || item.type !== 'too_long' || !Array.isArray(item.loc)
        || item.loc.join('.') !== 'body.questions' || typeof item.msg !== 'string') continue;
      const match = item.msg.match(/^(?:Dictionary|List) should have at most (\d+) items after validation/);
      const limit = match ? Number(match[1]) : undefined;
      if (limit && Number.isSafeInteger(limit)) return limit;
    }
  }
  if (record(value.error)) return questionLimit(value.error, depth + 1);
  if (typeof value.message === 'string' && value.message.startsWith('HTTP 422: ')) {
    try { return questionLimit(JSON.parse(value.message.slice(10)), depth + 1); } catch { /* Unrecognized provider text is not a retry instruction. */ }
  }
  return undefined;
}

class QuestionLimitError extends ProviderRequestError {
  readonly limit: number;
  constructor(limit: number, label: string, status: number) {
    super(`${label} accepts at most ${limit} questions per request.`, status);
    this.limit = limit;
  }
}

function sliceRequest(request: EvaluationRequest, start: number, end: number): EvaluationRequest {
  if ('input' in request) return { ...request, questions: request.questions.slice(start, end).map((q, i) => ({ ...q, name: `tag_${i}` })) };
  return { ...request, questions: Object.fromEntries(Object.values(request.questions).slice(start, end).map((q, i) => [`tag_${i}`, q])) };
}

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
  if (!provider.apiKey.trim()) throw new ProviderRequestError(`Add your ${provider.label} API key in Tag Match settings.`, 401);
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    let result: HttpResponse;
    try {
      result = await transport(request, provider.apiKey, signal, provider.endpoint);
    } catch (error) {
      if (signal.aborted) throw error;
      throw new ProviderRequestError(`${provider.label} could not complete the request. Check your connection and try again.`, 0, { cause: error });
    }
    signal.throwIfAborted();
    if (result.status >= 200 && result.status < 300) return result.json;
    if ([429, 529, 502, 503, 504].includes(result.status) && attempt < 2) {
      const seconds = result.retryAfter === undefined ? NaN : Number(result.retryAfter);
      const dateDelay = result.retryAfter ? Date.parse(result.retryAfter) - Date.now() : NaN;
      const wait = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(dateDelay) ? dateDelay : 1000 * 2 ** attempt;
      if (wait > 30000) throw new ProviderRequestError(`${provider.label} is busy. Try again after its rate limit resets.`, result.status);
      await sleep(Math.max(0, wait), signal);
      continue;
    }
    const limit = [400, 422].includes(result.status) ? questionLimit(result.json) : undefined;
    if (limit) throw new QuestionLimitError(limit, provider.label, result.status);
    const messages: Record<number, string> = {
      400: `${provider.label} rejected the request. Check the model and note context.`,
      404: `${provider.label} could not find the selected model. Check the model ID and access.`,
      401: `${provider.label} rejected the API key. Check the API key in Tag Match settings, then try again.`,
      402: `${provider.label} requires available credits for this request. Add credits to your ${provider.label} account, then try again.`,
      403: `${provider.label} rejected access to the selected model. Check model access with ${provider.label}, then try again.`,
      422: `${provider.label} rejected the request. Reduce the note context or check the model.`,
      429: `${provider.label} rate limit reached. Try again shortly.`,
      529: `${provider.label} is busy. Try again shortly.`,
    };
    throw new ProviderRequestError(messages[result.status] ?? `${provider.label} request failed (HTTP ${result.status}). Try again; if it persists, check your connection and model settings.`, result.status);
  }
  throw new ProviderRequestError(`${provider.label} request failed.`, 0);
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
  signal = new AbortController().signal, onProgress: (progress: Progress) => void = () => {},
  selectedPool?: CandidatePool) {
  const analysisConfig = { ...config };
  const pool = selectedPool ?? selectCandidates(inventory, note.existingTags, analysisConfig, noteSeed(note));
  const prepared = buildBatches(note, pool, analysisConfig);
  const provider = resolveProvider(analysisConfig);
  const judgments: Judgment[] = [];
  const models = new Set<string>();
  let inputTokens = 0;
  let outputTokens = 0;
  let usageComplete = true;
  onProgress({ complete: 0, total: pool.tags.length });
  const queue = prepared.batches.map(batch => ({ ...batch, reductions: 0 }));
  let completedBatches = 0;
  for (let index = 0; index < queue.length; index++) {
    const batch = queue[index]!;
    signal.throwIfAborted();
    let response: unknown;
    try {
      response = await evaluate(batch.request, provider, transport, signal);
      judgments.push(...(provider.name === 'openai' ? parseOpenAiJudgments(response, batch.tags) : parseJudgments(response, batch.tags)));
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof QuestionLimitError && error.limit < batch.tags.length && batch.reductions < 3) {
        const parts = [];
        for (let start = 0; start < batch.tags.length; start += error.limit) {
          parts.push({ request: sliceRequest(batch.request, start, start + error.limit),
            tags: batch.tags.slice(start, start + error.limit), reductions: batch.reductions + 1 });
        }
        queue.splice(index, 1, ...parts);
        index--;
        continue;
      }
      const message = error instanceof Error ? error.message : `${provider.label} evaluation failed.`;
      throw new BatchEvaluationError(`${message} Completed ${judgments.length} of ${pool.tags.length} tags; no partial suggestions were returned.`, judgments.length, pool.tags.length, { cause: error });
    }
    completedBatches++;
    if (record(response) && typeof response.model === 'string') models.add(response.model);
    if (record(response) && record(response.usage)
      && typeof response.usage.input_tokens === 'number' && typeof response.usage.output_tokens === 'number') {
      inputTokens += response.usage.input_tokens;
      outputTokens += response.usage.output_tokens;
    } else usageComplete = false;
    onProgress({ complete: judgments.length, total: pool.tags.length });
  }
  return { pool, judgments: rankJudgments(judgments), recommended: recommendations(judgments, analysisConfig),
    truncated: prepared.truncated, sentChars: prepared.sentChars, batches: completedBatches,
    models: [...models], usage: { inputTokens, outputTokens, complete: usageComplete } };
}

export type SuggestionResult = Awaited<ReturnType<typeof suggest>>;
