import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderAdapterError } from '../../src/runtime/models/errors.ts';
import {
  rateLimitRetryDecision,
  retryAfterMs,
  streamWithPreOutputRetry,
} from '../../src/runtime/models/retry.ts';

const collect = async <T>(stream: AsyncIterable<T>): Promise<readonly T[]> => {
  const values: T[] = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values;
};

test('pre-output retry continues until the shared request deadline aborts', async () => {
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(), 1_500);
  let attempts = 0;

  try {
    await assert.rejects(
      collect(streamWithPreOutputRetry({
        signal: abortController.signal,
        shouldRetry: () => true,
        create: async () => {
          attempts += 1;
          throw new Error('temporary gateway failure');
        },
      })),
      (error: unknown) =>
        error instanceof ProviderAdapterError &&
        error.details.kind === 'cancelled',
    );
  } finally {
    clearTimeout(abortTimer);
  }

  assert.equal(attempts, 3);
});

test('pre-output retry never replays a stream after meaningful output', async () => {
  let attempts = 0;
  const stream = streamWithPreOutputRetry({
    shouldRetry: () => true,
    create: async () => {
      attempts += 1;
      return (async function* () {
        yield 'visible output';
        throw new Error('connection closed');
      })();
    },
  });

  await assert.rejects(collect(stream), /connection closed/u);
  assert.equal(attempts, 1);
});

test('retry-after supports seconds, dates, and the SDK millisecond extension', () => {
  const now = Date.parse('2026-09-17T00:00:00Z');
  assert.equal(
    retryAfterMs({ headers: new Headers({ 'retry-after': '2.5' }) }, now),
    2_500,
  );
  assert.equal(
    retryAfterMs({
      headers: new Headers({
        'retry-after': 'Thu, 17 Sep 2026 00:03:00 GMT',
      }),
    }, now),
    180_000,
  );
  assert.equal(
    retryAfterMs({
      headers: new Headers({
        'retry-after': '120',
        'retry-after-ms': '750',
      }),
    }, now),
    750,
  );
});

test('persistent rate limits retry beyond the ordinary retry cap', async () => {
  let attempts = 0;
  const values = await collect(streamWithPreOutputRetry({
    shouldRetry: (_error, failedAttempts) => ({
      ...rateLimitRetryDecision(_error, failedAttempts, true),
      delayMs: 0,
    }),
    create: async () => {
      attempts += 1;
      if (attempts <= 6) {
        throw new Error('capacity unavailable');
      }
      return (async function* () {
        yield 'ready';
      })();
    },
  }));

  assert.deepEqual(values, ['ready']);
  assert.equal(attempts, 7);
});

test('persistent rate limits back off from one minute to a five-minute cap', () => {
  assert.equal(rateLimitRetryDecision({}, 0, true, () => 0).delayMs, 60_000);
  assert.equal(rateLimitRetryDecision({}, 1, true, () => 0).delayMs, 120_000);
  assert.equal(rateLimitRetryDecision({}, 2, true, () => 0).delayMs, 240_000);
  assert.equal(rateLimitRetryDecision({}, 3, true, () => 0).delayMs, 300_000);
  assert.equal(rateLimitRetryDecision({}, 20, true, () => 0).delayMs, 300_000);
  assert.equal(rateLimitRetryDecision({}, 20, true, () => 1).delayMs, 330_000);
});

test('an explicit retry limit still overrides persistent rate-limit retries', async () => {
  let attempts = 0;
  await assert.rejects(
    collect(streamWithPreOutputRetry({
      maxRetries: 0,
      shouldRetry: (error, failedAttempts) =>
        rateLimitRetryDecision(error, failedAttempts, true),
      create: async () => {
        attempts += 1;
        throw new Error('capacity unavailable');
      },
    })),
    /capacity unavailable/u,
  );
  assert.equal(attempts, 1);
});
