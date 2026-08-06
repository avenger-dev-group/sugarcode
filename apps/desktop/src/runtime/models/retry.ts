import { cancelledProviderError } from './errors.ts';

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000] as const;

const waitForRetry = async (
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> => {
  if (signal?.aborted) {
    throw cancelledProviderError();
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(cancelledProviderError());
      },
      { once: true },
    );
  });
};

export const streamWithPreOutputRetry = async function* <T>(options: {
  create: () => Promise<AsyncIterable<T>>;
  shouldRetry: (error: unknown) => boolean;
  signal?: AbortSignal;
  maxRetries?: number;
}): AsyncGenerator<T, void> {
  const maxRetries = Math.max(
    0,
    Math.min(options.maxRetries ?? DEFAULT_RETRY_DELAYS_MS.length, 4),
  );
  let attempt = 0;
  for (;;) {
    let emitted = false;
    try {
      const stream = await options.create();
      for await (const event of stream) {
        emitted = true;
        yield event;
      }
      return;
    } catch (error) {
      if (
        emitted ||
        attempt >= maxRetries ||
        !options.shouldRetry(error)
      ) {
        throw error;
      }
      const delay =
        DEFAULT_RETRY_DELAYS_MS[
          Math.min(attempt, DEFAULT_RETRY_DELAYS_MS.length - 1)
        ];
      attempt += 1;
      await waitForRetry(delay, options.signal);
    }
  }
};
