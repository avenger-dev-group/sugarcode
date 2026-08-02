import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendPendingAgentOutput,
  type MutableAgentOutput,
  removePendingAgentOutput,
} from '../../../../src/main/app-server/conversation/agent-output-lifecycle.ts';

test('a discarded tool-round preview does not conflict with the next response', () => {
  const pending: MutableAgentOutput[] = [];
  appendPendingAgentOutput(
    pending,
    { responseOrdinal: 1, outputIndex: 0 },
    '\n\n',
  );
  removePendingAgentOutput(pending, {
    responseOrdinal: 1,
    outputIndex: 0,
  });
  appendPendingAgentOutput(
    pending,
    { responseOrdinal: 2, outputIndex: 0 },
    '项目说明',
  );

  assert.deepEqual(pending, [
    { responseOrdinal: 2, outputIndex: 0, text: '项目说明' },
  ]);
});

test('a genuinely concurrent unresolved output remains a protocol failure', () => {
  const pending: MutableAgentOutput[] = [];
  appendPendingAgentOutput(
    pending,
    { responseOrdinal: 1, outputIndex: 0 },
    'first',
  );

  assert.throws(
    () =>
      appendPendingAgentOutput(
        pending,
        { responseOrdinal: 2, outputIndex: 0 },
        'second',
      ),
    /Multiple unresolved Agent outputs/u,
  );
});
