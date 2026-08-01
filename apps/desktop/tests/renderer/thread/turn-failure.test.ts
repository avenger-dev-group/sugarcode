import assert from 'node:assert/strict';
import test from 'node:test';

import { toTurnFailureViewModel } from '../../../src/renderer/components/thread/turn-failure.ts';

test('output limit failure describes both context and generated output bounds', () => {
  const failure = toTurnFailureViewModel({
    kind: 'outputTooLarge',
    retryable: false,
  });

  assert.equal(
    failure.summary,
    'The conversation exceeded the model context or output limit',
  );
  assert.match(failure.guidance, /larger context window/);
});

test('retryable failures retain retry guidance', () => {
  const failure = toTurnFailureViewModel({
    kind: 'timeout',
    retryable: true,
  });

  assert.equal(failure.guidance, 'You can send another message to retry.');
});
