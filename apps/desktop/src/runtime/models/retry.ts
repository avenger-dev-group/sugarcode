import { cancelledProviderError } from './errors.ts';

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000, 5_000, 10_000, 30_000] as const;
const RATE_LIMIT_RETRY_DELAYS_MS = [60_000, 120_000, 240_000, 300_000] as const;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

export type RetryDecision = boolean | Readonly<{
  retry: boolean;
  delayMs?: number;
  unlimited?: boolean;
}>;

type HeadersWithGet = Readonly<{
  get: (name: string) => string | null;
}>;

const headersFromError = (error: unknown): HeadersWithGet | undefined => {
  if (typeof error !== 'object' || error === null || !('headers' in error)) {
    return undefined;
  }
  const headers = (error as { headers?: unknown }).headers;
  return typeof headers === 'object' &&
      headers !== null &&
      'get' in headers &&
      typeof (headers as { get?: unknown }).get === 'function'
    ? headers as HeadersWithGet
    : undefined;
};

const boundedDelay = (delayMs: number): number | undefined =>
  Number.isFinite(delayMs) && delayMs >= 0
    ? Math.min(Math.ceil(delayMs), MAX_RETRY_AFTER_MS)
    : undefined;

/** Reads both the standard Retry-After header and the millisecond extension
 * supported by the OpenAI and Anthropic SDKs. */
export const retryAfterMs = (
  error: unknown,
  nowMs = Date.now(),
): number | undefined => {
  const headers = headersFromError(error);
  if (!headers) {
    return undefined;
  }
  const milliseconds = headers.get('retry-after-ms');
  if (milliseconds !== null && milliseconds.trim() !== '') {
    const parsed = boundedDelay(Number(milliseconds));
    if (parsed !== undefined) {
      return parsed;
    }
  }
  const retryAfter = headers.get('retry-after');
  if (retryAfter === null || retryAfter.trim() === '') {
    return undefined;
  }
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return boundedDelay(seconds * 1_000);
  }
  const retryAt = Date.parse(retryAfter);
  return Number.isNaN(retryAt)
    ? undefined
    : boundedDelay(Math.max(0, retryAt - nowMs));
};

/**
 * Internal Metis capacity errors can remain queued for a long time. Retry
 * those 429s until the shared request deadline or cancellation, using the
 * server delay when available and a one-to-five-minute exponential backoff
 * otherwise. External providers use the same header-aware delay because their
 * 429s can also mean exhausted billing quota.
 */
export const rateLimitRetryDecision = (
  error: unknown,
  failedAttempts: number,
  persistent: boolean,
  random = Math.random,
): Exclude<RetryDecision, boolean> => {
  const serverDelayMs = retryAfterMs(error);
  const fallbackDelayMs = persistent
    ? RATE_LIMIT_RETRY_DELAYS_MS[
        Math.min(failedAttempts, RATE_LIMIT_RETRY_DELAYS_MS.length - 1)
      ]
    : undefined;
  const delayMs = serverDelayMs ?? (fallbackDelayMs === undefined
    ? undefined
    : Math.ceil(fallbackDelayMs * (1 + Math.max(0, Math.min(random(), 1)) * 0.1)));
  return {
    retry: true,
    ...(delayMs === undefined ? {} : { delayMs }),
    ...(persistent ? { unlimited: true } : {}),
  };
};

const waitForRetry = async (
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted) {
    throw cancelledProviderError();
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(cancelledProviderError());
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

export const streamWithPreOutputRetry = async function* <T>(options: {
  create: () => Promise<AsyncIterable<T>>;
  countsAsOutput?: (event: T) => boolean;
  shouldRetry: (error: unknown, failedAttempts: number) => RetryDecision;
  signal?: AbortSignal;
  maxRetries?: number;
}): AsyncGenerator<T, void> {
  const maxRetries = options.maxRetries === undefined
    ? options.signal === undefined
      ? DEFAULT_RETRY_DELAYS_MS.length
      : Number.POSITIVE_INFINITY
    : Math.max(0, Math.min(options.maxRetries, 4));
  let attempt = 0;
  for (;;) {
    let emitted = false;
    try {
      const stream = await options.create();
      for await (const event of stream) {
        emitted ||= options.countsAsOutput?.(event) ?? true;
        yield event;
      }
      return;
    } catch (error) {
      const requested = options.shouldRetry(error, attempt);
      const decision = typeof requested === 'boolean'
        ? { retry: requested }
        : requested;
      if (
        emitted ||
        !decision.retry ||
        (attempt >= maxRetries &&
          !(decision.unlimited === true && options.maxRetries === undefined))
      ) {
        throw error;
      }
      const delay = decision.delayMs ?? DEFAULT_RETRY_DELAYS_MS[
          Math.min(attempt, DEFAULT_RETRY_DELAYS_MS.length - 1)
        ];
      attempt += 1;
      await waitForRetry(delay, options.signal);
    }
  }
};
