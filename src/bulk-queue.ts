// Schedules bounded parallel work and stops the batch when a shared provider failure prevents further progress.
import { ProviderRequestError } from './client.ts';

// Bounds retained original/written strings to about 64 MiB at two bytes per UTF-16 code unit.
export const MAX_BULK_RECOVERY_CHARACTERS = 32 * 1024 * 1024;

export interface BulkQueueContext {
  cancelled: boolean;
  stopped?: string;
}

export interface BulkQueueOptions<T> {
  signal: AbortSignal;
  concurrency?: number;
  run: (item: T, signal: AbortSignal) => Promise<void>;
  onError: (item: T, error: unknown, context: BulkQueueContext) => void;
  onSkipped: (item: T, context: BulkQueueContext) => void;
  onSettled: (item: T, complete: number, total: number) => void;
  shouldStop?: (error: unknown) => boolean;
}

export function stopsBulkRun(error: unknown): boolean {
  if (error instanceof ProviderRequestError) return error.status !== 400 && error.status !== 413 && error.status !== 422;
  return error instanceof Error && error.cause !== undefined ? stopsBulkRun(error.cause) : false;
}

export async function runBulkQueue<T>(items: T[], options: BulkQueueOptions<T>): Promise<void> {
  let next = 0;
  let complete = 0;
  let stopped: string | undefined;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal.aborted) abort();
  options.signal.addEventListener('abort', abort, { once: true });
  const context = (): BulkQueueContext => ({ cancelled: options.signal.aborted, stopped });
  const shouldStop = options.shouldStop ?? stopsBulkRun;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      const current = context();
      if (current.cancelled || current.stopped !== undefined) options.onSkipped(item, current);
      else {
        try {
          await options.run(item, controller.signal);
        } catch (error) {
          // Report the triggering failure before cancelling the other in-flight items.
          const failed = context();
          options.onError(item, error, failed);
          if (!failed.cancelled && failed.stopped === undefined && shouldStop(error)) {
            stopped = error instanceof Error ? error.message : 'Tagging could not be completed.';
            controller.abort();
          }
        }
      }
      options.onSettled(item, ++complete, items.length);
    }
  };
  const workers = Math.min(items.length, Math.max(1, Math.min(3, Math.floor(options.concurrency ?? 3) || 1)));
  try { await Promise.all(Array.from({ length: workers }, worker)); }
  finally { options.signal.removeEventListener('abort', abort); }
}
