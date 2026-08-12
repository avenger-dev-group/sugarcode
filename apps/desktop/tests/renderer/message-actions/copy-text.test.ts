import assert from 'node:assert/strict';
import test from 'node:test';

import { copyTextToClipboard } from '../../../src/renderer/components/message-actions/use-copy-text.ts';

test('message copy preserves the exact source text', async () => {
  let copied = '';
  await copyTextToClipboard('**Answer**\n\n```ts\nvalue\n```', {
    writeText: async (text) => {
      copied = text;
    },
  });
  assert.equal(copied, '**Answer**\n\n```ts\nvalue\n```');
});

test('message copy exposes clipboard failures to the feedback store', async () => {
  await assert.rejects(
    copyTextToClipboard('Answer', {
      writeText: () => Promise.reject(new Error('clipboard denied')),
    }),
    /clipboard denied/u,
  );
});
