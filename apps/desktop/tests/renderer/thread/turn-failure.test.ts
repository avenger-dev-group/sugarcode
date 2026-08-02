import assert from 'node:assert/strict';
import test from 'node:test';

import { toTurnFailureViewModel } from '../../../src/renderer/components/thread/turn-failure.ts';

test('context and transport limits have distinct recovery guidance', () => {
  const context = toTurnFailureViewModel({
    kind: 'contextWindowExceeded',
    retryable: false,
  });
  const failure = toTurnFailureViewModel({
    kind: 'outputTooLarge',
    retryable: false,
  });
  const request = toTurnFailureViewModel({
    kind: 'providerRequestTooLarge',
    retryable: false,
  });
  const response = toTurnFailureViewModel({
    kind: 'providerResponseTooLarge',
    retryable: false,
  });

  assert.match(context.summary, /context window/);
  assert.match(context.guidance, /larger context window/);
  assert.match(failure.summary, /visible model or tool output/);
  assert.match(failure.guidance, /visible output/);
  assert.match(request.summary, /request transport size/);
  assert.match(request.guidance, /request-body limit/);
  assert.match(response.summary, /internal response/);
  assert.match(response.guidance, /may still fit the model window/);
});

test('retryable failures retain retry guidance', () => {
  const failure = toTurnFailureViewModel({
    kind: 'timeout',
    retryable: true,
  });

  assert.equal(failure.guidance, 'You can send another message to retry.');
});

test('protocol failures direct users to the selected wire compatibility', () => {
  const failure = toTurnFailureViewModel({
    kind: 'protocol',
    retryable: false,
  });

  assert.match(failure.guidance, /wire API/);
  assert.match(failure.guidance, /switch model profiles/);
});
