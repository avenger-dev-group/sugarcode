import assert from 'node:assert/strict';
import test from 'node:test';

import { ProviderAdapterError } from '../../src/runtime/models/errors.ts';
import { streamWithPreOutputRetry } from '../../src/runtime/models/retry.ts';

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
