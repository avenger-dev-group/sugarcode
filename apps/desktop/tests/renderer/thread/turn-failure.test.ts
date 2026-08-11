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

test('local persistence failures are not presented as model service failures', () => {
  const failure = toTurnFailureViewModel({
    kind: 'stateUnavailable',
    retryable: true,
  });

  assert.equal(failure.summary, 'SugarCode could not save this Turn safely');
  assert.doesNotMatch(failure.summary, /model service/iu);
  assert.match(failure.guidance, /Restart SugarCode/u);
});

test('repeated tool failures follow the original user language', () => {
  const chinese = toTurnFailureViewModel(
    { kind: 'unsupportedToolArguments', retryable: false },
    'openaiResponses',
    'zh',
  );
  const english = toTurnFailureViewModel(
    { kind: 'unsupportedToolArguments', retryable: false },
    'anthropicMessages',
    'en',
  );

  assert.equal(chinese.summary, '模型重复提交了相同的失败工具调用');
  assert.match(chinese.guidance, /检查工具格式/u);
  assert.equal(english.summary, 'The model repeated the same failing tool call');
  assert.match(english.guidance, /structured-tool compatibility/u);
});

test('protocol failures direct users to the selected wire compatibility', () => {
  const failure = toTurnFailureViewModel({
    kind: 'protocol',
    retryable: false,
  });

  assert.match(failure.guidance, /wire API/);
  assert.match(failure.guidance, /switch model profiles/);
});

test('invalid request guidance is derived from status and wire, not model name', () => {
  const responses = toTurnFailureViewModel(
    { kind: 'invalidRequest', retryable: false },
    'openaiResponses',
  );
  const chat = toTurnFailureViewModel(
    { kind: 'invalidRequest', retryable: false },
    'openaiChatCompletions',
  );

  assert.match(responses.guidance, /model ID/);
  assert.match(responses.guidance, /Compatible Chat/);
  assert.match(chat.guidance, /Base URL/);
  assert.match(chat.guidance, /enabled capabilities/);
});

test('protocol diagnostics expose a specific reason and short safe fingerprint', () => {
  const failure = toTurnFailureViewModel({
    kind: 'protocol',
    retryable: false,
    protocol: {
      stage: 'outputNormalization',
      code: 'ambiguousOutputReconciliation',
      eventType: 'response.completed',
      shapeSha256: 'abcdef0123456789'.padEnd(64, '0'),
    },
  });

  assert.match(failure.summary, /reconciled safely/);
  assert.match(failure.guidance, /stopped instead of guessing/);
  assert.deepEqual(failure.protocol, {
    stage: 'outputNormalization',
    code: 'ambiguousOutputReconciliation',
    eventType: 'response.completed',
    fingerprint: 'abcdef012345',
  });
});
